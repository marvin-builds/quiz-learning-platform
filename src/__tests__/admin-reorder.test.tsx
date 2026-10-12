// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Reordering the admin's lists (#84), rendered through the real route tree
// in src/app with expo-router's renderRouter, behind the admin guard: the
// categories (`/admin/categories`), a category's quizzes
// (`/admin/categories/<categoryId>`) and a quiz's questions
// (`/admin/quizzes/<quizId>`). (Answers are reordered in the question form,
// question-form-answer-order.test.tsx.)
//
// - Every row has a "move up" and a "move down" button whose accessible name
//   says the direction and names the row; buttons, so they work with the
//   keyboard and a screen reader, with no drag interaction. The first row's
//   "up" and the last row's "down" are disabled, not hidden; a single row
//   has both disabled.
// - One move is one database call: reorder_categories(category_ids),
//   reorder_quizzes(category_id, quiz_ids) or reorder_questions(quiz_id,
//   question_ids) with the full list of the parent's ids in the new order.
//   No table write is sent. The list then shows the new order without a
//   manual reload, read from the server again.
// - A refused call (P0001 'not available', e.g. a stale list after a second
//   tab added a row) or a failed one shows a translated error and the list
//   shows the server's order again, never the order that wasn't saved.
// Focus after a move is checked in the browser (e2e/flow-b.spec.ts).
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack does to the seed admin: `from('categories' | 'quizzes' |
// 'questions')` are in-memory tables with the database's rules (reads apply
// `eq`/`in` filters and `order`, and the rows are stored out of order on
// purpose; sort_order has no column grant, so a write of it is 42501), and
// the reorder functions keep the full-list contract
// (reorder_*.test.sql): anything but exactly the parent's current ids, each
// once, or a caller who isn't an admin, gets 'not available' and changes
// nothing. `mockServer['rpc.<function>']` fails or holds a request. Every
// request is recorded in `mockCalls`.

// The language the screens currently show.
const shown = (): 'de' | 'en' => (i18n.language === 'en' ? 'en' : 'de');

// Reads a text from de.json or en.json by path (by default in the language
// shown), so keys that don't exist yet fail at run time with their name
// instead of breaking the typecheck.
function text(key: string, lng: 'de' | 'en' = shown()): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      lng === 'de' ? de : en,
    );
  if (typeof value !== 'string') throw new Error(`${lng}.json has no text for ${key}`);
  return value;
}

// A text with its placeholders filled in, through i18next, so it reads like
// the screen's `t(key, { name })`. Checks the key exists first.
function label(key: string, values: Record<string, string> = {}, lng: 'de' | 'en' = shown()) {
  text(key, lng);
  return (i18n.t as (key: string, options: object) => string)(key, { ...values, lng });
}

type User = {
  id: string;
  email?: string;
  is_anonymous: boolean;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
};
type Session = { access_token: string; refresh_token: string; user: User };
type PostgrestError = { message: string; code: string; details?: string; hint?: string };
type Row = Record<string, unknown> & { id: string };
type Category = Row & {
  name: string;
  description: string | null;
  sort_order: number;
  published: boolean;
  created_at: string;
};
type Quiz = Row & {
  category_id: string;
  title: string;
  description: string | null;
  sort_order: number;
  published: boolean;
  created_at: string;
};
type Question = Row & {
  quiz_id: string;
  text: string;
  image_path: string | null;
  image_alt: string | null;
  multiple_correct: boolean;
  explanation: string | null;
  sort_order: number;
  created_at: string;
};
type Table = 'categories' | 'quizzes' | 'questions';
type Operation = 'select' | 'insert' | 'update' | 'delete' | 'rpc';
type Filter = [string, 'eq' | 'in', unknown];
type Query = {
  table: string;
  operation: Operation;
  columns?: string;
  values?: unknown;
  filters: Filter[];
  orders: [string, { ascending?: boolean } | undefined][];
  returning: string | null;
};
type Call = {
  table: string;
  operation: Operation;
  columns?: string;
  values?: unknown;
  filters: Filter[];
  returning: string | null;
};
type Listener = (event: string, session: Session | null) => void;
type ServerState = 'ok' | 'pending' | { error: PostgrestError };

const ADMIN: User = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};
const LEARNER: User = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  email: 'learner@example.com',
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};

// What the column grants let the admin write (#80, #81); anything else is 42501.
const WRITABLE: Record<Table, { insert: string[]; update: string[] }> = {
  categories: {
    insert: ['name', 'description', 'published'],
    update: ['name', 'description', 'published'],
  },
  quizzes: {
    insert: ['category_id', 'title', 'description', 'published'],
    update: ['title', 'description', 'published'],
  },
  questions: {
    insert: ['quiz_id', 'text', 'explanation', 'multiple_correct'],
    update: ['text', 'explanation', 'multiple_correct'],
  },
};
// The column the database requires to be non-blank, per table.
const REQUIRED: Record<Table, string> = { categories: 'name', quizzes: 'title', questions: 'text' };
// The parent column whose rows share a sort_order sequence.
const PARENT: Record<Table, string | null> = {
  categories: null,
  quizzes: 'category_id',
  questions: 'quiz_id',
};

const NETWORK_ERROR: PostgrestError = { message: 'TypeError: Failed to fetch', code: '' };

const mockAuth = {
  session: null as Session | null,
  listeners: new Set<Listener>(),
};
const mockProfiles: Record<string, 'learner' | 'admin'> = {};
const mockTables: { categories: Category[]; quizzes: Quiz[]; questions: Question[] } = {
  categories: [],
  quizzes: [],
  questions: [],
};
// Keyed `<table>.<operation>`, e.g. `quizzes.update` or `rpc.admin_question`.
const mockServer: Record<string, ServerState> = {};
const mockHeld: (() => void)[] = [];
const mockCalls: Call[] = [];
let mockNextId = 1;

function mockError(code: string, message: string) {
  return { data: null, error: { message, code } };
}

function mockIsBlank(value: unknown) {
  return typeof value !== 'string' || value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') === '';
}

function mockMatches(row: Record<string, unknown>, filters: Filter[]) {
  return filters.every(([column, op, value]) =>
    op === 'in' ? (value as unknown[]).includes(row[column]) : row[column] === value,
  );
}

// Column lists as PostgREST reads them: `*` or names (aliases and embeds
// aside). True when one of them is questions.explanation.
function mockNamesSolution(table: string, columns: string | null | undefined) {
  if (table !== 'questions' || columns == null) return false;
  return columns
    .split(',')
    .map((column) => column.trim().split(':').pop()?.trim())
    .some((column) => column === '*' || column === 'explanation');
}

// A row as a role without select on questions.explanation gets it.
function mockVisible(table: string, row: Row) {
  if (table !== 'questions') return { ...row };
  const { explanation: _hidden, ...rest } = row as Question;
  return rest;
}

function mockApply(query: Query): { data: unknown; error: PostgrestError | null } {
  const table = query.table as Table;
  const rows = mockTables[table] as Row[];
  const admin = mockAuth.session ? mockProfiles[mockAuth.session.user.id] === 'admin' : false;

  // No select on questions.explanation for any role, admins included: not
  // as a column, not through `*`, not in a filter, not as a write's return.
  if (
    mockNamesSolution(table, query.columns) ||
    mockNamesSolution(table, query.returning) ||
    (table === 'questions' &&
      [...query.filters.map(([c]) => c), ...query.orders.map(([c]) => c)].includes('explanation'))
  ) {
    return mockError('42501', `permission denied for table ${table}`);
  }

  if (query.operation === 'select') {
    const found = rows.filter((row) => mockMatches(row, query.filters));
    for (const [column, options] of [...query.orders].reverse()) {
      const direction = options?.ascending === false ? -1 : 1;
      found.sort((a, b) => {
        const left = a[column] as number | string;
        const right = b[column] as number | string;
        return left < right ? -direction : left > right ? direction : 0;
      });
    }
    return { data: found.map((row) => mockVisible(table, row)), error: null };
  }

  if (query.operation === 'insert') {
    if (!admin) {
      return mockError('42501', `new row violates row-level security policy for table "${table}"`);
    }
    const inserted: Row[] = [];
    const list = (Array.isArray(query.values) ? query.values : [query.values]) as Record<
      string,
      unknown
    >[];
    for (const values of list) {
      if (Object.keys(values).some((column) => !WRITABLE[table].insert.includes(column))) {
        return mockError('42501', `permission denied for table ${table}`);
      }
      if (mockIsBlank(values[REQUIRED[table]])) {
        return mockError('23514', `${table}_${REQUIRED[table]}_check`);
      }
      const parent = PARENT[table];
      if (parent === 'category_id' && !mockTables.categories.some((c) => c.id === values[parent])) {
        return mockError('23503', 'quizzes_category_id_fkey');
      }
      if (parent === 'quiz_id' && !mockTables.quizzes.some((q) => q.id === values[parent])) {
        return mockError('23503', 'questions_quiz_id_fkey');
      }
      const siblings = parent ? rows.filter((row) => row[parent] === values[parent]) : rows;
      const defaults: Record<string, unknown> =
        table === 'questions'
          ? { explanation: null, multiple_correct: false, image_path: null, image_alt: null }
          : { description: null, published: false };
      const row: Row = {
        id: `90000000-0000-4000-8000-${String(mockNextId++).padStart(12, '0')}`,
        ...defaults,
        ...values,
        sort_order: Math.max(0, ...siblings.map((sibling) => sibling.sort_order as number)) + 1,
        created_at: '2026-10-12T00:00:00Z',
      };
      rows.push(row);
      inserted.push(row);
    }
    return {
      data: query.returning !== null ? inserted.map((row) => mockVisible(table, row)) : null,
      error: null,
    };
  }

  if (query.operation === 'update') {
    const values = query.values as Record<string, unknown>;
    if (Object.keys(values).some((column) => !WRITABLE[table].update.includes(column))) {
      return mockError('42501', `permission denied for table ${table}`);
    }
    if (REQUIRED[table] in values && mockIsBlank(values[REQUIRED[table]])) {
      return mockError('23514', `${table}_${REQUIRED[table]}_check`);
    }
    // RLS: a non-admin's update touches no row, without an error.
    const found = admin ? rows.filter((row) => mockMatches(row, query.filters)) : [];
    for (const row of found) Object.assign(row, values);
    return {
      data: query.returning !== null ? found.map((row) => mockVisible(table, row)) : null,
      error: null,
    };
  }

  const removed = admin ? rows.filter((row) => mockMatches(row, query.filters)) : [];
  for (const row of removed) rows.splice(rows.indexOf(row), 1);
  // Foreign-key cascades.
  const ids = removed.map((row) => row.id);
  if (table === 'categories') {
    for (const quiz of mockTables.quizzes.filter((q) => ids.includes(q.category_id))) {
      mockTables.quizzes.splice(mockTables.quizzes.indexOf(quiz), 1);
    }
  }
  if (table === 'quizzes') {
    for (const question of mockTables.questions.filter((q) => ids.includes(q.quiz_id))) {
      mockTables.questions.splice(mockTables.questions.indexOf(question), 1);
    }
  }
  return {
    data: query.returning !== null ? removed.map((row) => mockVisible(table, row)) : null,
    error: null,
  };
}

// public.admin_question(question_id): the admin's read of one question with
// its explanation; anyone else gets 'not available'. An unknown id: no row.
function mockAdminQuestion(args: Record<string, unknown>): {
  data: unknown;
  error: PostgrestError | null;
} {
  const admin = mockAuth.session ? mockProfiles[mockAuth.session.user.id] === 'admin' : false;
  if (!admin) return mockError('P0001', 'not available');
  const question = mockTables.questions.find((row) => row.id === args.question_id);
  return {
    data: question
      ? [
          {
            id: question.id,
            quiz_id: question.quiz_id,
            text: question.text,
            explanation: question.explanation,
            multiple_correct: question.multiple_correct,
          },
        ]
      : [],
    error: null,
  };
}

// The reorder functions: the table, the parent column and the argument
// names of each.
const REORDERS: Record<
  string,
  { table: Table; parent: string | null; parentArg: string | null; idsArg: string }
> = {
  reorder_categories: {
    table: 'categories',
    parent: null,
    parentArg: null,
    idsArg: 'category_ids',
  },
  reorder_quizzes: {
    table: 'quizzes',
    parent: 'category_id',
    parentArg: 'category_id',
    idsArg: 'quiz_ids',
  },
  reorder_questions: {
    table: 'questions',
    parent: 'quiz_id',
    parentArg: 'quiz_id',
    idsArg: 'question_ids',
  },
};

// A reorder as the database does it: admins only, exactly the parent's
// current ids, each once; then sort_order 1..n in the list's order.
function mockReorder(
  reorder: (typeof REORDERS)[string],
  args: Record<string, unknown>,
): { data: unknown; error: PostgrestError | null } {
  const admin = mockAuth.session ? mockProfiles[mockAuth.session.user.id] === 'admin' : false;
  if (!admin) return mockError('P0001', 'not available');
  const rows = mockTables[reorder.table] as Row[];
  const parentId = reorder.parentArg ? args[reorder.parentArg] : null;
  const parentTable = reorder.table === 'quizzes' ? 'categories' : 'quizzes';
  if (reorder.parent && !(mockTables[parentTable] as Row[]).some((row) => row.id === parentId)) {
    return mockError('P0001', 'not available');
  }
  const siblings = reorder.parent ? rows.filter((row) => row[reorder.parent!] === parentId) : rows;
  const ids = args[reorder.idsArg];
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length !== siblings.length ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => siblings.some((row) => row.id === id))
  ) {
    return mockError('P0001', 'not available');
  }
  ids.forEach((id, index) => {
    const row = siblings.find((sibling) => sibling.id === id)!;
    row.sort_order = index + 1;
  });
  return { data: null, error: null };
}

async function mockRun(query: Query, mode: 'many' | 'maybeSingle' | 'single') {
  let result: { data: unknown; error: PostgrestError | null };
  if (query.table === 'profiles') {
    const user = mockAuth.session?.user;
    const role = user ? mockProfiles[user.id] : undefined;
    const rows = user && role ? [{ id: user.id, role, display_name: null }] : [];
    result = { data: rows, error: null };
  } else if (query.operation === 'rpc' || query.table in mockTables) {
    mockCalls.push({
      table: query.table,
      operation: query.operation,
      columns: query.columns,
      values: query.values,
      filters: query.filters,
      returning: query.returning,
    });
    const key =
      query.operation === 'rpc' ? `rpc.${query.table}` : `${query.table}.${query.operation}`;
    const state = mockServer[key] ?? 'ok';
    if (state === 'pending') await new Promise<void>((resolve) => mockHeld.push(resolve));
    else if (state !== 'ok') return { data: null, error: state.error };
    if (query.operation === 'rpc') {
      const args = (query.values ?? {}) as Record<string, unknown>;
      result =
        query.table === 'admin_question'
          ? mockAdminQuestion(args)
          : query.table in REORDERS
            ? mockReorder(REORDERS[query.table], args)
            : mockError('PGRST202', `Could not find the function public.${query.table}`);
    } else {
      result = mockApply(query);
    }
  } else {
    result = { data: [], error: null };
  }

  if (result.error || mode === 'many') return result;
  const rows = (result.data ?? []) as unknown[];
  if (rows.length === 1) return { data: rows[0], error: null };
  if (mode === 'maybeSingle' && rows.length === 0) return { data: null, error: null };
  return {
    data: null,
    error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
  };
}

function mockQueryBuilder(table: string, operation: Operation = 'select', values?: unknown) {
  const query: Query = {
    table,
    operation,
    values,
    filters: [],
    orders: [],
    returning: null,
  };
  const builder = {
    select(columns = '*') {
      if (query.operation === 'select') query.columns = columns;
      else query.returning = columns;
      return builder;
    },
    insert(values: unknown) {
      query.operation = 'insert';
      query.values = values;
      return builder;
    },
    update(values: unknown) {
      query.operation = 'update';
      query.values = values;
      return builder;
    },
    delete() {
      query.operation = 'delete';
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, 'eq', value]);
      return builder;
    },
    in(column: string, values: unknown[]) {
      query.filters.push([column, 'in', values]);
      return builder;
    },
    match(values: Record<string, unknown>) {
      for (const [column, value] of Object.entries(values)) {
        query.filters.push([column, 'eq', value]);
      }
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      query.orders.push([column, options]);
      return builder;
    },
    limit() {
      return builder;
    },
    abortSignal() {
      return builder;
    },
    maybeSingle() {
      return mockRun(query, 'maybeSingle');
    },
    single() {
      return mockRun(query, 'single');
    },
    then<T>(onFulfilled: (value: unknown) => T, onRejected?: (reason: unknown) => T) {
      return mockRun(query, 'many').then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const mockSupabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: mockAuth.session }, error: null }),
    getUser: () => Promise.resolve({ data: { user: mockAuth.session?.user ?? null }, error: null }),
    onAuthStateChange: (listener: Listener) => {
      mockAuth.listeners.add(listener);
      void Promise.resolve().then(() => listener('INITIAL_SESSION', mockAuth.session));
      return {
        data: { subscription: { unsubscribe: () => mockAuth.listeners.delete(listener) } },
      };
    },
    signOut: () => {
      mockAuth.session = null;
      for (const listener of mockAuth.listeners) listener('SIGNED_OUT', null);
      return Promise.resolve({ error: null });
    },
  },
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    get auth() {
      return mockSupabase.auth;
    },
    from: (table: string) => mockQueryBuilder(table),
    rpc: (fn: string, args?: Record<string, unknown>) => mockQueryBuilder(fn, 'rpc', args),
  },
}));

// The root layout imports the NativeWind stylesheet, which Jest can't load.
jest.mock('../../global.css', () => ({}));

function sessionOf(user: User): Session {
  return { access_token: `token-${user.id}`, refresh_token: `refresh-${user.id}`, user };
}

// Lets pending promises, timers and the re-renders they cause settle.
// renderRouter switches Jest to fake timers, so they are run, not waited for.
const flush = () =>
  act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });

async function renderAt(url: string): Promise<{ getPathname(): string }> {
  const result = renderRouter('src/app', { initialUrl: url });
  await result;
  return { getPathname: () => result.getPathname() };
}

function resetFake() {
  mockAuth.session = sessionOf(ADMIN);
  mockAuth.listeners.clear();
  for (const id of Object.keys(mockProfiles)) delete mockProfiles[id];
  mockProfiles[ADMIN.id] = 'admin';
  mockProfiles[LEARNER.id] = 'learner';
  for (const key of Object.keys(mockServer)) delete mockServer[key];
  mockHeld.length = 0;
  mockCalls.length = 0;
  mockNextId = 1;
}

// Fixtures ------------------------------------------------------------------

const AT = '2026-10-01T00:00:00Z';

const GEOGRAFIE: Category = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Geografie',
  description: null,
  sort_order: 1,
  published: true,
  created_at: AT,
};
const GESCHICHTE: Category = {
  id: '10000000-0000-4000-8000-000000000002',
  name: 'Geschichte',
  description: null,
  sort_order: 2,
  published: true,
  created_at: AT,
};
const MUSIK: Category = {
  id: '10000000-0000-4000-8000-000000000003',
  name: 'Musik',
  description: null,
  sort_order: 3,
  published: false,
  created_at: AT,
};

const quiz = (id: string, category: Category, title: string, sort_order: number): Quiz => ({
  id,
  category_id: category.id,
  title,
  description: null,
  sort_order,
  published: false,
  created_at: AT,
});
const HAUPTSTAEDTE = quiz('20000000-0000-4000-8000-000000000001', GEOGRAFIE, 'Hauptstädte', 1);
const FLUESSE = quiz('20000000-0000-4000-8000-000000000002', GEOGRAFIE, 'Flüsse', 2);
const GEBIRGE = quiz('20000000-0000-4000-8000-000000000003', GEOGRAFIE, 'Gebirge', 3);
// The only quiz of its category.
const KOMPONISTEN = quiz('20000000-0000-4000-8000-000000000004', MUSIK, 'Komponisten', 1);

const question = (id: string, of: Quiz, text: string, sort_order: number): Question => ({
  id,
  quiz_id: of.id,
  text,
  image_path: null,
  image_alt: null,
  multiple_correct: false,
  explanation: null,
  sort_order,
  created_at: AT,
});
const FRANKREICH = question(
  '30000000-0000-4000-8000-000000000001',
  HAUPTSTAEDTE,
  'Hauptstadt von Frankreich?',
  1,
);
const ITALIEN = question(
  '30000000-0000-4000-8000-000000000002',
  HAUPTSTAEDTE,
  'Hauptstadt von Italien?',
  2,
);
const SPANIEN = question(
  '30000000-0000-4000-8000-000000000003',
  HAUPTSTAEDTE,
  'Hauptstadt von Spanien?',
  3,
);
// The only question of its quiz.
const ZUGSPITZE = question(
  '30000000-0000-4000-8000-000000000004',
  GEBIRGE,
  'Wie hoch ist die Zugspitze?',
  1,
);

// One list under test: where it is, its rows and how a reorder is sent.
type List = {
  what: string;
  table: Table;
  rpc: string;
  keys: 'admin.categories' | 'admin.quizzes' | 'admin.questions';
  url: string;
  names: [string, string, string];
  ids: [string, string, string];
  // The call's arguments for ids in this order.
  args: (ids: string[]) => Record<string, unknown>;
  single: { url: string; name: string };
  // A row of the same parent that another tab added after the list loaded.
  added: () => Row & { name?: string; title?: string; text?: string };
  addedName: string;
};

const LISTS: List[] = [
  {
    what: 'categories (/admin/categories)',
    table: 'categories',
    rpc: 'reorder_categories',
    keys: 'admin.categories',
    url: '/admin/categories',
    names: ['Geografie', 'Geschichte', 'Musik'],
    ids: [GEOGRAFIE.id, GESCHICHTE.id, MUSIK.id],
    args: (ids) => ({ category_ids: ids }),
    single: { url: '/admin/categories', name: 'Geografie' },
    added: () => ({
      ...GESCHICHTE,
      id: '10000000-0000-4000-8000-000000000009',
      name: 'Kunst',
      sort_order: 4,
    }),
    addedName: 'Kunst',
  },
  {
    what: 'quizzes (/admin/categories/<categoryId>)',
    table: 'quizzes',
    rpc: 'reorder_quizzes',
    keys: 'admin.quizzes',
    url: `/admin/categories/${GEOGRAFIE.id}`,
    names: ['Hauptstädte', 'Flüsse', 'Gebirge'],
    ids: [HAUPTSTAEDTE.id, FLUESSE.id, GEBIRGE.id],
    args: (ids) => ({ category_id: GEOGRAFIE.id, quiz_ids: ids }),
    single: { url: `/admin/categories/${MUSIK.id}`, name: 'Komponisten' },
    added: () => ({
      ...FLUESSE,
      id: '20000000-0000-4000-8000-000000000009',
      title: 'Wüsten',
      sort_order: 4,
    }),
    addedName: 'Wüsten',
  },
  {
    what: 'questions (/admin/quizzes/<quizId>)',
    table: 'questions',
    rpc: 'reorder_questions',
    keys: 'admin.questions',
    url: `/admin/quizzes/${HAUPTSTAEDTE.id}`,
    names: ['Hauptstadt von Frankreich?', 'Hauptstadt von Italien?', 'Hauptstadt von Spanien?'],
    ids: [FRANKREICH.id, ITALIEN.id, SPANIEN.id],
    args: (ids) => ({ quiz_id: HAUPTSTAEDTE.id, question_ids: ids }),
    single: { url: `/admin/quizzes/${GEBIRGE.id}`, name: 'Wie hoch ist die Zugspitze?' },
    added: () => ({
      ...ITALIEN,
      id: '30000000-0000-4000-8000-000000000009',
      text: 'Hauptstadt von Polen?',
      sort_order: 4,
    }),
    addedName: 'Hauptstadt von Polen?',
  },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The rows' names on the list, top to bottom (exact texts only, so the
// buttons that repeat a name don't count).
function listed(names: string[]): string[] {
  const pattern = new RegExp(`^(${names.map(escape).join('|')})$`);
  return screen.getAllByText(pattern).map((element) => String(element.props.children));
}

const moveUp = (list: List, name: string, lng?: 'de' | 'en') =>
  screen.getByRole('button', { name: label(`${list.keys}.actions.moveUp`, { name }, lng) });
const moveDown = (list: List, name: string, lng?: 'de' | 'en') =>
  screen.getByRole('button', { name: label(`${list.keys}.actions.moveDown`, { name }, lng) });

const rpcCalls = (fn: string) =>
  mockCalls.filter((call) => call.operation === 'rpc' && call.table === fn);

// Writes to any content table: a reorder must not send one.
const tableWrites = () =>
  mockCalls.filter((call) => ['insert', 'update', 'delete'].includes(call.operation));

// Reads of `table` sent after the last call of `fn`.
function readsAfterRpc(table: string, fn: string): number {
  const last = mockCalls.map((call) => call.table).lastIndexOf(fn);
  return mockCalls
    .slice(last + 1)
    .filter((call) => call.table === table && call.operation === 'select').length;
}

beforeEach(async () => {
  resetFake();
  // Out of sort_order on purpose: the screens have to ask for the order.
  mockTables.categories.length = 0;
  mockTables.categories.push(...[MUSIK, GEOGRAFIE, GESCHICHTE].map((row) => ({ ...row })));
  mockTables.quizzes.length = 0;
  mockTables.quizzes.push(
    ...[GEBIRGE, KOMPONISTEN, HAUPTSTAEDTE, FLUESSE].map((row) => ({ ...row })),
  );
  mockTables.questions.length = 0;
  mockTables.questions.push(
    ...[SPANIEN, ZUGSPITZE, FRANKREICH, ITALIEN].map((row) => ({ ...row })),
  );
  await i18n.changeLanguage('de');
});

describe.each(LISTS)('reordering $what', (list) => {
  async function open() {
    await renderAt(list.url);
    await screen.findByText(list.names[2]);
  }

  it('has German and English texts for the move buttons and the error', () => {
    for (const key of [
      `${list.keys}.actions.moveUp`,
      `${list.keys}.actions.moveDown`,
      `${list.keys}.errors.reorder`,
    ]) {
      expect(text(key, 'de')).toMatch(/\S/);
      expect(text(key, 'en')).toMatch(/\S/);
    }
  });

  it('names the row and the direction in each move button, in German and English', () => {
    for (const lng of ['de', 'en'] as const) {
      const up = label(`${list.keys}.actions.moveUp`, { name: 'Komponisten' }, lng);
      const down = label(`${list.keys}.actions.moveDown`, { name: 'Komponisten' }, lng);
      expect(up).toContain('Komponisten');
      expect(down).toContain('Komponisten');
      expect(up).not.toBe(down);
    }
  });

  it('gives every row a move-up and a move-down button', async () => {
    await open();

    for (const name of list.names) {
      expect(moveUp(list, name)).toBeOnTheScreen();
      expect(moveDown(list, name)).toBeOnTheScreen();
    }
  });

  it('disables the first row’s move-up and the last row’s move-down, without hiding them', async () => {
    await open();

    expect(moveUp(list, list.names[0])).toBeDisabled();
    expect(moveDown(list, list.names[0])).toBeEnabled();
    expect(moveUp(list, list.names[1])).toBeEnabled();
    expect(moveDown(list, list.names[1])).toBeEnabled();
    expect(moveUp(list, list.names[2])).toBeEnabled();
    expect(moveDown(list, list.names[2])).toBeDisabled();
  });

  it('disables both move buttons of a single row', async () => {
    if (list.table === 'categories') {
      mockTables.categories.splice(0, mockTables.categories.length, { ...GEOGRAFIE });
    }
    await renderAt(list.single.url);
    await screen.findByText(list.single.name);

    expect(moveUp(list, list.single.name)).toBeDisabled();
    expect(moveDown(list, list.single.name)).toBeDisabled();
  });

  it('sends one reorder call with the full list in the new order and no table write', async () => {
    await open();
    mockCalls.length = 0;

    await fireEvent.press(moveDown(list, list.names[0]));
    await flush();

    expect(rpcCalls(list.rpc)).toHaveLength(1);
    expect(rpcCalls(list.rpc)[0].values).toEqual(
      list.args([list.ids[1], list.ids[0], list.ids[2]]),
    );
    expect(tableWrites()).toEqual([]);
  });

  it('shows the new order without a reload, read from the server again', async () => {
    await open();

    await fireEvent.press(moveDown(list, list.names[0]));
    await flush();

    expect(listed(list.names)).toEqual([list.names[1], list.names[0], list.names[2]]);
    expect(readsAfterRpc(list.table, list.rpc)).toBeGreaterThan(0);
    // The moved row's buttons follow it: now in the middle, both enabled.
    expect(moveUp(list, list.names[0])).toBeEnabled();
    expect(moveDown(list, list.names[0])).toBeEnabled();
    expect(moveUp(list, list.names[1])).toBeDisabled();
  });

  it('moves the last row up', async () => {
    await open();
    mockCalls.length = 0;

    await fireEvent.press(moveUp(list, list.names[2]));
    await flush();

    expect(rpcCalls(list.rpc)[0].values).toEqual(
      list.args([list.ids[0], list.ids[2], list.ids[1]]),
    );
    expect(listed(list.names)).toEqual([list.names[0], list.names[2], list.names[1]]);
    expect(moveDown(list, list.names[2])).toBeEnabled();
    expect(moveDown(list, list.names[1])).toBeDisabled();
  });

  it('moves twice in a row from the order the first move saved', async () => {
    await open();
    mockCalls.length = 0;

    await fireEvent.press(moveDown(list, list.names[0]));
    await flush();
    await fireEvent.press(moveDown(list, list.names[0]));
    await flush();

    expect(rpcCalls(list.rpc).map((call) => call.values)).toEqual([
      list.args([list.ids[1], list.ids[0], list.ids[2]]),
      list.args([list.ids[1], list.ids[2], list.ids[0]]),
    ]);
    expect(listed(list.names)).toEqual([list.names[1], list.names[2], list.names[0]]);
  });

  it('shows a translated error and the server’s order when the reorder is refused', async () => {
    await open();
    // Another tab added a row: the list on screen is stale, so the database
    // refuses it.
    (mockTables[list.table] as Row[]).push(list.added());

    await fireEvent.press(moveDown(list, list.names[0]));
    await flush();

    expect(await screen.findByText(text(`${list.keys}.errors.reorder`))).toBeOnTheScreen();
    await waitFor(() =>
      expect(listed([...list.names, list.addedName])).toEqual([...list.names, list.addedName]),
    );
  });

  it('shows a translated error and keeps the old order when the reorder fails in transport', async () => {
    await open();
    mockServer[`rpc.${list.rpc}`] = { error: NETWORK_ERROR };

    await fireEvent.press(moveDown(list, list.names[0]));
    await flush();

    expect(await screen.findByText(text(`${list.keys}.errors.reorder`))).toBeOnTheScreen();
    expect(listed(list.names)).toEqual(list.names);
    expect(moveUp(list, list.names[0])).toBeDisabled();
  });

  it('shows the error in English when the app is in English', async () => {
    await i18n.changeLanguage('en');
    await open();
    mockServer[`rpc.${list.rpc}`] = { error: NETWORK_ERROR };

    await fireEvent.press(moveDown(list, list.names[0], 'en'));
    await flush();

    expect(await screen.findByText(text(`${list.keys}.errors.reorder`, 'en'))).toBeOnTheScreen();
  });

  it('offers no drag interaction: no long-press or pan handlers on the list', async () => {
    await open();

    const draggable = screen.container.queryAll(
      (node) =>
        typeof node.type === 'string' &&
        // A PanResponder (drag) claims moves; every Pressable handles
        // onResponderMove, so that one says nothing.
        (node.props.onLongPress !== undefined ||
          node.props.onMoveShouldSetResponder !== undefined ||
          node.props.onMoveShouldSetResponderCapture !== undefined),
    );
    expect(draggable).toEqual([]);
    // Positive control: the move buttons exist, so the list rendered.
    expect(moveDown(list, list.names[0])).toBeOnTheScreen();
  });
});
