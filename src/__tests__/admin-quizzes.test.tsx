// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter, testRouter } from 'expo-router/testing-library';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// The admin's quiz screens (#81), rendered through the real route tree in
// src/app with expo-router's renderRouter, behind the admin guard:
// - `/admin/categories/<categoryId>`: the category's quizzes by sort_order,
//   unpublished ones included, each with its published state, a link to its
//   questions, an edit link, a publish/unpublish action and a delete action
//   with an in-app confirmation; with loading, empty, error-with-retry and
//   not-found states. The category list links each category here.
// - `/admin/categories/<categoryId>/quizzes/new` and
//   `/admin/quizzes/<quizId>/edit`: the create and edit form (title,
//   description, published), with loading, error-with-retry and not-found
//   states, a pending state while saving and an error that keeps the input.
// (The category edit form moved to `/admin/categories/<id>/edit`.)
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack does to the seed admin: `from('categories' | 'quizzes' |
// 'questions')` are in-memory tables with the database's rules (reads apply
// `eq`/`in` filters and `order`, and the rows are stored out of order on
// purpose; inserts and updates may only write the columns the grants allow,
// anything else is 42501; a blank title is 23514; an insert gets the next
// sort_order within its parent; deleting a quiz deletes its questions).
// `mockServer['<table>.<operation>']` fails or holds a request. Every request
// is recorded in `mockCalls`.

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

function mockRelease() {
  for (const release of mockHeld.splice(0)) release();
}

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
      result =
        query.table === 'admin_question'
          ? mockAdminQuestion((query.values ?? {}) as Record<string, unknown>)
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

// An action, link, switch or checkbox by its accessible name. The role is
// part of the contract: a screen reader announces what it is.
const ACTION = /^(button|link|switch|checkbox)$/;

function control(name: string) {
  return screen.getByRole(ACTION, { name });
}

async function findControl(name: string) {
  return screen.findByRole(ACTION, { name });
}

// The delete confirmation: a host view with role alertdialog or dialog. Found
// by its role prop rather than getByRole, which only sees `accessible`
// elements.
function queryDialog(): TestInstance | null {
  const [dialog] = screen.container.queryAll(
    (node) =>
      typeof node.type === 'string' &&
      /^(alertdialog|dialog)$/.test(String(node.props.role ?? node.props.accessibilityRole ?? '')),
  );
  return dialog ?? null;
}

function findDialog(): Promise<TestInstance> {
  return waitFor(() => {
    const dialog = queryDialog();
    if (!dialog) throw new Error('No element with role alertdialog or dialog');
    return dialog;
  });
}

function isChecked(element: TestInstance): boolean | undefined {
  const props = element.props as Record<string, unknown>;
  const state = props.accessibilityState as { checked?: boolean } | undefined;
  return (
    (props['aria-checked'] as boolean | undefined) ?? state?.checked ?? (props.value as boolean)
  );
}

// A Switch takes valueChange, a checkbox-like Pressable a press.
async function setChecked(find: () => TestInstance, target: boolean) {
  if (isChecked(find()) === target) return;
  await fireEvent(find(), 'valueChange', target);
  if (isChecked(find()) !== target) await fireEvent.press(find());
  expect(isChecked(find())).toBe(target);
}

const callsOf = (table: string, operation: Operation) =>
  mockCalls.filter((call) => call.table === table && call.operation === operation);

// The values of a write, as one object (an insert may send an array).
function written(call: Call): Record<string, unknown> {
  return (Array.isArray(call.values) ? call.values[0] : call.values) as Record<string, unknown>;
}

// Reads of `table` sent after the last `operation` on it: a successful write
// has to refetch from the server rather than only patch the cache.
function readsAfterLast(table: string, operation: Operation): number {
  const ofTable = mockCalls.filter((call) => call.table === table);
  const last = ofTable.map((call) => call.operation).lastIndexOf(operation);
  return ofTable.slice(last + 1).filter((call) => call.operation === 'select').length;
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

const GEOGRAFIE: Category = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Geografie',
  description: 'Länder, Städte und Flüsse',
  sort_order: 1,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
const GESCHICHTE: Category = {
  id: '10000000-0000-4000-8000-000000000003',
  name: 'Geschichte',
  description: null,
  sort_order: 2,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
const MUSIK: Category = {
  id: '10000000-0000-4000-8000-000000000004',
  name: 'Musik',
  description: 'Komponisten und Instrumente',
  sort_order: 3,
  published: false,
  created_at: '2026-10-01T00:00:00Z',
};

const HAUPTSTAEDTE: Quiz = {
  id: '20000000-0000-4000-8000-000000000001',
  category_id: GEOGRAFIE.id,
  title: 'Hauptstädte Europas',
  description: 'Kennst du die Hauptstädte unserer Nachbarn?',
  sort_order: 1,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
const FLUESSE: Quiz = {
  id: '20000000-0000-4000-8000-000000000002',
  category_id: GEOGRAFIE.id,
  title: 'Flüsse in Deutschland',
  description: 'Noch in Arbeit',
  sort_order: 2,
  published: false,
  created_at: '2026-10-01T00:00:00Z',
};
const GEBIRGE: Quiz = {
  id: '20000000-0000-4000-8000-000000000005',
  category_id: GEOGRAFIE.id,
  title: 'Gebirge der Welt',
  description: null,
  sort_order: 3,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
// In another category: never on Geografie's list.
const KOMPONISTEN: Quiz = {
  id: '20000000-0000-4000-8000-000000000004',
  category_id: MUSIK.id,
  title: 'Komponisten',
  description: 'Wer hat was geschrieben?',
  sort_order: 1,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
const FRANCE: Question = {
  id: '30000000-0000-4000-8000-000000000001',
  quiz_id: HAUPTSTAEDTE.id,
  text: 'Was ist die Hauptstadt von Frankreich?',
  image_path: null,
  image_alt: null,
  multiple_correct: false,
  explanation: 'Paris ist seit dem Mittelalter die Hauptstadt Frankreichs.',
  sort_order: 1,
  created_at: '2026-10-01T00:00:00Z',
};

const TITLES =
  /^(Hauptstädte Europas|Flüsse in Deutschland|Gebirge der Welt|Komponisten|Wüsten der Welt)$/;
const UNKNOWN_ID = '10000000-0000-4000-8000-0000000000ff';
const UNKNOWN_QUIZ = '20000000-0000-4000-8000-0000000000ff';

// The quiz titles on the list, top to bottom.
function listedTitles(): string[] {
  return screen.getAllByText(TITLES).map((element) => String(element.props.children));
}

const listUrl = (category: Category) => `/admin/categories/${category.id}`;
const newUrl = (category: Category) => `/admin/categories/${category.id}/quizzes/new`;
const editUrl = (quiz: Quiz) => `/admin/quizzes/${quiz.id}/edit`;
const listHeading = (category: Category, lng: 'de' | 'en' = shown()) =>
  label('admin.quizzes.title', { name: category.name }, lng);

const titleField = () => screen.getByLabelText(text('admin.quizzes.form.title'));
const descriptionField = () => screen.getByLabelText(text('admin.quizzes.form.description'));
const publishedControl = () =>
  screen.getByRole(/^(switch|checkbox)$/, { name: text('admin.quizzes.form.published') });
const saveButton = () =>
  screen.queryByRole('button', { name: text('admin.quizzes.form.save') }) ??
  screen.getByRole('button', { name: text('admin.quizzes.form.saving') });

async function fillForm(values: { title?: string; description?: string; published?: boolean }) {
  await screen.findByLabelText(text('admin.quizzes.form.title'));
  if (values.title !== undefined) await fireEvent.changeText(titleField(), values.title);
  if (values.description !== undefined) {
    await fireEvent.changeText(descriptionField(), values.description);
  }
  if (values.published !== undefined) await setChecked(publishedControl, values.published);
}

// Requests that name an id, through a filter or a write's values.
const requestsFor = (id: string) =>
  mockCalls.filter(
    (call) =>
      call.filters.some(([, , value]) => value === id) ||
      JSON.stringify(call.values ?? null).includes(id),
  );

beforeEach(async () => {
  resetFake();
  // Out of sort_order on purpose: the screen has to ask for the order.
  mockTables.categories.length = 0;
  mockTables.categories.push(...[MUSIK, GESCHICHTE, GEOGRAFIE].map((row) => ({ ...row })));
  mockTables.quizzes.length = 0;
  mockTables.quizzes.push(
    ...[GEBIRGE, KOMPONISTEN, FLUESSE, HAUPTSTAEDTE].map((row) => ({ ...row })),
  );
  mockTables.questions.length = 0;
  mockTables.questions.push({ ...FRANCE });
  await i18n.changeLanguage('de');
});

describe('quiz admin texts', () => {
  const keys = [
    'admin.categories.actions.quizzes',
    'admin.quizzes.title',
    'admin.quizzes.loading',
    'admin.quizzes.empty',
    'admin.quizzes.error',
    'admin.quizzes.retry',
    'admin.quizzes.notFound',
    'admin.quizzes.back',
    'admin.quizzes.create',
    'admin.quizzes.status.published',
    'admin.quizzes.status.draft',
    'admin.quizzes.actions.questions',
    'admin.quizzes.actions.edit',
    'admin.quizzes.actions.publish',
    'admin.quizzes.actions.unpublish',
    'admin.quizzes.actions.delete',
    'admin.quizzes.errors.toggle',
    'admin.quizzes.errors.delete',
    'admin.quizzes.form.createTitle',
    'admin.quizzes.form.editTitle',
    'admin.quizzes.form.loading',
    'admin.quizzes.form.title',
    'admin.quizzes.form.description',
    'admin.quizzes.form.published',
    'admin.quizzes.form.save',
    'admin.quizzes.form.saving',
    'admin.quizzes.form.notFound',
    'admin.quizzes.form.back',
    'admin.quizzes.form.errors.save',
    'admin.quizzes.form.errors.titleRequired',
    'admin.quizzes.form.errors.load',
    'admin.quizzes.deleteDialog.title',
    'admin.quizzes.deleteDialog.message',
    'admin.quizzes.deleteDialog.confirm',
    'admin.quizzes.deleteDialog.cancel',
  ];

  it.each(keys)('%s has a German and an English text', (key) => {
    expect(text(key, 'de')).toMatch(/\S/);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('names the quiz in each list action, so the actions of different rows differ', () => {
    for (const key of [
      'admin.quizzes.actions.questions',
      'admin.quizzes.actions.edit',
      'admin.quizzes.actions.publish',
      'admin.quizzes.actions.unpublish',
      'admin.quizzes.actions.delete',
    ]) {
      expect(label(key, { name: 'Komponisten' })).toContain('Komponisten');
      expect(label(key, { name: 'Komponisten' }, 'en')).toContain('Komponisten');
    }
  });

  it('names the category in the list heading and its link from the category list', () => {
    for (const key of ['admin.quizzes.title', 'admin.categories.actions.quizzes']) {
      expect(label(key, { name: 'Musik' })).toContain('Musik');
      expect(label(key, { name: 'Musik' }, 'en')).toContain('Musik');
    }
  });

  it('warns in the delete dialog that the questions go too', () => {
    const german = label('admin.quizzes.deleteDialog.message', { name: 'Komponisten' });
    const english = label('admin.quizzes.deleteDialog.message', { name: 'Komponisten' }, 'en');

    expect(german).toContain('Komponisten');
    expect(german).toMatch(/Frage/i);
    expect(english).toContain('Komponisten');
    expect(english).toMatch(/question/i);
  });
});

describe('quiz list (/admin/categories/<categoryId>)', () => {
  it('lists the category’s quizzes by sort_order, unpublished ones included, and no others', async () => {
    await renderAt(listUrl(GEOGRAFIE));

    expect(await screen.findByText('Gebirge der Welt')).toBeOnTheScreen();
    expect(listedTitles()).toEqual([
      'Hauptstädte Europas',
      'Flüsse in Deutschland',
      'Gebirge der Welt',
    ]);
    expect(screen.queryByText('Komponisten')).toBeNull();
  });

  it('names the category in its heading', async () => {
    await renderAt(listUrl(GEOGRAFIE));

    expect(await screen.findByText(listHeading(GEOGRAFIE))).toBeOnTheScreen();
  });

  it('shows the published state of each quiz', async () => {
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Gebirge der Welt');

    expect(screen.getAllByText(text('admin.quizzes.status.published'))).toHaveLength(2);
    expect(screen.getAllByText(text('admin.quizzes.status.draft'))).toHaveLength(1);
  });

  it('lists the quizzes of an unpublished category too', async () => {
    await renderAt(listUrl(MUSIK));

    expect(await screen.findByText('Komponisten')).toBeOnTheScreen();
    expect(listedTitles()).toEqual(['Komponisten']);
  });

  it('shows its texts in English when the language is English', async () => {
    await i18n.changeLanguage('en');

    await renderAt(listUrl(GEOGRAFIE));

    expect(await screen.findByText(listHeading(GEOGRAFIE, 'en'))).toBeOnTheScreen();
    expect(await screen.findByText('Gebirge der Welt')).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.quizzes.status.published', 'en'))).toHaveLength(2);
    expect(screen.getAllByText(text('admin.quizzes.status.draft', 'en'))).toHaveLength(1);
  });

  it('shows a loading state while the quizzes are being read', async () => {
    mockServer['quizzes.select'] = 'pending';

    await renderAt(listUrl(GEOGRAFIE));

    expect(await screen.findByText(text('admin.quizzes.loading'))).toBeOnTheScreen();
    expect(screen.queryByText('Hauptstädte Europas')).toBeNull();
  });

  it('shows an empty state with the create link when the category has no quizzes', async () => {
    await renderAt(listUrl(GESCHICHTE));

    expect(await screen.findByText(text('admin.quizzes.empty'))).toBeOnTheScreen();
    expect(await findControl(text('admin.quizzes.create'))).toBeOnTheScreen();
    expect(screen.queryByText(TITLES)).toBeNull();
  });

  it('shows an error with a retry that loads the quizzes', async () => {
    mockServer['quizzes.select'] = { error: NETWORK_ERROR };

    await renderAt(listUrl(GEOGRAFIE));

    // Generous: the query client may retry with backoff before it gives up.
    expect(
      await screen.findByText(text('admin.quizzes.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Hauptstädte Europas')).toBeNull();

    mockServer['quizzes.select'] = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: text('admin.quizzes.retry') }));

    expect(await screen.findByText('Hauptstädte Europas')).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.quizzes.error'))).toBeNull();
  });

  it('shows an error with a retry when the category cannot be read', async () => {
    mockServer['categories.select'] = { error: NETWORK_ERROR };

    await renderAt(listUrl(GEOGRAFIE));

    expect(
      await screen.findByText(text('admin.quizzes.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();

    mockServer['categories.select'] = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: text('admin.quizzes.retry') }));

    expect(await screen.findByText(listHeading(GEOGRAFIE))).toBeOnTheScreen();
    expect(await screen.findByText('Hauptstädte Europas')).toBeOnTheScreen();
  });

  it('shows a not-found state with a link back to the categories for an unknown category', async () => {
    // e.g. deleted in another tab
    const result = await renderAt(`/admin/categories/${UNKNOWN_ID}`);

    expect(await screen.findByText(text('admin.quizzes.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByRole(ACTION, { name: text('admin.quizzes.create') })).toBeNull();
    expect(screen.queryByText(text('admin.quizzes.empty'))).toBeNull();

    await fireEvent.press(control(text('admin.quizzes.back')));
    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('shows the not-found state for a malformed id without asking the server', async () => {
    await renderAt('/admin/categories/gibt-es-nicht');

    expect(await screen.findByText(text('admin.quizzes.notFound'))).toBeOnTheScreen();
    await flush();
    expect(callsOf('categories', 'select').filter((call) => call.filters.length > 0)).toEqual([]);
    expect(callsOf('quizzes', 'select')).toEqual([]);
  });

  it('is reached from the category’s link on the category list', async () => {
    const result = await renderAt('/admin/categories');
    await screen.findByText('Geografie');

    await fireEvent.press(
      control(label('admin.categories.actions.quizzes', { name: 'Geografie' })),
    );

    await waitFor(() => expect(result.getPathname()).toBe(listUrl(GEOGRAFIE)));
    expect(await screen.findByText(listHeading(GEOGRAFIE))).toBeOnTheScreen();
    expect(await screen.findByText('Hauptstädte Europas')).toBeOnTheScreen();
  });

  it('opens the create form at /admin/categories/<categoryId>/quizzes/new', async () => {
    const result = await renderAt(listUrl(GEOGRAFIE));

    await fireEvent.press(await findControl(text('admin.quizzes.create')));

    await waitFor(() => expect(result.getPathname()).toBe(newUrl(GEOGRAFIE)));
    expect(await screen.findByText(text('admin.quizzes.form.createTitle'))).toBeOnTheScreen();
  });

  it('opens the edit form of a quiz at /admin/quizzes/<quizId>/edit', async () => {
    const result = await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');

    await fireEvent.press(
      control(label('admin.quizzes.actions.edit', { name: 'Flüsse in Deutschland' })),
    );

    await waitFor(() => expect(result.getPathname()).toBe(editUrl(FLUESSE)));
    expect(await screen.findByText(text('admin.quizzes.form.editTitle'))).toBeOnTheScreen();
  });

  it('opens the question list of a quiz at /admin/quizzes/<quizId>', async () => {
    const result = await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Hauptstädte Europas');

    await fireEvent.press(
      control(label('admin.quizzes.actions.questions', { name: 'Hauptstädte Europas' })),
    );

    await waitFor(() => expect(result.getPathname()).toBe(`/admin/quizzes/${HAUPTSTAEDTE.id}`));
    expect(await screen.findByText(FRANCE.text)).toBeOnTheScreen();
  });
});

describe('create form (/admin/categories/<categoryId>/quizzes/new)', () => {
  it('has labelled fields for title, description and published, unpublished at first', async () => {
    await renderAt(newUrl(GEOGRAFIE));

    expect(await screen.findByLabelText(text('admin.quizzes.form.title'))).toBeOnTheScreen();
    expect(descriptionField()).toBeOnTheScreen();
    expect(isChecked(publishedControl())).toBeFalsy();
    expect(saveButton()).toBeEnabled();
  });

  it('saves the quiz in the category of the route, with title, description and published and no sort_order', async () => {
    await renderAt(newUrl(GEOGRAFIE));

    await fillForm({ title: 'Wüsten der Welt', description: 'Sand und Steine', published: true });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(callsOf('quizzes', 'insert')).toHaveLength(1));
    expect(written(callsOf('quizzes', 'insert')[0])).toEqual({
      category_id: GEOGRAFIE.id,
      title: 'Wüsten der Welt',
      description: 'Sand und Steine',
      published: true,
    });
  });

  it('stores an empty description as null and the quiz as unpublished by default', async () => {
    await renderAt(newUrl(GEOGRAFIE));

    await fillForm({ title: 'Wüsten der Welt', description: ' \n ' });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(callsOf('quizzes', 'insert')).toHaveLength(1));
    const values = written(callsOf('quizzes', 'insert')[0]);
    expect(values.description ?? null).toBeNull();
    expect(values.published ?? false).toBe(false);
  });

  it('returns to the category’s quiz list after saving, where the new quiz is last and unpublished', async () => {
    const result = await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Gebirge der Welt');
    await fireEvent.press(control(text('admin.quizzes.create')));

    await fillForm({ title: 'Wüsten der Welt' });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(result.getPathname()).toBe(listUrl(GEOGRAFIE)));
    expect(await screen.findByText('Wüsten der Welt')).toBeOnTheScreen();
    expect(listedTitles()).toEqual([
      'Hauptstädte Europas',
      'Flüsse in Deutschland',
      'Gebirge der Welt',
      'Wüsten der Welt',
    ]);
    expect(screen.getAllByText(text('admin.quizzes.status.draft'))).toHaveLength(2);
  });

  it('rejects a blank title with a translated message and sends nothing', async () => {
    await renderAt(newUrl(GEOGRAFIE));

    await fillForm({ title: ' \t ' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.quizzes.form.errors.titleRequired')),
    ).toBeOnTheScreen();
    await flush();
    expect(callsOf('quizzes', 'insert')).toEqual([]);
  });

  it('shows the blank-title message in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    await renderAt(newUrl(GEOGRAFIE));

    await fillForm({ title: '' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.quizzes.form.errors.titleRequired', 'en')),
    ).toBeOnTheScreen();
  });

  it('shows a pending state and ignores further presses while saving', async () => {
    mockServer['quizzes.insert'] = 'pending';
    const result = await renderAt(newUrl(GEOGRAFIE));
    await fillForm({ title: 'Wüsten der Welt' });

    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.quizzes.form.saving'))).toBeOnTheScreen();
    expect(saveButton()).toBeDisabled();
    await fireEvent.press(saveButton());
    await flush();
    expect(callsOf('quizzes', 'insert')).toHaveLength(1);

    mockServer['quizzes.insert'] = 'ok';
    await act(async () => mockRelease());
    await waitFor(() => expect(result.getPathname()).toBe(listUrl(GEOGRAFIE)));
  });

  it('keeps the input and shows an error when the server fails', async () => {
    mockServer['quizzes.insert'] = { error: NETWORK_ERROR };
    const result = await renderAt(newUrl(GEOGRAFIE));
    await fillForm({ title: 'Wüsten der Welt', description: 'Sand', published: true });

    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.quizzes.form.errors.save'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe(newUrl(GEOGRAFIE));
    expect(titleField().props.value).toBe('Wüsten der Welt');
    expect(descriptionField().props.value).toBe('Sand');
    expect(isChecked(publishedControl())).toBe(true);
    expect(saveButton()).toBeEnabled();
  });

  it('shows a loading state while the category is being read', async () => {
    mockServer['categories.select'] = 'pending';

    await renderAt(newUrl(GEOGRAFIE));

    expect(await screen.findByText(text('admin.quizzes.form.loading'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.quizzes.form.title'))).toBeNull();
  });

  it('shows a not-found state and no form for an unknown category', async () => {
    await renderAt(`/admin/categories/${UNKNOWN_ID}/quizzes/new`);

    expect(await screen.findByText(text('admin.quizzes.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByLabelText(text('admin.quizzes.form.title'))).toBeNull();
    expect(control(text('admin.quizzes.back'))).toBeOnTheScreen();
    expect(callsOf('quizzes', 'insert')).toEqual([]);
  });

  it('shows the not-found state for a malformed category id without asking the server', async () => {
    await renderAt('/admin/categories/gibt-es-nicht/quizzes/new');

    expect(await screen.findByText(text('admin.quizzes.notFound'))).toBeOnTheScreen();
    await flush();
    expect(requestsFor('gibt-es-nicht')).toEqual([]);
    expect(screen.queryByLabelText(text('admin.quizzes.form.title'))).toBeNull();
  });

  it('shows an error with a retry, and no form, when the category cannot be read', async () => {
    mockServer['categories.select'] = { error: NETWORK_ERROR };
    await renderAt(newUrl(GEOGRAFIE));

    expect(await screen.findByText(text('admin.quizzes.form.errors.load'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.quizzes.form.title'))).toBeNull();

    mockServer['categories.select'] = 'ok';
    await fireEvent.press(control(text('admin.quizzes.retry')));

    expect(await screen.findByLabelText(text('admin.quizzes.form.title'))).toBeOnTheScreen();
  });
});

describe('edit form (/admin/quizzes/<quizId>/edit)', () => {
  it('shows an unpublished quiz with its values', async () => {
    await renderAt(editUrl(FLUESSE));

    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));
    expect(descriptionField().props.value).toBe('Noch in Arbeit');
    expect(isChecked(publishedControl())).toBeFalsy();
  });

  it('saves the changes to that quiz only, without category_id or sort_order', async () => {
    await renderAt(editUrl(FLUESSE));
    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));

    await fillForm({ title: 'Flüsse in Europa', description: '', published: true });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(callsOf('quizzes', 'update')).toHaveLength(1));
    const [update] = callsOf('quizzes', 'update');
    expect(update.filters).toContainEqual(['id', 'eq', FLUESSE.id]);
    expect(
      Object.keys(update.values as object).every((key) =>
        ['title', 'description', 'published'].includes(key),
      ),
    ).toBe(true);
    expect(mockTables.quizzes.find((row) => row.id === FLUESSE.id)).toMatchObject({
      category_id: GEOGRAFIE.id,
      title: 'Flüsse in Europa',
      description: null,
      published: true,
      sort_order: 2,
    });
    expect(mockTables.quizzes.find((row) => row.id === HAUPTSTAEDTE.id)).toMatchObject({
      title: 'Hauptstädte Europas',
    });
  });

  it('returns to the quiz list of its category after saving, which shows the change', async () => {
    const result = await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');
    await fireEvent.press(
      control(label('admin.quizzes.actions.edit', { name: 'Flüsse in Deutschland' })),
    );
    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));

    await fillForm({ title: 'Wüsten der Welt' });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(result.getPathname()).toBe(listUrl(GEOGRAFIE)));
    expect(await screen.findByText('Wüsten der Welt')).toBeOnTheScreen();
    expect(screen.queryByText('Flüsse in Deutschland')).toBeNull();
  });

  it('reads the quiz again whenever the form opens, so it never shows outdated values', async () => {
    const result = await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');
    const edit = () =>
      fireEvent.press(
        control(label('admin.quizzes.actions.edit', { name: 'Flüsse in Deutschland' })),
      );

    await edit();
    await waitFor(() => expect(isChecked(publishedControl())).toBe(false));
    await act(() => testRouter.back());
    await waitFor(() => expect(result.getPathname()).toBe(listUrl(GEOGRAFIE)));

    // Published elsewhere (another tab or admin) while the form was closed.
    const stored = mockTables.quizzes.find((row) => row.id === FLUESSE.id) as Quiz;
    stored.published = true;
    stored.description = 'Fertig';

    await edit();
    await waitFor(() => expect(descriptionField().props.value).toBe('Fertig'));
    expect(isChecked(publishedControl())).toBe(true);
  });

  it('shows a pending state while saving', async () => {
    mockServer['quizzes.update'] = 'pending';
    await renderAt(editUrl(FLUESSE));
    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));

    await fillForm({ title: 'Flüsse in Europa' });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.quizzes.form.saving'))).toBeOnTheScreen();
    expect(saveButton()).toBeDisabled();
  });

  it('keeps the input and shows an error when the server fails', async () => {
    mockServer['quizzes.update'] = { error: NETWORK_ERROR };
    const result = await renderAt(editUrl(FLUESSE));
    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));

    await fillForm({ title: 'Flüsse in Europa', description: 'Neu', published: true });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.quizzes.form.errors.save'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe(editUrl(FLUESSE));
    expect(titleField().props.value).toBe('Flüsse in Europa');
    expect(descriptionField().props.value).toBe('Neu');
    expect(isChecked(publishedControl())).toBe(true);
  });

  it('shows an error when the quiz is gone by the time it is saved', async () => {
    await renderAt(editUrl(FLUESSE));
    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));
    // Deleted in another tab: the update touches no row.
    mockTables.quizzes.splice(
      mockTables.quizzes.findIndex((row) => row.id === FLUESSE.id),
      1,
    );

    await fillForm({ title: 'Flüsse in Europa' });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.quizzes.form.errors.save'))).toBeOnTheScreen();
  });

  it('rejects a blank title with a translated message and sends nothing', async () => {
    await renderAt(editUrl(FLUESSE));
    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));

    await fillForm({ title: '\r\n' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.quizzes.form.errors.titleRequired')),
    ).toBeOnTheScreen();
    await flush();
    expect(callsOf('quizzes', 'update')).toEqual([]);
  });

  it('shows a loading state while the quiz is being read', async () => {
    mockServer['quizzes.select'] = 'pending';

    await renderAt(editUrl(FLUESSE));

    expect(await screen.findByText(text('admin.quizzes.form.loading'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.quizzes.form.title'))).toBeNull();
  });

  it('shows a not-found state with a back link, and no form, for an unknown quiz', async () => {
    await renderAt(`/admin/quizzes/${UNKNOWN_QUIZ}/edit`);

    expect(await screen.findByText(text('admin.quizzes.form.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByLabelText(text('admin.quizzes.form.title'))).toBeNull();
    expect(screen.queryByRole('button', { name: text('admin.quizzes.form.save') })).toBeNull();
    expect(control(text('admin.quizzes.form.back'))).toBeOnTheScreen();
    expect(callsOf('quizzes', 'update')).toEqual([]);
  });

  it('shows the not-found state for a malformed id without asking the server', async () => {
    await renderAt('/admin/quizzes/gibt-es-nicht/edit');

    expect(await screen.findByText(text('admin.quizzes.form.notFound'))).toBeOnTheScreen();
    await flush();
    expect(requestsFor('gibt-es-nicht')).toEqual([]);
  });

  it('shows an error with a retry, and no form, when the quiz cannot be read', async () => {
    mockServer['quizzes.select'] = { error: NETWORK_ERROR };
    await renderAt(editUrl(FLUESSE));

    expect(await screen.findByText(text('admin.quizzes.form.errors.load'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.quizzes.form.title'))).toBeNull();

    mockServer['quizzes.select'] = 'ok';
    await fireEvent.press(control(text('admin.quizzes.retry')));

    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));
    expect(callsOf('quizzes', 'update')).toEqual([]);
  });
});

describe('publish toggle on the quiz list', () => {
  it('publishes an unpublished quiz', async () => {
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');

    await fireEvent.press(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    );

    await waitFor(() => expect(callsOf('quizzes', 'update')).toHaveLength(1));
    const [update] = callsOf('quizzes', 'update');
    expect(update.values).toEqual({ published: true });
    expect(update.filters).toContainEqual(['id', 'eq', FLUESSE.id]);
    expect(
      await findControl(
        label('admin.quizzes.actions.unpublish', { name: 'Flüsse in Deutschland' }),
      ),
    ).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.quizzes.status.published'))).toHaveLength(3);
    expect(screen.queryByText(text('admin.quizzes.status.draft'))).toBeNull();
  });

  it('reads the list from the server again after publishing', async () => {
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');

    await fireEvent.press(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    );

    await waitFor(() => expect(callsOf('quizzes', 'update')).toHaveLength(1));
    await waitFor(() => expect(readsAfterLast('quizzes', 'update')).toBeGreaterThanOrEqual(1));
  });

  it('unpublishes a published quiz', async () => {
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Hauptstädte Europas');

    await fireEvent.press(
      control(label('admin.quizzes.actions.unpublish', { name: 'Hauptstädte Europas' })),
    );

    await waitFor(() => expect(callsOf('quizzes', 'update')).toHaveLength(1));
    expect(callsOf('quizzes', 'update')[0].values).toEqual({ published: false });
    expect(callsOf('quizzes', 'update')[0].filters).toContainEqual(['id', 'eq', HAUPTSTAEDTE.id]);
    expect(
      await findControl(label('admin.quizzes.actions.publish', { name: 'Hauptstädte Europas' })),
    ).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.quizzes.status.draft'))).toHaveLength(2);
  });

  it('shows an error and keeps the state the server has when publishing fails', async () => {
    mockServer['quizzes.update'] = { error: NETWORK_ERROR };
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');

    await fireEvent.press(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    );

    expect(await screen.findByText(text('admin.quizzes.errors.toggle'))).toBeOnTheScreen();
    await flush();
    expect(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    ).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.quizzes.status.draft'))).toHaveLength(1);
    expect(mockTables.quizzes.find((row) => row.id === FLUESSE.id)?.published).toBe(false);
  });

  it('keeps the row’s toggle and delete disabled while its toggle runs, and only that row’s', async () => {
    mockServer['quizzes.update'] = 'pending';
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');

    await fireEvent.press(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    );

    await waitFor(() =>
      expect(
        control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
      ).toBeDisabled(),
    );
    expect(
      control(label('admin.quizzes.actions.delete', { name: 'Flüsse in Deutschland' })),
    ).toBeDisabled();
    expect(
      control(label('admin.quizzes.actions.unpublish', { name: 'Hauptstädte Europas' })),
    ).toBeEnabled();
    expect(
      control(label('admin.quizzes.actions.delete', { name: 'Hauptstädte Europas' })),
    ).toBeEnabled();

    await fireEvent.press(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    );
    await flush();
    expect(callsOf('quizzes', 'update')).toHaveLength(1);

    mockServer['quizzes.update'] = 'ok';
    await act(async () => mockRelease());
    expect(
      await findControl(
        label('admin.quizzes.actions.unpublish', { name: 'Flüsse in Deutschland' }),
      ),
    ).toBeEnabled();
  });
});

describe('deleting a quiz with confirmation', () => {
  async function openDeleteDialog(title: string) {
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText(title);
    await fireEvent.press(control(label('admin.quizzes.actions.delete', { name: title })));
    return findDialog();
  }

  it('asks in a labelled dialog that warns about the questions', async () => {
    const dialog = await openDeleteDialog('Flüsse in Deutschland');

    expect(dialog).toHaveAccessibleName(
      label('admin.quizzes.deleteDialog.title', { name: 'Flüsse in Deutschland' }),
    );
    expect(
      within(dialog).getByText(
        label('admin.quizzes.deleteDialog.message', { name: 'Flüsse in Deutschland' }),
      ),
    ).toBeOnTheScreen();
    expect(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.confirm') }),
    ).toBeOnTheScreen();
    expect(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.cancel') }),
    ).toBeOnTheScreen();
    expect(callsOf('quizzes', 'delete')).toEqual([]);
  });

  it('deletes nothing when cancelled', async () => {
    const dialog = await openDeleteDialog('Flüsse in Deutschland');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.cancel') }),
    );

    await waitFor(() => expect(queryDialog()).toBeNull());
    await flush();
    expect(callsOf('quizzes', 'delete')).toEqual([]);
    expect(screen.getByText('Flüsse in Deutschland')).toBeOnTheScreen();
    expect(mockTables.quizzes.some((row) => row.id === FLUESSE.id)).toBe(true);
  });

  it('deletes the quiz when confirmed and removes it from the list', async () => {
    const dialog = await openDeleteDialog('Flüsse in Deutschland');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.confirm') }),
    );

    await waitFor(() => expect(callsOf('quizzes', 'delete')).toHaveLength(1));
    expect(callsOf('quizzes', 'delete')[0].filters).toContainEqual(['id', 'eq', FLUESSE.id]);
    await waitFor(() => expect(screen.queryByText('Flüsse in Deutschland')).toBeNull());
    expect(queryDialog()).toBeNull();
    expect(listedTitles()).toEqual(['Hauptstädte Europas', 'Gebirge der Welt']);
  });

  it('reads the list from the server again after deleting', async () => {
    const dialog = await openDeleteDialog('Flüsse in Deutschland');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.confirm') }),
    );

    await waitFor(() => expect(callsOf('quizzes', 'delete')).toHaveLength(1));
    await waitFor(() => expect(readsAfterLast('quizzes', 'delete')).toBeGreaterThanOrEqual(1));
  });

  it('shows an error and keeps the quiz when the delete fails', async () => {
    mockServer['quizzes.delete'] = { error: NETWORK_ERROR };
    const dialog = await openDeleteDialog('Flüsse in Deutschland');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.confirm') }),
    );

    expect(await screen.findByText(text('admin.quizzes.errors.delete'))).toBeOnTheScreen();
    await flush();
    expect(listedTitles()).toEqual([
      'Hauptstädte Europas',
      'Flüsse in Deutschland',
      'Gebirge der Welt',
    ]);
  });

  it('shows an error when the quiz was already gone', async () => {
    const dialog = await openDeleteDialog('Flüsse in Deutschland');
    // Deleted in another tab: the delete touches no row.
    mockTables.quizzes.splice(
      mockTables.quizzes.findIndex((row) => row.id === FLUESSE.id),
      1,
    );

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.confirm') }),
    );

    expect(await screen.findByText(text('admin.quizzes.errors.delete'))).toBeOnTheScreen();
  });

  it('keeps the row’s delete and toggle disabled while its delete runs', async () => {
    mockServer['quizzes.delete'] = 'pending';
    const dialog = await openDeleteDialog('Flüsse in Deutschland');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.quizzes.deleteDialog.confirm') }),
    );

    await waitFor(() =>
      expect(
        control(label('admin.quizzes.actions.delete', { name: 'Flüsse in Deutschland' })),
      ).toBeDisabled(),
    );
    expect(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    ).toBeDisabled();
    expect(
      control(label('admin.quizzes.actions.delete', { name: 'Hauptstädte Europas' })),
    ).toBeEnabled();

    await act(async () => mockRelease());
    await waitFor(() => expect(screen.queryByText('Flüsse in Deutschland')).toBeNull());
  });
});

// Publish rules (#82) -------------------------------------------------------------
// The database refuses to publish a quiz without questions or with a question
// that breaks the answer rules, with SQLSTATE 23514 (quiz_publish_rules.test.sql).
// The screens explain why instead of the generic error. The fake doesn't
// model the rule; each test makes the server refuse the write.

const PUBLISH_REFUSED = {
  error: { code: '23514', message: 'quiz_publish_rules' },
};

describe('why a quiz cannot be published', () => {
  it('has a German and an English explanation that names the questions and their answers', () => {
    expect(text('admin.quizzes.errors.publishRules', 'de')).toMatch(/Frage/);
    expect(text('admin.quizzes.errors.publishRules', 'de')).toMatch(/Antwort/);
    expect(text('admin.quizzes.errors.publishRules', 'en')).toMatch(/question/i);
    expect(text('admin.quizzes.errors.publishRules', 'en')).toMatch(/answer/i);
  });

  it('explains on the list why publishing was refused, and keeps the quiz a draft', async () => {
    mockServer['quizzes.update'] = PUBLISH_REFUSED;
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');

    await fireEvent.press(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    );

    expect(await screen.findByText(text('admin.quizzes.errors.publishRules'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.quizzes.errors.toggle'))).toBeNull();
    await flush();
    expect(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' })),
    ).toBeOnTheScreen();
  });

  it('explains in the edit form why publishing was refused, and keeps the input', async () => {
    mockServer['quizzes.update'] = PUBLISH_REFUSED;
    const result = await renderAt(editUrl(FLUESSE));
    await waitFor(() => expect(titleField().props.value).toBe('Flüsse in Deutschland'));

    await fillForm({ title: 'Flüsse in Europa', published: true });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.quizzes.errors.publishRules'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.quizzes.form.errors.save'))).toBeNull();
    expect(result.getPathname()).toBe(editUrl(FLUESSE));
    expect(titleField().props.value).toBe('Flüsse in Europa');
    expect(isChecked(publishedControl())).toBe(true);
  });

  it('explains in the create form why a new quiz cannot be published right away', async () => {
    mockServer['quizzes.insert'] = PUBLISH_REFUSED;
    const result = await renderAt(newUrl(GEOGRAFIE));

    await fillForm({ title: 'Wüsten der Welt', published: true });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.quizzes.errors.publishRules'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.quizzes.form.errors.save'))).toBeNull();
    expect(result.getPathname()).toBe(newUrl(GEOGRAFIE));
    expect(titleField().props.value).toBe('Wüsten der Welt');
  });

  it('shows the explanation in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    mockServer['quizzes.update'] = PUBLISH_REFUSED;
    await renderAt(listUrl(GEOGRAFIE));
    await screen.findByText('Flüsse in Deutschland');

    await fireEvent.press(
      control(label('admin.quizzes.actions.publish', { name: 'Flüsse in Deutschland' }, 'en')),
    );

    expect(
      await screen.findByText(text('admin.quizzes.errors.publishRules', 'en')),
    ).toBeOnTheScreen();
  });
});
