// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter, testRouter } from 'expo-router/testing-library';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// The admin's question screens (#81), rendered through the real route tree
// in src/app with expo-router's renderRouter, behind the admin guard:
// - `/admin/quizzes/<quizId>`: the quiz's questions by sort_order, each with
//   an edit link and a delete action with an in-app confirmation that warns
//   that learners' recorded answers go too; with loading, empty,
//   error-with-retry and not-found states.
// - `/admin/quizzes/<quizId>/questions/new` and
//   `/admin/quizzes/<quizId>/questions/<questionId>`: the create and edit
//   form (text, explanation, multiple_correct and, since #82, the answers
//   inline: add, edit, remove, mark correct), with loading,
//   error-with-retry and not-found states, a pending state while saving and
//   an error that keeps the input.
//
// Re-spec (#82): the form saves a question with its answers in one
// transaction through `save_question(quiz_id, question_id, text,
// explanation, multiple_correct, answers)` (`supabase.rpc`), because
// PostgREST runs each request in its own transaction and the database
// refuses a question that breaks the answer rules. The save tests that
// watched `questions.insert` / `questions.update` now watch that call, with
// the same values, and fill in valid answers where they create a question.
//
// The explanation and answers.is_correct are solution columns: no role may
// select them, not even an admin. The edit form reads them through the
// admin-only functions `admin_question(question_id)` and
// `admin_answers(question_id)` (`supabase.rpc`), and writes send them
// without asking for them back. The fake enforces that: a select, filter or
// write return that names `explanation` on questions or `is_correct` on
// answers (or `*`) is 42501.
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack does to the seed admin: `from('categories' | 'quizzes' |
// 'questions')` are in-memory tables with the database's rules (reads apply
// `eq`/`in` filters and `order`, and the rows are stored out of order on
// purpose; inserts and updates may only write the columns the grants allow,
// anything else is 42501; a blank text is 23514; an insert gets the next
// sort_order within its quiz). `answers` is an in-memory table too, and
// `rpc('save_question')` applies the database's rules: only an admin
// (else 42501), at least two answers, at least one correct, exactly one for
// single choice and no blank text (else 23514), an unknown question or an
// answer of another question is P0001. `mockServer['<table>.<operation>']`
// and `mockServer['rpc.<function>']` fail or hold a request. Every request
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
type Answer = Row & {
  question_id: string;
  text: string;
  image_path: string | null;
  image_alt: string | null;
  is_correct: boolean;
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
const mockAnswers: Answer[] = [];
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
  const solution =
    table === 'questions' ? 'explanation' : table === 'answers' ? 'is_correct' : null;
  if (solution === null || columns == null) return false;
  return columns
    .split(',')
    .map((column) => column.trim().split(':').pop()?.trim())
    .some((column) => column === '*' || column === solution);
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
      ids.push(question.id);
    }
  }
  if (table === 'quizzes' || table === 'questions') {
    for (const answer of mockAnswers.filter((a) => ids.includes(a.question_id))) {
      mockAnswers.splice(mockAnswers.indexOf(answer), 1);
    }
  }
  return {
    data: query.returning !== null ? removed.map((row) => mockVisible(table, row)) : null,
    error: null,
  };
}

// The answers table as the API shows it: rows of visible questions without
// is_correct; any write is recorded and refused, since the screens save
// answers only through save_question.
function mockAnswersQuery(query: Query): { data: unknown; error: PostgrestError | null } {
  if (
    mockNamesSolution('answers', query.columns) ||
    mockNamesSolution('answers', query.returning) ||
    [...query.filters.map(([c]) => c), ...query.orders.map(([c]) => c)].includes('is_correct')
  ) {
    return mockError('42501', 'permission denied for table answers');
  }
  if (query.operation !== 'select') {
    return mockError('XX000', 'the fake refuses direct answer writes: use save_question');
  }
  const found = mockAnswers
    .filter((row) => mockMatches(row, query.filters))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(({ is_correct: _hidden, ...rest }) => rest);
  return { data: found, error: null };
}

// public.admin_answers(question_id): the admin's read of a question's
// answers with is_correct, by sort_order; anyone else gets 'not available'.
function mockAdminAnswers(args: Record<string, unknown>): {
  data: unknown;
  error: PostgrestError | null;
} {
  const admin = mockAuth.session ? mockProfiles[mockAuth.session.user.id] === 'admin' : false;
  if (!admin) return mockError('P0001', 'not available');
  return {
    data: mockAnswers
      .filter((row) => row.question_id === args.question_id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((row) => ({
        id: row.id,
        text: row.text,
        is_correct: row.is_correct,
        sort_order: row.sort_order,
      })),
    error: null,
  };
}

type SentAnswer = { id?: string | null; text?: unknown; is_correct?: unknown };

// public.save_question(...): the question with its answers in one
// transaction, with the database's rules. Returns the question's id.
function mockSaveQuestion(args: Record<string, unknown>): {
  data: unknown;
  error: PostgrestError | null;
} {
  const admin = mockAuth.session ? mockProfiles[mockAuth.session.user.id] === 'admin' : false;
  if (!admin) return mockError('42501', 'permission denied for table questions');
  const answers = (Array.isArray(args.answers) ? args.answers : []) as SentAnswer[];
  const correct = answers.filter((answer) => answer.is_correct === true).length;
  if (
    mockIsBlank(args.text) ||
    answers.some((answer) => mockIsBlank(answer.text)) ||
    answers.length < 2 ||
    correct < 1 ||
    (args.multiple_correct !== true && correct !== 1)
  ) {
    return mockError('23514', 'question_answers_rules');
  }
  const fields = {
    text: args.text as string,
    explanation: (args.explanation as string | null | undefined) ?? null,
    multiple_correct: args.multiple_correct === true,
  };
  let question: Question | undefined;
  if (args.question_id == null) {
    if (!mockTables.quizzes.some((quiz) => quiz.id === args.quiz_id)) {
      return mockError('23503', 'questions_quiz_id_fkey');
    }
    const siblings = mockTables.questions.filter((row) => row.quiz_id === args.quiz_id);
    question = {
      id: `90000000-0000-4000-8000-${String(mockNextId++).padStart(12, '0')}`,
      quiz_id: args.quiz_id as string,
      image_path: null,
      image_alt: null,
      ...fields,
      sort_order: Math.max(0, ...siblings.map((row) => row.sort_order)) + 1,
      created_at: '2026-10-12T00:00:00Z',
    };
    mockTables.questions.push(question);
  } else {
    question = mockTables.questions.find((row) => row.id === args.question_id);
    if (!question) return mockError('P0001', 'not available');
    const own = mockAnswers.filter((row) => row.question_id === question?.id).map((row) => row.id);
    if (answers.some((answer) => answer.id != null && !own.includes(answer.id))) {
      return mockError('P0001', 'not available');
    }
    Object.assign(question, fields);
  }
  const id = question.id;
  const kept = answers.map((answer) => answer.id).filter((answerId) => answerId != null);
  for (const row of mockAnswers.filter((r) => r.question_id === id && !kept.includes(r.id))) {
    mockAnswers.splice(mockAnswers.indexOf(row), 1);
  }
  for (const answer of answers) {
    const existing = mockAnswers.find((row) => row.id === answer.id);
    if (existing) {
      Object.assign(existing, { text: answer.text, is_correct: answer.is_correct === true });
    } else {
      const siblings = mockAnswers.filter((row) => row.question_id === id);
      mockAnswers.push({
        id: `91000000-0000-4000-8000-${String(mockNextId++).padStart(12, '0')}`,
        question_id: id,
        text: answer.text as string,
        image_path: null,
        image_alt: null,
        is_correct: answer.is_correct === true,
        sort_order: Math.max(0, ...siblings.map((row) => row.sort_order)) + 1,
        created_at: '2026-10-12T00:00:00Z',
      });
    }
  }
  return { data: id, error: null };
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
  } else if (query.operation === 'rpc' || query.table in mockTables || query.table === 'answers') {
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
    const args = (query.values ?? {}) as Record<string, unknown>;
    if (query.operation === 'rpc') {
      result =
        query.table === 'admin_question'
          ? mockAdminQuestion(args)
          : query.table === 'admin_answers'
            ? mockAdminAnswers(args)
            : query.table === 'save_question'
              ? mockSaveQuestion(args)
              : mockError('PGRST202', `Could not find the function public.${query.table}`);
    } else if (query.table === 'answers') {
      result = mockAnswersQuery(query);
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
    // Re-spec (#122): admin rights need an aal2 session (password and TOTP).
    // The app reads the level and the factors through auth.mfa. Here the
    // admin's session is aal2 with one verified TOTP factor, anyone else's
    // aal1 without a factor; admin-mfa.test.tsx covers the step-up itself.
    mfa: {
      getAuthenticatorAssuranceLevel: () => {
        const level =
          mockAuth.session !== null
            ? mockAuth.session?.user.id === ADMIN.id
              ? 'aal2'
              : 'aal1'
            : null;
        return Promise.resolve({
          data: { currentLevel: level, nextLevel: level, currentAuthenticationMethods: [] },
          error: null,
        });
      },
      listFactors: () => {
        const totp =
          mockAuth.session?.user.id === ADMIN.id
            ? [
                {
                  id: 'f0000000-0000-4000-8000-000000000001',
                  factor_type: 'totp',
                  status: 'verified',
                  friendly_name: '',
                  created_at: '2026-10-01T00:00:00Z',
                  updated_at: '2026-10-01T00:00:00Z',
                },
              ]
            : [];
        return Promise.resolve({ data: { all: totp, totp, phone: [] }, error: null });
      },
    },
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

// The save_question calls, and the arguments of one as the database reads
// them: a missing question_id, explanation or answer id is null.
const saveCalls = () => callsOf('save_question', 'rpc');

type SavedAnswer = { id: string | null; text: string; is_correct: boolean };
type Saved = {
  quiz_id: string;
  question_id: string | null;
  text: string;
  explanation: string | null;
  multiple_correct: boolean;
  answers: SavedAnswer[];
};

function saved(call: Call): Saved {
  const args = (call.values ?? {}) as Record<string, unknown>;
  return {
    quiz_id: args.quiz_id as string,
    question_id: (args.question_id as string | null | undefined) ?? null,
    text: args.text as string,
    explanation: (args.explanation as string | null | undefined) ?? null,
    multiple_correct: args.multiple_correct as boolean,
    answers: ((args.answers ?? []) as Partial<SavedAnswer>[]).map((answer) => ({
      id: answer.id ?? null,
      text: answer.text as string,
      is_correct: answer.is_correct as boolean,
    })),
  };
}

// Direct writes to the question and answer tables: the form saves only
// through save_question.
const directWrites = () =>
  mockCalls.filter(
    (call) =>
      (call.table === 'questions' || call.table === 'answers') &&
      ['insert', 'update'].includes(call.operation),
  );

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
const HAUPTSTAEDTE: Quiz = {
  id: '20000000-0000-4000-8000-000000000001',
  category_id: GEOGRAFIE.id,
  title: 'Hauptstädte Europas',
  description: 'Kennst du die Hauptstädte unserer Nachbarn?',
  sort_order: 1,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
// A quiz without questions.
const FLUESSE: Quiz = {
  id: '20000000-0000-4000-8000-000000000002',
  category_id: GEOGRAFIE.id,
  title: 'Flüsse in Deutschland',
  description: null,
  sort_order: 2,
  published: false,
  created_at: '2026-10-01T00:00:00Z',
};
const CHEMIE: Quiz = {
  id: '20000000-0000-4000-8000-000000000003',
  category_id: GEOGRAFIE.id,
  title: 'Chemie-Grundlagen',
  description: null,
  sort_order: 3,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};

function question(
  id: string,
  quiz: Quiz,
  text: string,
  sortOrder: number,
  explanation: string | null,
  multipleCorrect = false,
): Question {
  return {
    id,
    quiz_id: quiz.id,
    text,
    image_path: null,
    image_alt: null,
    multiple_correct: multipleCorrect,
    explanation,
    sort_order: sortOrder,
    created_at: '2026-10-01T00:00:00Z',
  };
}

const FRANCE = question(
  '30000000-0000-4000-8000-000000000001',
  HAUPTSTAEDTE,
  'Was ist die Hauptstadt von Frankreich?',
  1,
  'Paris ist seit dem Mittelalter die Hauptstadt Frankreichs.',
);
const ITALY = question(
  '30000000-0000-4000-8000-000000000002',
  HAUPTSTAEDTE,
  'Was ist die Hauptstadt von Italien?',
  2,
  null,
);
const DANUBE = question(
  '30000000-0000-4000-8000-000000000003',
  HAUPTSTAEDTE,
  'Welche dieser Hauptstädte liegen an der Donau?',
  3,
  'Wien, Bratislava und Budapest liegen an der Donau, Prag an der Moldau.',
  true,
);
// In another quiz: never on Hauptstädte's list.
const GOLD = question(
  '30000000-0000-4000-8000-000000000005',
  CHEMIE,
  'Welches chemische Symbol hat Gold?',
  1,
  'Au kommt vom lateinischen Wort „aurum“.',
);

function answer(
  id: string,
  q: Question,
  text: string,
  sortOrder: number,
  isCorrect: boolean,
): Answer {
  return {
    id,
    question_id: q.id,
    text,
    image_path: null,
    image_alt: null,
    is_correct: isCorrect,
    sort_order: sortOrder,
    created_at: '2026-10-01T00:00:00Z',
  };
}

// Stored out of sort_order on purpose: the form has to ask for the order.
const ANSWERS: Answer[] = [
  answer('40000000-0000-4000-8000-000000000002', FRANCE, 'Lyon', 2, false),
  answer('40000000-0000-4000-8000-000000000001', FRANCE, 'Paris', 1, true),
  answer('40000000-0000-4000-8000-000000000003', FRANCE, 'Marseille', 3, false),
  answer('40000000-0000-4000-8000-000000000004', ITALY, 'Rom', 1, true),
  answer('40000000-0000-4000-8000-000000000005', ITALY, 'Mailand', 2, false),
  answer('40000000-0000-4000-8000-000000000006', DANUBE, 'Wien', 1, true),
  answer('40000000-0000-4000-8000-000000000007', DANUBE, 'Prag', 2, false),
  answer('40000000-0000-4000-8000-000000000008', DANUBE, 'Budapest', 3, true),
  answer('40000000-0000-4000-8000-000000000009', DANUBE, 'Bratislava', 4, true),
  answer('40000000-0000-4000-8000-000000000010', GOLD, 'Au', 1, true),
  answer('40000000-0000-4000-8000-000000000011', GOLD, 'Ag', 2, false),
];

const TEXTS =
  /^(Was ist die Hauptstadt von (Frankreich|Italien)\?|Welche dieser Hauptstädte liegen an der Donau\?|Welches chemische Symbol hat Gold\?|Was ist die Hauptstadt von Spanien\?)$/;
const UNKNOWN_QUIZ = '20000000-0000-4000-8000-0000000000ff';
const UNKNOWN_QUESTION = '30000000-0000-4000-8000-0000000000ff';

// The question texts on the list, top to bottom.
function listedTexts(): string[] {
  return screen.getAllByText(TEXTS).map((element) => String(element.props.children));
}

const listUrl = (quiz: Quiz) => `/admin/quizzes/${quiz.id}`;
const newUrl = (quiz: Quiz) => `/admin/quizzes/${quiz.id}/questions/new`;
const editUrl = (q: Question) => `/admin/quizzes/${q.quiz_id}/questions/${q.id}`;
const listHeading = (quiz: Quiz, lng: 'de' | 'en' = shown()) =>
  label('admin.questions.title', { name: quiz.title }, lng);

const textField = () => screen.getByLabelText(text('admin.questions.form.text'));
const explanationField = () => screen.getByLabelText(text('admin.questions.form.explanation'));
const multipleControl = () =>
  screen.getByRole(/^(switch|checkbox)$/, { name: text('admin.questions.form.multipleCorrect') });
const saveButton = () =>
  screen.queryByRole('button', { name: text('admin.questions.form.save') }) ??
  screen.getByRole('button', { name: text('admin.questions.form.saving') });

async function fillForm(values: { text?: string; explanation?: string; multiple?: boolean }) {
  await screen.findByLabelText(text('admin.questions.form.text'));
  if (values.text !== undefined) await fireEvent.changeText(textField(), values.text);
  if (values.explanation !== undefined) {
    await fireEvent.changeText(explanationField(), values.explanation);
  }
  if (values.multiple !== undefined) await setChecked(multipleControl, values.multiple);
}

// The answers in the form, by their 1-based position: a text field, a
// correct mark (checkbox, switch or radio) and a remove action, each named
// with the answer's number, and one action to add an answer.
const answerField = (number: number) =>
  screen.getByLabelText(label('admin.questions.form.answers.text', { number: String(number) }));
const queryAnswerField = (number: number) =>
  screen.queryByLabelText(label('admin.questions.form.answers.text', { number: String(number) }));
const correctControl = (number: number) =>
  screen.getByRole(/^(checkbox|switch|radio)$/, {
    name: label('admin.questions.form.answers.correct', { number: String(number) }),
  });
const removeControl = (number: number) =>
  screen.getByRole('button', {
    name: label('admin.questions.form.answers.remove', { number: String(number) }),
  });
const addControl = () =>
  screen.getByRole('button', { name: text('admin.questions.form.answers.add') });

// The number of answers the form shows.
function answerCount(): number {
  let count = 0;
  while (queryAnswerField(count + 1)) count += 1;
  return count;
}

// A radio is marked by a press; a checkbox or switch through setChecked.
async function setCorrect(number: number, target: boolean) {
  const find = () => correctControl(number);
  if (isChecked(find()) === target) return;
  await fireEvent(find(), 'valueChange', target);
  if (isChecked(find()) !== target) await fireEvent.press(find());
  expect(isChecked(find())).toBe(target);
}

// Makes the form show exactly these answers, top to bottom.
async function fillAnswers(answers: { text: string; correct: boolean }[]) {
  await screen.findByLabelText(text('admin.questions.form.text'));
  while (answerCount() < answers.length) await fireEvent.press(addControl());
  while (answerCount() > answers.length) await fireEvent.press(removeControl(answerCount()));
  for (const [index, value] of answers.entries()) {
    await fireEvent.changeText(answerField(index + 1), value.text);
  }
  // Unmark first, so a single-choice form never needs two marks at once.
  for (const [index, value] of answers.entries()) {
    if (!value.correct) await setCorrect(index + 1, false);
  }
  for (const [index, value] of answers.entries()) {
    if (value.correct) await setCorrect(index + 1, true);
  }
}

// The form's answers as shown: text and correct mark, top to bottom.
function shownAnswers(): { text: string; correct: boolean }[] {
  return Array.from({ length: answerCount() }, (_, index) => ({
    text: String(answerField(index + 1).props.value ?? ''),
    correct: Boolean(isChecked(correctControl(index + 1))),
  }));
}

// Two valid answers for a new single-choice question.
const MADRID = [
  { text: 'Madrid', correct: true },
  { text: 'Barcelona', correct: false },
];

// An element or one of its nearest ancestors (at most three levels up)
// announces changes to screen readers: role alert, or a polite or assertive
// live region (native or web props). The announcing element must hold the
// message, not the form: a region with a text field inside doesn't count,
// so a live region wrapping the whole form can't pass for the message's own.
const ANNOUNCE_LEVELS = 3;
function isAnnounced(element: TestInstance | null): boolean {
  let node = element;
  for (let level = 0; node && level <= ANNOUNCE_LEVELS; level += 1, node = node.parent) {
    const props = node.props as Record<string, unknown>;
    const role = props.role ?? props.accessibilityRole;
    const live = props.accessibilityLiveRegion ?? props['aria-live'];
    if (role === 'alert' || live === 'polite' || live === 'assertive') {
      return node.queryAll((child) => child.type === 'TextInput').length === 0;
    }
  }
  return false;
}

// Requests that name an id, through a filter, a write's values or an rpc's
// arguments.
const requestsFor = (id: string) =>
  mockCalls.filter(
    (call) =>
      call.filters.some(([, , value]) => value === id) ||
      JSON.stringify(call.values ?? null).includes(id),
  );

// Every request that asked questions for the explanation or answers for
// is_correct: the fake refuses them, and the screens must not need them.
const solutionReads = () =>
  mockCalls.filter(
    (call) =>
      (call.table === 'questions' &&
        [call.columns, call.returning].some(
          (columns) => columns != null && /(^|,)\s*(\*|explanation)\s*(,|$)/.test(columns),
        )) ||
      (call.table === 'answers' &&
        ([call.columns, call.returning].some(
          (columns) => columns != null && /(^|,)\s*(\*|is_correct)\s*(,|$)/.test(columns),
        ) ||
          call.filters.some(([column]) => column === 'is_correct'))),
  );

const stored = (id: string) => mockTables.questions.find((row) => row.id === id);

beforeEach(async () => {
  resetFake();
  mockTables.categories.length = 0;
  mockTables.categories.push({ ...GEOGRAFIE });
  // Out of sort_order on purpose: the screen has to ask for the order.
  mockTables.quizzes.length = 0;
  mockTables.quizzes.push(...[CHEMIE, FLUESSE, HAUPTSTAEDTE].map((row) => ({ ...row })));
  mockTables.questions.length = 0;
  mockTables.questions.push(...[DANUBE, GOLD, FRANCE, ITALY].map((row) => ({ ...row })));
  mockAnswers.length = 0;
  mockAnswers.push(...ANSWERS.map((row) => ({ ...row })));
  await i18n.changeLanguage('de');
});

afterEach(() => {
  // Whatever a test did, no screen asked for the solution column directly.
  expect(solutionReads()).toEqual([]);
});

describe('question admin texts', () => {
  const keys = [
    'admin.questions.title',
    'admin.questions.loading',
    'admin.questions.empty',
    'admin.questions.error',
    'admin.questions.retry',
    'admin.questions.notFound',
    'admin.questions.back',
    'admin.questions.create',
    'admin.questions.actions.edit',
    'admin.questions.actions.delete',
    'admin.questions.errors.delete',
    'admin.questions.form.createTitle',
    'admin.questions.form.editTitle',
    'admin.questions.form.loading',
    'admin.questions.form.text',
    'admin.questions.form.explanation',
    'admin.questions.form.multipleCorrect',
    'admin.questions.form.save',
    'admin.questions.form.saving',
    'admin.questions.form.notFound',
    'admin.questions.form.back',
    'admin.questions.form.errors.save',
    'admin.questions.form.errors.textRequired',
    'admin.questions.form.errors.load',
    'admin.questions.deleteDialog.title',
    'admin.questions.deleteDialog.message',
    'admin.questions.deleteDialog.confirm',
    'admin.questions.deleteDialog.cancel',
  ];

  it.each(keys)('%s has a German and an English text', (key) => {
    expect(text(key, 'de')).toMatch(/\S/);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('names the question in each list action, so the actions of different rows differ', () => {
    for (const key of ['admin.questions.actions.edit', 'admin.questions.actions.delete']) {
      expect(label(key, { name: ITALY.text })).toContain(ITALY.text);
      expect(label(key, { name: ITALY.text }, 'en')).toContain(ITALY.text);
    }
  });

  it('names the quiz in the list heading', () => {
    expect(label('admin.questions.title', { name: 'Komponisten' })).toContain('Komponisten');
    expect(label('admin.questions.title', { name: 'Komponisten' }, 'en')).toContain('Komponisten');
  });

  it('warns in the delete dialog that learners’ recorded answers to the question go too', () => {
    const german = label('admin.questions.deleteDialog.message', { name: ITALY.text });
    const english = label('admin.questions.deleteDialog.message', { name: ITALY.text }, 'en');

    expect(german).toContain(ITALY.text);
    expect(german).toMatch(/Antwort/i);
    expect(english).toContain(ITALY.text);
    expect(english).toMatch(/answer/i);
  });
});

describe('question list (/admin/quizzes/<quizId>)', () => {
  it('lists the quiz’s questions by sort_order, and no others', async () => {
    await renderAt(listUrl(HAUPTSTAEDTE));

    expect(await screen.findByText(DANUBE.text)).toBeOnTheScreen();
    expect(listedTexts()).toEqual([FRANCE.text, ITALY.text, DANUBE.text]);
    expect(screen.queryByText(GOLD.text)).toBeNull();
  });

  it('names the quiz in its heading', async () => {
    await renderAt(listUrl(HAUPTSTAEDTE));

    expect(await screen.findByText(listHeading(HAUPTSTAEDTE))).toBeOnTheScreen();
  });

  it('shows no explanation on the list', async () => {
    await renderAt(listUrl(HAUPTSTAEDTE));
    await screen.findByText(DANUBE.text);

    expect(screen.queryByText(FRANCE.explanation as string)).toBeNull();
    expect(screen.queryByText(DANUBE.explanation as string)).toBeNull();
  });

  it('lists the questions of an unpublished quiz too', async () => {
    mockTables.questions.push(
      question('30000000-0000-4000-8000-000000000006', FLUESSE, ITALY.text, 1, null),
    );

    await renderAt(listUrl(FLUESSE));

    expect(await screen.findByText(ITALY.text)).toBeOnTheScreen();
    expect(listedTexts()).toEqual([ITALY.text]);
  });

  it('shows its texts in English when the language is English', async () => {
    await i18n.changeLanguage('en');

    await renderAt(listUrl(HAUPTSTAEDTE));

    expect(await screen.findByText(listHeading(HAUPTSTAEDTE, 'en'))).toBeOnTheScreen();
    expect(await findControl(text('admin.questions.create', 'en'))).toBeOnTheScreen();
    expect(
      control(label('admin.questions.actions.edit', { name: ITALY.text }, 'en')),
    ).toBeOnTheScreen();
  });

  it('shows a loading state while the questions are being read', async () => {
    mockServer['questions.select'] = 'pending';

    await renderAt(listUrl(HAUPTSTAEDTE));

    expect(await screen.findByText(text('admin.questions.loading'))).toBeOnTheScreen();
    expect(screen.queryByText(FRANCE.text)).toBeNull();
  });

  it('shows an empty state with the create link when the quiz has no questions', async () => {
    await renderAt(listUrl(FLUESSE));

    expect(await screen.findByText(text('admin.questions.empty'))).toBeOnTheScreen();
    expect(await findControl(text('admin.questions.create'))).toBeOnTheScreen();
    expect(screen.queryByText(TEXTS)).toBeNull();
  });

  it('shows an error with a retry that loads the questions', async () => {
    mockServer['questions.select'] = { error: NETWORK_ERROR };

    await renderAt(listUrl(HAUPTSTAEDTE));

    // Generous: the query client may retry with backoff before it gives up.
    expect(
      await screen.findByText(text('admin.questions.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(FRANCE.text)).toBeNull();

    mockServer['questions.select'] = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: text('admin.questions.retry') }));

    expect(await screen.findByText(FRANCE.text)).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.questions.error'))).toBeNull();
  });

  it('shows an error with a retry when the quiz cannot be read', async () => {
    mockServer['quizzes.select'] = { error: NETWORK_ERROR };

    await renderAt(listUrl(HAUPTSTAEDTE));

    expect(
      await screen.findByText(text('admin.questions.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();

    mockServer['quizzes.select'] = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: text('admin.questions.retry') }));

    expect(await screen.findByText(listHeading(HAUPTSTAEDTE))).toBeOnTheScreen();
    expect(await screen.findByText(FRANCE.text)).toBeOnTheScreen();
  });

  it('shows a not-found state with a link back to the categories for an unknown quiz', async () => {
    const result = await renderAt(`/admin/quizzes/${UNKNOWN_QUIZ}`);

    expect(await screen.findByText(text('admin.questions.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByRole(ACTION, { name: text('admin.questions.create') })).toBeNull();
    expect(screen.queryByText(text('admin.questions.empty'))).toBeNull();

    await fireEvent.press(control(text('admin.questions.back')));
    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('shows the not-found state for a malformed id without asking the server', async () => {
    await renderAt('/admin/quizzes/gibt-es-nicht');

    expect(await screen.findByText(text('admin.questions.notFound'))).toBeOnTheScreen();
    await flush();
    expect(requestsFor('gibt-es-nicht')).toEqual([]);
    expect(callsOf('questions', 'select')).toEqual([]);
  });

  it('opens the create form at /admin/quizzes/<quizId>/questions/new', async () => {
    const result = await renderAt(listUrl(HAUPTSTAEDTE));

    await fireEvent.press(await findControl(text('admin.questions.create')));

    await waitFor(() => expect(result.getPathname()).toBe(newUrl(HAUPTSTAEDTE)));
    // #116 re-spec: was `findByText(...)`. The admin header's breadcrumb now
    // repeats this title as its current segment, so the query is scoped to the
    // screen's own heading; it still proves the create form opened.
    expect(
      await screen.findByRole('heading', { name: text('admin.questions.form.createTitle') }),
    ).toBeOnTheScreen();
  });

  it('opens the edit form of a question at /admin/quizzes/<quizId>/questions/<questionId>', async () => {
    const result = await renderAt(listUrl(HAUPTSTAEDTE));
    await screen.findByText(ITALY.text);

    await fireEvent.press(control(label('admin.questions.actions.edit', { name: ITALY.text })));

    await waitFor(() => expect(result.getPathname()).toBe(editUrl(ITALY)));
    expect(await screen.findByText(text('admin.questions.form.editTitle'))).toBeOnTheScreen();
  });
});

describe('create form (/admin/quizzes/<quizId>/questions/new)', () => {
  it('has labelled fields for text, explanation and multiple_correct, single choice at first', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));

    expect(await screen.findByLabelText(text('admin.questions.form.text'))).toBeOnTheScreen();
    expect(explanationField()).toBeOnTheScreen();
    expect(isChecked(multipleControl())).toBeFalsy();
    expect(saveButton()).toBeEnabled();
  });

  // Re-spec (#82): was a `questions.insert` with these values; now one
  // save_question call with the question's answers.
  it('saves the question in the quiz of the route, with text, explanation and multiple_correct and no sort_order', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));

    await fillForm({
      text: 'Was ist die Hauptstadt von Spanien?',
      explanation: 'Madrid liegt fast genau in der Mitte des Landes.',
      multiple: true,
    });
    await fillAnswers(MADRID);
    await fireEvent.press(saveButton());

    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saved(saveCalls()[0])).toEqual({
      quiz_id: HAUPTSTAEDTE.id,
      question_id: null,
      text: 'Was ist die Hauptstadt von Spanien?',
      explanation: 'Madrid liegt fast genau in der Mitte des Landes.',
      multiple_correct: true,
      answers: [
        { id: null, text: 'Madrid', is_correct: true },
        { id: null, text: 'Barcelona', is_correct: false },
      ],
    });
    expect(Object.keys(saveCalls()[0].values as object)).not.toContain('sort_order');
    expect(directWrites()).toEqual([]);
    expect(
      mockTables.questions.find((row) => row.text === 'Was ist die Hauptstadt von Spanien?'),
    ).toMatchObject({
      explanation: 'Madrid liegt fast genau in der Mitte des Landes.',
      sort_order: 4,
    });
  });

  it('stores an empty explanation as null and the question as single choice by default', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));

    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?', explanation: '\t \n' });
    await fillAnswers(MADRID);
    await fireEvent.press(saveButton());

    // Re-spec (#82): read from the save_question call, was `questions.insert`.
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    const values = saved(saveCalls()[0]);
    expect(values.explanation).toBeNull();
    expect(values.multiple_correct ?? false).toBe(false);
  });

  it('returns to the question list after saving, where the new question is last', async () => {
    const result = await renderAt(listUrl(HAUPTSTAEDTE));
    await screen.findByText(DANUBE.text);
    await fireEvent.press(control(text('admin.questions.create')));

    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    // Re-spec (#82): a question needs valid answers to be saved.
    await fillAnswers(MADRID);
    await fireEvent.press(saveButton());

    await waitFor(() => expect(result.getPathname()).toBe(listUrl(HAUPTSTAEDTE)));
    expect(await screen.findByText('Was ist die Hauptstadt von Spanien?')).toBeOnTheScreen();
    expect(listedTexts()).toEqual([
      FRANCE.text,
      ITALY.text,
      DANUBE.text,
      'Was ist die Hauptstadt von Spanien?',
    ]);
  });

  it('rejects a blank text with a translated message and sends nothing', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));

    await fillForm({ text: ' \r\n ', explanation: 'Eine Erklärung ohne Frage.' });
    await fillAnswers(MADRID);
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.questions.form.errors.textRequired')),
    ).toBeOnTheScreen();
    await flush();
    // Re-spec (#82): no save_question call, was no `questions.insert`.
    expect(saveCalls()).toEqual([]);
    expect(directWrites()).toEqual([]);
  });

  it('shows the blank-text message in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    await renderAt(newUrl(HAUPTSTAEDTE));

    await fillForm({ text: '' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.questions.form.errors.textRequired', 'en')),
    ).toBeOnTheScreen();
  });

  // Re-spec (#82): holds the save_question call, was `questions.insert`.
  it('shows a pending state and ignores further presses while saving', async () => {
    mockServer['rpc.save_question'] = 'pending';
    const result = await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers(MADRID);

    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.questions.form.saving'))).toBeOnTheScreen();
    expect(saveButton()).toBeDisabled();
    await fireEvent.press(saveButton());
    await flush();
    expect(saveCalls()).toHaveLength(1);

    mockServer['rpc.save_question'] = 'ok';
    await act(async () => mockRelease());
    await waitFor(() => expect(result.getPathname()).toBe(listUrl(HAUPTSTAEDTE)));
  });

  // Re-spec (#82): fails the save_question call, was `questions.insert`;
  // the answers are part of the input that stays.
  it('keeps the input and shows an error when the server fails', async () => {
    mockServer['rpc.save_question'] = { error: NETWORK_ERROR };
    const result = await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({
      text: 'Was ist die Hauptstadt von Spanien?',
      explanation: 'Madrid.',
      multiple: true,
    });
    await fillAnswers(MADRID);

    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.questions.form.errors.save'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe(newUrl(HAUPTSTAEDTE));
    expect(textField().props.value).toBe('Was ist die Hauptstadt von Spanien?');
    expect(explanationField().props.value).toBe('Madrid.');
    expect(isChecked(multipleControl())).toBe(true);
    expect(shownAnswers()).toEqual(MADRID);
    expect(saveButton()).toBeEnabled();
  });

  it('shows a loading state while the quiz is being read', async () => {
    mockServer['quizzes.select'] = 'pending';

    await renderAt(newUrl(HAUPTSTAEDTE));

    expect(await screen.findByText(text('admin.questions.form.loading'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();
  });

  it('shows a not-found state and no form for an unknown quiz', async () => {
    await renderAt(`/admin/quizzes/${UNKNOWN_QUIZ}/questions/new`);

    expect(await screen.findByText(text('admin.questions.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();
    expect(control(text('admin.questions.back'))).toBeOnTheScreen();
    // Re-spec (#82): no save_question call, was no `questions.insert`.
    expect(saveCalls()).toEqual([]);
  });

  it('shows the not-found state for a malformed quiz id without asking the server', async () => {
    await renderAt('/admin/quizzes/gibt-es-nicht/questions/new');

    expect(await screen.findByText(text('admin.questions.notFound'))).toBeOnTheScreen();
    await flush();
    expect(requestsFor('gibt-es-nicht')).toEqual([]);
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();
  });

  it('shows an error with a retry, and no form, when the quiz cannot be read', async () => {
    mockServer['quizzes.select'] = { error: NETWORK_ERROR };
    await renderAt(newUrl(HAUPTSTAEDTE));

    expect(await screen.findByText(text('admin.questions.form.errors.load'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();

    mockServer['quizzes.select'] = 'ok';
    await fireEvent.press(control(text('admin.questions.retry')));

    expect(await screen.findByLabelText(text('admin.questions.form.text'))).toBeOnTheScreen();
  });
});

describe('edit form (/admin/quizzes/<quizId>/questions/<questionId>)', () => {
  it('shows the question with its explanation, read through admin_question', async () => {
    await renderAt(editUrl(DANUBE));

    await waitFor(() => expect(textField().props.value).toBe(DANUBE.text));
    expect(explanationField().props.value).toBe(DANUBE.explanation);
    expect(isChecked(multipleControl())).toBe(true);
    expect(callsOf('admin_question', 'rpc').map((call) => call.values)).toContainEqual({
      question_id: DANUBE.id,
    });
  });

  it('shows an empty explanation field for a question without one', async () => {
    await renderAt(editUrl(ITALY));

    await waitFor(() => expect(textField().props.value).toBe(ITALY.text));
    expect(explanationField().props.value ?? '').toBe('');
    expect(isChecked(multipleControl())).toBeFalsy();
  });

  it('saves text, explanation and multiple_correct to that question only, without reading the explanation back', async () => {
    await renderAt(editUrl(FRANCE));
    await waitFor(() => expect(textField().props.value).toBe(FRANCE.text));

    await fillForm({
      text: 'Welche Stadt ist die Hauptstadt Frankreichs?',
      explanation: 'Paris, an der Seine.',
      multiple: true,
    });
    await fireEvent.press(saveButton());

    // Re-spec (#82): one save_question call for that question, with its
    // unchanged answers, was a `questions.update` filtered on its id.
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saved(saveCalls()[0])).toEqual({
      quiz_id: HAUPTSTAEDTE.id,
      question_id: FRANCE.id,
      text: 'Welche Stadt ist die Hauptstadt Frankreichs?',
      explanation: 'Paris, an der Seine.',
      multiple_correct: true,
      answers: [
        { id: '40000000-0000-4000-8000-000000000001', text: 'Paris', is_correct: true },
        { id: '40000000-0000-4000-8000-000000000002', text: 'Lyon', is_correct: false },
        { id: '40000000-0000-4000-8000-000000000003', text: 'Marseille', is_correct: false },
      ],
    });
    expect(directWrites()).toEqual([]);
    expect(stored(FRANCE.id)).toMatchObject({
      quiz_id: HAUPTSTAEDTE.id,
      text: 'Welche Stadt ist die Hauptstadt Frankreichs?',
      explanation: 'Paris, an der Seine.',
      multiple_correct: true,
      sort_order: 1,
    });
    expect(stored(ITALY.id)).toMatchObject({ text: ITALY.text, explanation: null });
  });

  it('clears the explanation, stored as null', async () => {
    await renderAt(editUrl(FRANCE));
    await waitFor(() => expect(explanationField().props.value).toBe(FRANCE.explanation));

    await fillForm({ explanation: '' });
    await fireEvent.press(saveButton());

    // Re-spec (#82): waits for save_question, was `questions.update`.
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saved(saveCalls()[0]).explanation).toBeNull();
    expect(stored(FRANCE.id)?.explanation).toBeNull();
  });

  it('returns to the question list after saving, which shows the change', async () => {
    const result = await renderAt(listUrl(HAUPTSTAEDTE));
    await screen.findByText(ITALY.text);
    await fireEvent.press(control(label('admin.questions.actions.edit', { name: ITALY.text })));
    await waitFor(() => expect(textField().props.value).toBe(ITALY.text));

    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(result.getPathname()).toBe(listUrl(HAUPTSTAEDTE)));
    expect(await screen.findByText('Was ist die Hauptstadt von Spanien?')).toBeOnTheScreen();
    expect(screen.queryByText(ITALY.text)).toBeNull();
  });

  it('reads the question again whenever the form opens, so it never shows outdated values', async () => {
    const result = await renderAt(listUrl(HAUPTSTAEDTE));
    await screen.findByText(FRANCE.text);
    const edit = () =>
      fireEvent.press(control(label('admin.questions.actions.edit', { name: FRANCE.text })));

    await edit();
    await waitFor(() => expect(explanationField().props.value).toBe(FRANCE.explanation));
    await act(() => testRouter.back());
    await waitFor(() => expect(result.getPathname()).toBe(listUrl(HAUPTSTAEDTE)));

    // Changed elsewhere (another tab or admin) while the form was closed.
    (stored(FRANCE.id) as Question).explanation = 'Neu erklärt.';

    await edit();
    await waitFor(() => expect(explanationField().props.value).toBe('Neu erklärt.'));
    expect(
      callsOf('admin_question', 'rpc').filter(
        (call) => (call.values as { question_id?: string }).question_id === FRANCE.id,
      ),
    ).toHaveLength(2);
  });

  // Re-spec (#82): holds save_question, was `questions.update`.
  it('shows a pending state while saving', async () => {
    mockServer['rpc.save_question'] = 'pending';
    await renderAt(editUrl(FRANCE));
    await waitFor(() => expect(textField().props.value).toBe(FRANCE.text));

    await fillForm({ text: 'Welche Stadt ist die Hauptstadt Frankreichs?' });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.questions.form.saving'))).toBeOnTheScreen();
    expect(saveButton()).toBeDisabled();
  });

  // Re-spec (#82): fails save_question, was `questions.update`.
  it('keeps the input and shows an error when the server fails', async () => {
    mockServer['rpc.save_question'] = { error: NETWORK_ERROR };
    const result = await renderAt(editUrl(FRANCE));
    await waitFor(() => expect(textField().props.value).toBe(FRANCE.text));

    await fillForm({ text: 'Neu?', explanation: 'Neue Erklärung.', multiple: true });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.questions.form.errors.save'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe(editUrl(FRANCE));
    expect(textField().props.value).toBe('Neu?');
    expect(explanationField().props.value).toBe('Neue Erklärung.');
    expect(isChecked(multipleControl())).toBe(true);
  });

  it('shows an error when the question is gone by the time it is saved', async () => {
    await renderAt(editUrl(FRANCE));
    await waitFor(() => expect(textField().props.value).toBe(FRANCE.text));
    // Deleted in another tab: the update touches no row.
    mockTables.questions.splice(
      mockTables.questions.findIndex((row) => row.id === FRANCE.id),
      1,
    );

    await fillForm({ text: 'Neu?' });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.questions.form.errors.save'))).toBeOnTheScreen();
  });

  it('rejects a blank text with a translated message and sends nothing', async () => {
    await renderAt(editUrl(FRANCE));
    await waitFor(() => expect(textField().props.value).toBe(FRANCE.text));

    await fillForm({ text: '\t' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.questions.form.errors.textRequired')),
    ).toBeOnTheScreen();
    await flush();
    // Re-spec (#82): no save_question call, was no `questions.update`.
    expect(saveCalls()).toEqual([]);
    expect(directWrites()).toEqual([]);
  });

  it('shows a loading state while the question is being read', async () => {
    mockServer['rpc.admin_question'] = 'pending';

    await renderAt(editUrl(FRANCE));

    expect(await screen.findByText(text('admin.questions.form.loading'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();
  });

  it('shows a not-found state with a back link, and no form, for an unknown question', async () => {
    await renderAt(`/admin/quizzes/${HAUPTSTAEDTE.id}/questions/${UNKNOWN_QUESTION}`);

    expect(await screen.findByText(text('admin.questions.form.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();
    expect(screen.queryByRole('button', { name: text('admin.questions.form.save') })).toBeNull();
    expect(control(text('admin.questions.form.back'))).toBeOnTheScreen();
    // Re-spec (#82): no save_question call, was no `questions.update`.
    expect(saveCalls()).toEqual([]);
  });

  it('shows the not-found state for a question of another quiz, without its text or explanation', async () => {
    await renderAt(`/admin/quizzes/${HAUPTSTAEDTE.id}/questions/${GOLD.id}`);

    expect(await screen.findByText(text('admin.questions.form.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();
    expect(screen.queryByText(GOLD.text)).toBeNull();
    expect(screen.queryByText(GOLD.explanation as string)).toBeNull();
  });

  it('shows the not-found state for a malformed question id without asking the server', async () => {
    await renderAt(`/admin/quizzes/${HAUPTSTAEDTE.id}/questions/gibt-es-nicht`);

    expect(await screen.findByText(text('admin.questions.form.notFound'))).toBeOnTheScreen();
    await flush();
    expect(requestsFor('gibt-es-nicht')).toEqual([]);
    expect(callsOf('admin_question', 'rpc')).toEqual([]);
  });

  it('shows the not-found state for a malformed quiz id without asking the server', async () => {
    await renderAt(`/admin/quizzes/gibt-es-nicht/questions/${FRANCE.id}`);

    expect(await screen.findByText(text('admin.questions.form.notFound'))).toBeOnTheScreen();
    await flush();
    expect(requestsFor('gibt-es-nicht')).toEqual([]);
    expect(screen.queryByText(FRANCE.explanation as string)).toBeNull();
  });

  it('shows an error with a retry, and no form, when the question cannot be read', async () => {
    mockServer['rpc.admin_question'] = { error: NETWORK_ERROR };
    await renderAt(editUrl(FRANCE));

    expect(await screen.findByText(text('admin.questions.form.errors.load'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();

    mockServer['rpc.admin_question'] = 'ok';
    await fireEvent.press(control(text('admin.questions.retry')));

    await waitFor(() => expect(explanationField().props.value).toBe(FRANCE.explanation));
    // Re-spec (#82): no save_question call, was no `questions.update`.
    expect(saveCalls()).toEqual([]);
  });
});

describe('deleting a question with confirmation', () => {
  async function openDeleteDialog(name: string) {
    await renderAt(listUrl(HAUPTSTAEDTE));
    await screen.findByText(name);
    await fireEvent.press(control(label('admin.questions.actions.delete', { name })));
    return findDialog();
  }

  it('asks in a labelled dialog that warns about the learners’ recorded answers', async () => {
    const dialog = await openDeleteDialog(ITALY.text);

    expect(dialog).toHaveAccessibleName(
      label('admin.questions.deleteDialog.title', { name: ITALY.text }),
    );
    expect(
      within(dialog).getByText(label('admin.questions.deleteDialog.message', { name: ITALY.text })),
    ).toBeOnTheScreen();
    expect(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.confirm') }),
    ).toBeOnTheScreen();
    expect(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.cancel') }),
    ).toBeOnTheScreen();
    expect(callsOf('questions', 'delete')).toEqual([]);
  });

  it('deletes nothing when cancelled', async () => {
    const dialog = await openDeleteDialog(ITALY.text);

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.cancel') }),
    );

    await waitFor(() => expect(queryDialog()).toBeNull());
    await flush();
    expect(callsOf('questions', 'delete')).toEqual([]);
    expect(screen.getByText(ITALY.text)).toBeOnTheScreen();
    expect(stored(ITALY.id)).toBeDefined();
  });

  it('deletes the question when confirmed and removes it from the list', async () => {
    const dialog = await openDeleteDialog(ITALY.text);

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.confirm') }),
    );

    await waitFor(() => expect(callsOf('questions', 'delete')).toHaveLength(1));
    expect(callsOf('questions', 'delete')[0].filters).toContainEqual(['id', 'eq', ITALY.id]);
    await waitFor(() => expect(screen.queryByText(ITALY.text)).toBeNull());
    expect(queryDialog()).toBeNull();
    expect(listedTexts()).toEqual([FRANCE.text, DANUBE.text]);
  });

  it('reads the list from the server again after deleting', async () => {
    const dialog = await openDeleteDialog(ITALY.text);

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.confirm') }),
    );

    await waitFor(() => expect(callsOf('questions', 'delete')).toHaveLength(1));
    await waitFor(() => expect(readsAfterLast('questions', 'delete')).toBeGreaterThanOrEqual(1));
  });

  it('shows an error and keeps the question when the delete fails', async () => {
    mockServer['questions.delete'] = { error: NETWORK_ERROR };
    const dialog = await openDeleteDialog(ITALY.text);

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.confirm') }),
    );

    expect(await screen.findByText(text('admin.questions.errors.delete'))).toBeOnTheScreen();
    await flush();
    expect(listedTexts()).toEqual([FRANCE.text, ITALY.text, DANUBE.text]);
  });

  // #82: the database refuses deleting the last question of a published quiz
  // (23514, quiz_publish_rules.test.sql) rather than unpublishing it; the list
  // explains why instead of the generic delete error. The client keys on the
  // SQLSTATE; the message is the one the quiz list's publish refusal fakes.
  it('explains, announced, that the last question of a published quiz can’t be deleted', async () => {
    mockServer['questions.delete'] = {
      error: { code: '23514', message: 'quiz_publish_rules' },
    };
    const dialog = await openDeleteDialog(ITALY.text);

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.confirm') }),
    );

    const message = await screen.findByText(text('admin.questions.errors.deleteLastPublished'));
    expect(message).toBeOnTheScreen();
    expect(isAnnounced(message)).toBe(true);
    expect(text('admin.questions.errors.deleteLastPublished', 'en')).toMatch(/\S/);
    expect(screen.queryByText(text('admin.questions.errors.delete'))).toBeNull();
    await flush();
    expect(listedTexts()).toEqual([FRANCE.text, ITALY.text, DANUBE.text]);
  });

  it('shows an error when the question was already gone', async () => {
    const dialog = await openDeleteDialog(ITALY.text);
    // Deleted in another tab: the delete touches no row.
    mockTables.questions.splice(
      mockTables.questions.findIndex((row) => row.id === ITALY.id),
      1,
    );

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.confirm') }),
    );

    expect(await screen.findByText(text('admin.questions.errors.delete'))).toBeOnTheScreen();
  });

  it('keeps the row’s delete disabled while its delete runs, and only that row’s', async () => {
    mockServer['questions.delete'] = 'pending';
    const dialog = await openDeleteDialog(ITALY.text);

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.questions.deleteDialog.confirm') }),
    );

    await waitFor(() =>
      expect(control(label('admin.questions.actions.delete', { name: ITALY.text }))).toBeDisabled(),
    );
    expect(control(label('admin.questions.actions.delete', { name: FRANCE.text }))).toBeEnabled();

    await act(async () => mockRelease());
    await waitFor(() => expect(screen.queryByText(ITALY.text)).toBeNull());
  });
});

// Answers (#82) -----------------------------------------------------------------

describe('answer texts', () => {
  const keys = [
    'admin.questions.form.answers.title',
    'admin.questions.form.answers.text',
    'admin.questions.form.answers.correct',
    'admin.questions.form.answers.remove',
    'admin.questions.form.answers.add',
    'admin.questions.form.errors.answersTooFew',
    'admin.questions.form.errors.correctMissing',
    'admin.questions.form.errors.singleChoiceOneCorrect',
    'admin.questions.form.errors.answerTextRequired',
    'admin.questions.form.errors.rules',
  ];

  it.each(keys)('%s has a German and an English text', (key) => {
    expect(text(key, 'de')).toMatch(/\S/);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('numbers each answer’s field and actions, so the controls of different answers differ', () => {
    for (const key of [
      'admin.questions.form.answers.text',
      'admin.questions.form.answers.correct',
      'admin.questions.form.answers.remove',
    ]) {
      expect(label(key, { number: '3' })).toContain('3');
      expect(label(key, { number: '3' }, 'en')).toContain('3');
      expect(label(key, { number: '3' })).not.toBe(label(key, { number: '4' }));
    }
  });
});

describe('answers in the create form', () => {
  it('starts with two empty answers, none marked correct, and an action to add one', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await screen.findByLabelText(text('admin.questions.form.text'));

    expect(text('admin.questions.form.answers.title')).toMatch(/\S/);
    expect(screen.getByText(text('admin.questions.form.answers.title'))).toBeOnTheScreen();
    expect(shownAnswers()).toEqual([
      { text: '', correct: false },
      { text: '', correct: false },
    ]);
    expect(removeControl(1)).toBeOnTheScreen();
    expect(addControl()).toBeEnabled();
  });

  it('adds an answer at the end', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await screen.findByLabelText(text('admin.questions.form.text'));

    await fireEvent.press(addControl());

    expect(answerCount()).toBe(3);
    expect(answerField(3).props.value ?? '').toBe('');
    expect(isChecked(correctControl(3))).toBeFalsy();
  });

  it('removes an answer and numbers the rest again', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillAnswers([
      { text: 'Madrid', correct: true },
      { text: 'Barcelona', correct: false },
      { text: 'Sevilla', correct: false },
    ]);

    await fireEvent.press(removeControl(2));

    expect(shownAnswers()).toEqual([
      { text: 'Madrid', correct: true },
      { text: 'Sevilla', correct: false },
    ]);
  });

  it('saves a single-choice question with its answers in order through one save_question call', async () => {
    const result = await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers([
      { text: 'Barcelona', correct: false },
      { text: 'Madrid', correct: true },
      { text: 'Sevilla', correct: false },
    ]);

    await fireEvent.press(saveButton());

    await waitFor(() => expect(result.getPathname()).toBe(listUrl(HAUPTSTAEDTE)));
    expect(saveCalls()).toHaveLength(1);
    expect(saved(saveCalls()[0]).answers).toEqual([
      { id: null, text: 'Barcelona', is_correct: false },
      { id: null, text: 'Madrid', is_correct: true },
      { id: null, text: 'Sevilla', is_correct: false },
    ]);
    expect(directWrites()).toEqual([]);
    const created = mockTables.questions.find(
      (row) => row.text === 'Was ist die Hauptstadt von Spanien?',
    );
    expect(
      mockAnswers
        .filter((row) => row.question_id === created?.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((row) => [row.text, row.is_correct]),
    ).toEqual([
      ['Barcelona', false],
      ['Madrid', true],
      ['Sevilla', false],
    ]);
  });

  it('saves a multiple-choice question with several correct answers', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Welche Städte liegen am Rhein?', multiple: true });
    await fillAnswers([
      { text: 'Köln', correct: true },
      { text: 'Basel', correct: true },
      { text: 'Wien', correct: false },
    ]);

    await fireEvent.press(saveButton());

    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saved(saveCalls()[0])).toMatchObject({
      multiple_correct: true,
      answers: [
        { id: null, text: 'Köln', is_correct: true },
        { id: null, text: 'Basel', is_correct: true },
        { id: null, text: 'Wien', is_correct: false },
      ],
    });
  });
});

describe('answers in the edit form', () => {
  it('shows the question’s answers by sort_order with their correct marks, read through admin_answers', async () => {
    await renderAt(editUrl(DANUBE));

    await waitFor(() => expect(answerCount()).toBe(4));
    expect(shownAnswers()).toEqual([
      { text: 'Wien', correct: true },
      { text: 'Prag', correct: false },
      { text: 'Budapest', correct: true },
      { text: 'Bratislava', correct: true },
    ]);
    expect(callsOf('admin_answers', 'rpc').map((call) => call.values)).toContainEqual({
      question_id: DANUBE.id,
    });
  });

  it('saves edited, new and removed answers: ids kept, new ones without an id, removed ones left out', async () => {
    await renderAt(editUrl(FRANCE));
    await waitFor(() => expect(answerCount()).toBe(3));

    // Lyon goes, Paris is renamed, Marseille becomes correct instead, Nizza is new.
    await fireEvent.press(removeControl(2));
    await fireEvent.press(addControl());
    await fillAnswers([
      { text: 'Paris (Île-de-France)', correct: false },
      { text: 'Marseille', correct: true },
      { text: 'Nizza', correct: false },
    ]);
    await fireEvent.press(saveButton());

    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saved(saveCalls()[0])).toMatchObject({
      question_id: FRANCE.id,
      quiz_id: HAUPTSTAEDTE.id,
      answers: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          text: 'Paris (Île-de-France)',
          is_correct: false,
        },
        { id: '40000000-0000-4000-8000-000000000003', text: 'Marseille', is_correct: true },
        { id: null, text: 'Nizza', is_correct: false },
      ],
    });
    expect(directWrites()).toEqual([]);
    expect(mockAnswers.some((row) => row.id === '40000000-0000-4000-8000-000000000002')).toBe(
      false,
    );
  });

  it('reads the answers again whenever the form opens', async () => {
    const result = await renderAt(listUrl(HAUPTSTAEDTE));
    await screen.findByText(ITALY.text);
    const edit = () =>
      fireEvent.press(control(label('admin.questions.actions.edit', { name: ITALY.text })));

    await edit();
    await waitFor(() => expect(answerCount()).toBe(2));
    await act(() => testRouter.back());
    await waitFor(() => expect(result.getPathname()).toBe(listUrl(HAUPTSTAEDTE)));

    // Changed elsewhere while the form was closed.
    const mailand = mockAnswers.find((row) => row.text === 'Mailand') as Answer;
    mailand.text = 'Mailand (Lombardei)';

    await edit();
    await waitFor(() => expect(answerField(2).props.value).toBe('Mailand (Lombardei)'));
  });

  it('shows a loading state while the answers are being read', async () => {
    mockServer['rpc.admin_answers'] = 'pending';

    await renderAt(editUrl(FRANCE));
    await flush();

    // The question itself is read by now; the form waits for its answers.
    expect(callsOf('admin_answers', 'rpc')).toHaveLength(1);
    expect(screen.getByText(text('admin.questions.form.loading'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();
  });

  it('shows an error with a retry, and no form, when the answers cannot be read', async () => {
    mockServer['rpc.admin_answers'] = { error: NETWORK_ERROR };
    await renderAt(editUrl(FRANCE));

    expect(await screen.findByText(text('admin.questions.form.errors.load'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.questions.form.text'))).toBeNull();

    mockServer['rpc.admin_answers'] = 'ok';
    await fireEvent.press(control(text('admin.questions.retry')));

    await waitFor(() => expect(answerCount()).toBe(3));
    expect(saveCalls()).toEqual([]);
  });
});

describe('answer rules in the form', () => {
  // The message is on the screen and announced to screen readers.
  async function expectAnnounced(key: string, lng: 'de' | 'en' = shown()) {
    const message = await screen.findByText(text(key, lng));
    expect(message).toBeOnTheScreen();
    expect(isAnnounced(message)).toBe(true);
  }

  it('refuses fewer than two answers with an announced message and sends nothing', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers([{ text: 'Madrid', correct: true }]);

    await fireEvent.press(saveButton());

    await expectAnnounced('admin.questions.form.errors.answersTooFew');
    await flush();
    expect(saveCalls()).toEqual([]);
  });

  it('refuses a question without a correct answer with an announced message and sends nothing', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers([
      { text: 'Madrid', correct: false },
      { text: 'Barcelona', correct: false },
    ]);

    await fireEvent.press(saveButton());

    await expectAnnounced('admin.questions.form.errors.correctMissing');
    await flush();
    expect(saveCalls()).toEqual([]);
  });

  it('refuses a blank answer text with an announced message and sends nothing', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers([
      { text: 'Madrid', correct: true },
      { text: ' \t', correct: false },
    ]);

    await fireEvent.press(saveButton());

    await expectAnnounced('admin.questions.form.errors.answerTextRequired');
    expect(
      screen.getAllByText(text('admin.questions.form.errors.answerTextRequired')),
    ).toHaveLength(1);
    await flush();
    expect(saveCalls()).toEqual([]);
  });

  // The form may refuse when the switch is flipped (it stays on) or when the
  // question is saved; either way the explanation is announced, no mark
  // changes and no save makes it single choice with several correct answers.
  it('refuses switching from multiple to single choice with more than one correct answer, with an explanation, and changes no mark', async () => {
    await renderAt(editUrl(DANUBE));
    await waitFor(() => expect(answerCount()).toBe(4));

    // Tries the switch without requiring that it flips.
    await fireEvent(multipleControl(), 'valueChange', false);
    if (isChecked(multipleControl())) await fireEvent.press(multipleControl());
    await flush();
    // Not silently changed: every mark is still as it was.
    expect(shownAnswers().map((a) => a.correct)).toEqual([true, false, true, true]);

    // Refused on the switch: the message is already there. Otherwise it
    // comes with the save.
    const message = text('admin.questions.form.errors.singleChoiceOneCorrect');
    if (screen.queryByText(message) === null) await fireEvent.press(saveButton());

    await expectAnnounced('admin.questions.form.errors.singleChoiceOneCorrect');
    expect(shownAnswers().map((a) => a.correct)).toEqual([true, false, true, true]);
    await flush();
    expect(
      saveCalls()
        .map(saved)
        .filter(
          (call) =>
            !call.multiple_correct && call.answers.filter((answer) => answer.is_correct).length > 1,
        ),
    ).toEqual([]);
    expect(stored(DANUBE.id)?.multiple_correct).toBe(true);
    expect(
      mockAnswers.filter((row) => row.question_id === DANUBE.id && row.is_correct),
    ).toHaveLength(3);
  });

  it('saves the switch to single choice once only one answer is marked correct', async () => {
    await renderAt(editUrl(DANUBE));
    await waitFor(() => expect(answerCount()).toBe(4));

    await fillAnswers([
      { text: 'Wien', correct: true },
      { text: 'Prag', correct: false },
      { text: 'Budapest', correct: false },
      { text: 'Bratislava', correct: false },
    ]);
    await setChecked(multipleControl, false);
    await fireEvent.press(saveButton());

    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saved(saveCalls()[0]).multiple_correct).toBe(false);
    expect(stored(DANUBE.id)?.multiple_correct).toBe(false);
  });

  // A message about the correct marks goes as soon as the marks fix it, so
  // neither the screen nor a screen reader keeps an outdated message.
  it('removes the missing-correct message once an answer is marked correct', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers([
      { text: 'Madrid', correct: false },
      { text: 'Barcelona', correct: false },
    ]);
    await fireEvent.press(saveButton());
    await expectAnnounced('admin.questions.form.errors.correctMissing');

    await setCorrect(1, true);

    await waitFor(() =>
      expect(screen.queryByText(text('admin.questions.form.errors.correctMissing'))).toBeNull(),
    );
    expect(saveCalls()).toEqual([]);
  });

  it('removes the single-choice message once only one answer is marked correct', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers([
      { text: 'Madrid', correct: true },
      { text: 'Barcelona', correct: true },
    ]);
    await fireEvent.press(saveButton());
    await expectAnnounced('admin.questions.form.errors.singleChoiceOneCorrect');

    await setCorrect(2, false);

    await waitFor(() =>
      expect(
        screen.queryByText(text('admin.questions.form.errors.singleChoiceOneCorrect')),
      ).toBeNull(),
    );
    expect(saveCalls()).toEqual([]);
  });

  it('removes the single-choice message once the question is switched to multiple choice', async () => {
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers([
      { text: 'Madrid', correct: true },
      { text: 'Barcelona', correct: true },
    ]);
    await fireEvent.press(saveButton());
    await expectAnnounced('admin.questions.form.errors.singleChoiceOneCorrect');

    await setChecked(multipleControl, true);

    await waitFor(() =>
      expect(
        screen.queryByText(text('admin.questions.form.errors.singleChoiceOneCorrect')),
      ).toBeNull(),
    );
    expect(saveCalls()).toEqual([]);
  });

  it('shows the rule messages in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'What is the capital of Spain?' });
    await fillAnswers([
      { text: 'Madrid', correct: false },
      { text: 'Barcelona', correct: false },
    ]);

    await fireEvent.press(saveButton());

    await expectAnnounced('admin.questions.form.errors.correctMissing', 'en');
  });

  it('explains a refusal of the database’s answer rules, announced, and keeps the input', async () => {
    mockServer['rpc.save_question'] = {
      error: { code: '23514', message: 'question_answers_rules' },
    };
    const result = await renderAt(newUrl(HAUPTSTAEDTE));
    await fillForm({ text: 'Was ist die Hauptstadt von Spanien?' });
    await fillAnswers(MADRID);

    await fireEvent.press(saveButton());

    await expectAnnounced('admin.questions.form.errors.rules');
    expect(screen.queryByText(text('admin.questions.form.errors.save'))).toBeNull();
    expect(result.getPathname()).toBe(newUrl(HAUPTSTAEDTE));
    expect(shownAnswers()).toEqual(MADRID);
  });
});
