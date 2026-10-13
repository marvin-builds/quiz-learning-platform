// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Issue #116, the learner side of the navigation, rendered through the real
// route tree in src/app with expo-router's renderRouter, so it doesn't
// matter whether the header sits in a layout or in each screen:
// - A shared header (a landmark, role banner) on every learner screen. The
//   app name always links home. Home: no up link. Category: "← Kategorien"
//   up to home, the category name as title. Quiz intro and player:
//   "✕ Quiz verlassen" and the quiz name; leaving asks for confirmation once
//   at least one answer was recorded by submit_answer in the current attempt
//   (a submit still in flight counts) and the quiz isn't finished, then goes
//   to the quiz's category; before the first answer and on the intro it
//   leaves without asking. Result: "← <category name>" up to the category,
//   the quiz name as title.
// - "Up" goes to the logical parent, also when the screen was opened
//   directly by URL. Browser and hardware back stay plain history back, so
//   nothing here expects a prompt on history back.
// - A "Verwaltung" link only for a signed-in admin (non-anonymous user whose
//   profiles.role is 'admin'); hidden for anon, an anonymous user, a learner
//   and while the role is loading or failed to load.
//
// The header's texts are new keys under `nav` (see the texts test below);
// the German wording of the Design is part of the spec.
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack would:
// - `from(table)` reads apply RLS: anyone sees published categories, and
//   published quizzes of published categories with their questions and
//   answers; an admin sees every row. `questions.explanation`,
//   `answers.is_correct` and `*` on those tables are 42501 for every role.
//   Selects support `eq`/`in` filters (also on embedded paths), `order`
//   (also on embedded tables), to-one embeds (`categories` through
//   `category_id`, with `!inner`) and to-many embeds (`questions`,
//   `answers`).
// - `profiles`: an authenticated user reads only their own row; anon gets
//   42501. `attempts`: only the owner's rows.
// - `rpc('start_attempt')` creates an attempt (score 0, max_score = number
//   of questions); `rpc('submit_answer')` records the answer, scores it
//   (all correct picks 1, else 0), adds it to the attempt and returns the
//   solution.
// - `mockServer['<table>.select']` / `mockServer['rpc.<name>']` hold a
//   request ('pending', released by mockRelease) or fail it.
// - `auth` keeps a session, reports it through onAuthStateChange and signs
//   in anonymously when asked.
// Every request is recorded in `mockCalls`.

// The language the screens currently show.
const shown = (): 'de' | 'en' => (i18n.language === 'en' ? 'en' : 'de');

// Reads a text from de.json or en.json by path, so keys that don't exist yet
// fail at run time with their name instead of breaking the typecheck.
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

type Row = Record<string, unknown>;
type PostgrestError = { message: string; code: string; details?: string; hint?: string };
type Result = { data: unknown; error: PostgrestError | null };
type ServerState = 'ok' | 'pending' | { error: PostgrestError };
type Field = { key: string; column: string; inner?: boolean; embed?: Field[] };
type Order = { column: string; ascending: boolean; referencedTable?: string };
type Query = {
  table: string;
  operation: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  select?: string;
  values?: unknown;
  orders: Order[];
  filters: { column: string; values: unknown[] }[];
  mode: 'many' | 'maybeSingle' | 'single';
};
type User = {
  id: string;
  email?: string;
  is_anonymous: boolean;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
};
type Session = { access_token: string; refresh_token: string; user: User };
type Listener = (event: string, session: Session | null) => void;

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
  // What a learner could set themselves: it must not show them the link.
  user_metadata: { role: 'admin' },
  app_metadata: { provider: 'email', role: 'admin' },
};
const ANONYMOUS: User = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  is_anonymous: true,
  user_metadata: { role: 'admin' },
  app_metadata: { provider: 'anonymous', role: 'admin' },
};

const mockAuth = {
  session: null as Session | null,
  listeners: new Set<Listener>(),
  anonymousSignIns: 0,
};
const mockProfiles: Record<string, 'learner' | 'admin'> = {};
const mockDb: Record<string, Row[]> = {
  categories: [],
  quizzes: [],
  questions: [],
  answers: [],
  attempts: [],
  submissions: [],
};
const mockServer: Record<string, ServerState> = {};
const mockHeld: (() => void)[] = [];
const mockCalls: Query[] = [];
let mockNextId = 1;

function mockRelease() {
  for (const release of mockHeld.splice(0)) release();
}

const mockIsAdmin = () =>
  mockAuth.session !== null && mockProfiles[mockAuth.session.user.id] === 'admin';

const PARENT_KEY: Record<string, string> = {
  quizzes: 'category_id',
  questions: 'quiz_id',
  answers: 'question_id',
};
// To-one embeds: the column of the embedding row that references the embedded one.
const REFERENCE_KEY: Record<string, string> = { categories: 'category_id', quizzes: 'quiz_id' };
const HIDDEN_COLUMNS: Record<string, string[]> = {
  questions: ['explanation', '*'],
  answers: ['is_correct', '*'],
};

// What RLS lets the current user see of a table.
function mockVisibleRows(table: string): Row[] {
  const rows = mockDb[table] ?? [];
  if (mockIsAdmin()) return rows;
  const categoryVisible = (id: unknown) =>
    mockDb.categories.some((c) => c.id === id && c.published === true);
  const quizVisible = (id: unknown) =>
    mockDb.quizzes.some(
      (q) => q.id === id && q.published === true && categoryVisible(q.category_id),
    );
  switch (table) {
    case 'categories':
      return rows.filter((row) => row.published === true);
    case 'quizzes':
      return rows.filter((row) => quizVisible(row.id));
    case 'questions':
      return rows.filter((row) => quizVisible(row.quiz_id));
    case 'answers':
      return rows.filter((row) =>
        mockDb.questions.some((q) => q.id === row.question_id && quizVisible(q.quiz_id)),
      );
    case 'attempts':
      return rows.filter((row) => row.user_id === mockAuth.session?.user.id);
    default:
      return [];
  }
}

function mockSplitTopLevel(select: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of select) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

function mockParseFields(select: string): Field[] {
  return mockSplitTopLevel(select).map((item) => {
    const match = /^(?:(\w+):)?([\w*]+)(?:!(\w+))?(?:\(([\s\S]*)\))?$/.exec(item);
    if (!match) throw new Error(`The fake client can't parse the select item "${item}"`);
    const [, alias, column, hint, body] = match;
    return {
      key: alias ?? column,
      column,
      inner: hint === 'inner',
      embed: body === undefined ? undefined : mockParseFields(body),
    };
  });
}

function mockIsDenied(table: string, fields: Field[]): boolean {
  return fields.some((field) =>
    field.embed
      ? mockIsDenied(field.column, field.embed)
      : (HIDDEN_COLUMNS[table]?.includes(field.column) ?? false),
  );
}

function mockSort(rows: Row[], orders: Order[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const [x, y] = [a[column], b[column]] as [string | number, string | number];
      if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
    }
    return 0;
  });
}

function mockMatches(row: Row, query: Query, path: string[]): boolean {
  return query.filters.every(({ column, values }) => {
    const segments = column.split('.');
    const name = segments.pop()!;
    return segments.join('.') !== path.join('.') || values.includes(row[name]);
  });
}

function mockProject(row: Row, fields: Field[], query: Query, path: string[] = []): Row | null {
  const projected: Row = {};
  for (const field of fields) {
    if (field.embed) {
      const childPath = [...path, field.column];
      const referenceKey = REFERENCE_KEY[field.column];
      if (referenceKey && row[referenceKey] !== undefined) {
        const referenced = mockVisibleRows(field.column).find(
          (other) => other.id === row[referenceKey] && mockMatches(other, query, childPath),
        );
        const embedded = referenced ? mockProject(referenced, field.embed, query, childPath) : null;
        if (field.inner && !embedded) return null;
        projected[field.key] = embedded;
        continue;
      }
      const key = PARENT_KEY[field.column];
      if (!key) throw new Error(`The fake client can't embed ${field.column}`);
      const children = mockSort(
        mockVisibleRows(field.column).filter(
          (child) => child[key] === row.id && mockMatches(child, query, childPath),
        ),
        query.orders.filter(
          (order) =>
            order.referencedTable === childPath.join('.') || order.referencedTable === field.column,
        ),
      )
        .map((child) => mockProject(child, field.embed!, query, childPath))
        .filter((child): child is Row => child !== null);
      if (field.inner && children.length === 0) return null;
      projected[field.key] = children;
    } else if (field.column === '*') {
      Object.assign(projected, row);
    } else {
      projected[field.key] = row[field.column];
    }
  }
  return projected;
}

function mockSelect(query: Query): Result {
  if (query.table === 'profiles') {
    const user = mockAuth.session?.user;
    if (!user) {
      return {
        data: null,
        error: { code: '42501', message: 'permission denied for table profiles' },
      };
    }
    const role = mockProfiles[user.id];
    const rows = role ? [{ id: user.id, role, display_name: null }] : [];
    return {
      data: rows
        .filter((row) => mockMatches(row, query, []))
        .map((row) => mockProject(row, mockParseFields(query.select ?? '*'), query)),
      error: null,
    };
  }
  const fields = mockParseFields(query.select ?? '*');
  if (mockIsDenied(query.table, fields)) {
    return {
      data: null,
      error: { code: '42501', message: `permission denied for table ${query.table}` },
    };
  }
  const rows = mockSort(
    mockVisibleRows(query.table).filter((row) => mockMatches(row, query, [])),
    query.orders.filter((order) => !order.referencedTable),
  )
    .map((row) => mockProject(row, fields, query))
    .filter((row): row is Row => row !== null);
  return { data: rows, error: null };
}

function mockStartAttempt(args: Row): Result {
  const user = mockAuth.session?.user;
  if (!user) return { data: null, error: { code: '42501', message: 'permission denied' } };
  const quiz = mockVisibleRows('quizzes').find((row) => row.id === args.quiz_id);
  const count = mockDb.questions.filter((row) => row.quiz_id === args.quiz_id).length;
  if (!quiz || count === 0)
    return { data: null, error: { code: 'P0001', message: 'not available' } };
  const id = `60000000-0000-4000-8000-${String(mockNextId++).padStart(12, '0')}`;
  mockDb.attempts.push({
    id,
    user_id: user.id,
    quiz_id: quiz.id,
    score: 0,
    max_score: count,
    finished_at: null,
  });
  return { data: id, error: null };
}

function mockSubmitAnswer(args: Row): Result {
  const attempt = mockDb.attempts.find(
    (row) => row.id === args.attempt_id && row.user_id === mockAuth.session?.user.id,
  );
  if (!attempt) return { data: null, error: { code: 'P0001', message: 'not available' } };
  const correct = mockDb.answers
    .filter((row) => row.question_id === args.question_id && row.is_correct === true)
    .map((row) => row.id as string);
  const picked = (args.answer_ids as string[]) ?? [];
  const isCorrect =
    picked.length === correct.length && picked.every((answerId) => correct.includes(answerId));
  const points = isCorrect ? 1 : 0;
  mockDb.submissions.push({
    attempt_id: attempt.id,
    question_id: args.question_id,
    answer_ids: picked,
  });
  attempt.score = (attempt.score as number) + points;
  const question = mockDb.questions.find((row) => row.id === args.question_id);
  return {
    data: [
      {
        is_correct: isCorrect,
        correct_answer_ids: correct,
        explanation: question?.explanation ?? null,
        points,
      },
    ],
    error: null,
  };
}

async function mockRun(query: Query): Promise<Result> {
  mockCalls.push(query);
  const key =
    query.operation === 'rpc' ? `rpc.${query.table}` : `${query.table}.${query.operation}`;
  const state = mockServer[key] ?? 'ok';
  if (state === 'pending') await new Promise<void>((resolve) => mockHeld.push(resolve));
  else if (state !== 'ok') return { data: null, error: state.error };

  let result: Result;
  if (query.operation === 'rpc') {
    const args = (query.values ?? {}) as Row;
    result =
      query.table === 'start_attempt'
        ? mockStartAttempt(args)
        : query.table === 'submit_answer'
          ? mockSubmitAnswer(args)
          : {
              data: null,
              error: { code: 'PGRST202', message: `Could not find the function ${query.table}` },
            };
  } else if (query.operation === 'select') {
    result = mockSelect(query);
  } else {
    // The learner screens write nothing directly; scores come from the database.
    result = {
      data: null,
      error: { code: '42501', message: `permission denied for ${query.table}` },
    };
  }

  if (result.error || query.mode === 'many') return result;
  const rows = Array.isArray(result.data) ? result.data : [result.data];
  if (rows.length === 1) return { data: rows[0], error: null };
  if (query.mode === 'maybeSingle' && rows.length === 0) return { data: null, error: null };
  return {
    data: null,
    error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
  };
}

function mockBuilder(table: string, operation: Query['operation'], values?: unknown) {
  const query: Query = { table, operation, values, orders: [], filters: [], mode: 'many' };
  let throwOnError = false;
  const builder = {
    select(columns = '*') {
      if (query.operation === 'select') query.select = columns;
      return builder;
    },
    insert(rows: unknown) {
      query.operation = 'insert';
      query.values = rows;
      return builder;
    },
    update(rows: unknown) {
      query.operation = 'update';
      query.values = rows;
      return builder;
    },
    delete() {
      query.operation = 'delete';
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push({ column, values: [value] });
      return builder;
    },
    in(column: string, list: unknown[]) {
      query.filters.push({ column, values: list });
      return builder;
    },
    order(
      column: string,
      options?: { ascending?: boolean; referencedTable?: string; foreignTable?: string },
    ) {
      query.orders.push({
        column,
        ascending: options?.ascending !== false,
        referencedTable: options?.referencedTable ?? options?.foreignTable,
      });
      return builder;
    },
    maybeSingle() {
      query.mode = 'maybeSingle';
      return builder;
    },
    single() {
      query.mode = 'single';
      return builder;
    },
    limit: () => builder,
    abortSignal: () => builder,
    returns: () => builder,
    throwOnError() {
      throwOnError = true;
      return builder;
    },
    then<T>(onFulfilled: (value: Result) => T, onRejected?: (reason: unknown) => T) {
      return mockRun(query)
        .then((response) => {
          if (throwOnError && response.error) throw response.error;
          return response;
        })
        .then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function mockEmit(event: string) {
  for (const listener of mockAuth.listeners) listener(event, mockAuth.session);
}

const mockSupabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: mockAuth.session }, error: null }),
    getUser: () => Promise.resolve({ data: { user: mockAuth.session?.user ?? null }, error: null }),
    onAuthStateChange: (listener: Listener) => {
      mockAuth.listeners.add(listener);
      // supabase-js reports the current session right after subscribing.
      void Promise.resolve().then(() => listener('INITIAL_SESSION', mockAuth.session));
      return {
        data: { subscription: { unsubscribe: () => mockAuth.listeners.delete(listener) } },
      };
    },
    signInAnonymously: () => {
      mockAuth.anonymousSignIns += 1;
      const user: User = {
        id: `dddddddd-0000-4000-8000-${String(mockAuth.anonymousSignIns).padStart(12, '0')}`,
        is_anonymous: true,
        user_metadata: {},
        app_metadata: { provider: 'anonymous' },
      };
      mockAuth.session = sessionOf(user);
      mockProfiles[user.id] = 'learner';
      mockEmit('SIGNED_IN');
      return Promise.resolve({ data: { user, session: mockAuth.session }, error: null });
    },
    signOut: () => {
      mockAuth.session = null;
      mockEmit('SIGNED_OUT');
      return Promise.resolve({ error: null });
    },
  },
  storage: {
    from: () => ({
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${path}` } }),
    }),
  },
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    get auth() {
      return mockSupabase.auth;
    },
    get storage() {
      return mockSupabase.storage;
    },
    from: (table: string) => mockBuilder(table, 'select'),
    rpc: (fn: string, args?: Record<string, unknown>) => mockBuilder(fn, 'rpc', args),
  },
}));

// The root layout imports the NativeWind stylesheet, which Jest can't load.
jest.mock('../../global.css', () => ({}));

function sessionOf(user: User): Session {
  return { access_token: `token-${user.id}`, refresh_token: `refresh-${user.id}`, user };
}

// Seed-like content: Geografie with "Hauptstädte Europas" (two single
// choice questions) and "Flüsse" (no questions).
const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';
const EMPTY_QUIZ = '20000000-0000-4000-8000-000000000003';
const UNKNOWN_QUIZ = '20000000-0000-4000-8000-0000000000ff';
const UNKNOWN_CATEGORY = '10000000-0000-4000-8000-0000000000ff';
const FRANCE = 'Was ist die Hauptstadt von Frankreich?';
const ITALY = 'Was ist die Hauptstadt von Italien?';

function seed() {
  mockDb.categories = [
    { id: GEOGRAFIE, name: 'Geografie', description: null, sort_order: 1, published: true },
  ];
  mockDb.quizzes = [
    {
      id: HAUPTSTAEDTE,
      category_id: GEOGRAFIE,
      title: 'Hauptstädte Europas',
      description: null,
      sort_order: 1,
      published: true,
    },
    {
      id: EMPTY_QUIZ,
      category_id: GEOGRAFIE,
      title: 'Flüsse',
      description: null,
      sort_order: 2,
      published: true,
    },
  ];
  const question = (n: number, questionText: string) => ({
    id: `30000000-0000-4000-8000-00000000000${n}`,
    quiz_id: HAUPTSTAEDTE,
    text: questionText,
    image_path: null,
    image_alt: null,
    multiple_correct: false,
    explanation: null,
    sort_order: n,
  });
  const answer = (n: number, questionN: number, answerText: string, correct: boolean) => ({
    id: `40000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    question_id: `30000000-0000-4000-8000-00000000000${questionN}`,
    text: answerText,
    image_path: null,
    image_alt: null,
    is_correct: correct,
    sort_order: n,
  });
  mockDb.questions = [question(1, FRANCE), question(2, ITALY)];
  mockDb.answers = [
    answer(1, 1, 'Paris', true),
    answer(2, 1, 'Lyon', false),
    answer(3, 2, 'Rom', true),
    answer(4, 2, 'Mailand', false),
  ];
  mockDb.attempts = [];
  mockDb.submissions = [];
}

beforeEach(async () => {
  mockAuth.session = null;
  mockAuth.listeners.clear();
  mockAuth.anonymousSignIns = 0;
  for (const id of Object.keys(mockProfiles)) delete mockProfiles[id];
  mockProfiles[ADMIN.id] = 'admin';
  mockProfiles[LEARNER.id] = 'learner';
  mockProfiles[ANONYMOUS.id] = 'learner';
  for (const key of Object.keys(mockServer)) delete mockServer[key];
  mockHeld.length = 0;
  mockCalls.length = 0;
  seed();
  await i18n.changeLanguage('de');
});

afterEach(() => mockRelease());

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

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A navigation label as the header shows it: the text itself, optionally
// after a decorative arrow or cross ("← Kategorien", "✕ Quiz verlassen").
const navName = (label: string) => new RegExp(`^(?:[←✕×‹<]\\s*)?${escape(label)}$`);

function hostNodes(predicate: (node: TestInstance) => boolean): TestInstance[] {
  return screen.container.queryAll((node) => typeof node.type === 'string' && predicate(node));
}

const roleOf = (node: TestInstance) =>
  String(node.props.role ?? node.props.accessibilityRole ?? '');

// The header landmark (role banner). Screens a stack keeps mounted behind
// the current one come first, so the current screen's header is the last.
function header(): TestInstance {
  const banners = hostNodes((node) => roleOf(node) === 'banner');
  if (banners.length === 0) throw new Error('No element with role banner (the header)');
  return banners[banners.length - 1];
}

const findHeader = () => waitFor(() => header());

// A control in the header by its label; pressing the text presses the
// link or button around it.
function headerControl(label: string): TestInstance {
  const [match] = within(header()).queryAllByText(navName(label));
  if (!match) throw new Error(`The header has no control "${label}"`);
  return match;
}

const queryHeaderControl = (label: string): TestInstance | null =>
  within(header()).queryAllByText(navName(label))[0] ?? null;

// The confirmation dialog: a host view with role alertdialog or dialog.
function queryDialog(): TestInstance | null {
  const [dialog] = hostNodes((node) => /^(alertdialog|dialog)$/.test(roleOf(node)));
  return dialog ?? null;
}

const findDialog = () =>
  waitFor(() => {
    const dialog = queryDialog();
    if (!dialog) throw new Error('No element with role alertdialog or dialog');
    return dialog;
  });

const answerName = (answerText: string) =>
  new RegExp(`^${escape(answerText)}(?!\\w)|(?<!\\w)${escape(answerText)}$`);

async function startQuiz() {
  await fireEvent.press(await screen.findByRole('button', { name: text('quiz.start') }));
  expect(await screen.findByText(FRANCE)).toBeOnTheScreen();
}

async function answer(answerText: string) {
  await fireEvent.press(screen.getByRole('radio', { name: answerName(answerText) }));
  await fireEvent.press(screen.getByRole('button', { name: text('quiz.submit') }));
}

const submitCalls = () =>
  mockCalls.filter((call) => call.operation === 'rpc' && call.table === 'submit_answer');
const writes = () =>
  mockCalls.filter(
    (call) =>
      call.operation === 'insert' || call.operation === 'update' || call.operation === 'delete',
  );

describe('navigation texts', () => {
  // The Design's German wording; the English texts only need to exist.
  const wording: [string, string | RegExp][] = [
    ['nav.appName', /\S/],
    ['nav.categories', 'Kategorien'],
    ['nav.leaveQuiz', 'Quiz verlassen'],
    ['nav.leaveDialog.title', /\S/],
    ['nav.leaveDialog.message', 'Dein bisheriger Fortschritt in diesem Quiz geht verloren.'],
    ['nav.leaveDialog.confirm', /\S/],
    ['nav.leaveDialog.cancel', /\S/],
    ['nav.admin', 'Verwaltung'],
    ['nav.toApp', 'Zur App'],
    ['nav.signOut', 'Abmelden'],
    ['nav.breadcrumb.label', /\S/],
    ['nav.breadcrumb.categories', 'Kategorien'],
    ['nav.breadcrumb.preview', 'Vorschau'],
    ['nav.breadcrumb.question', 'Frage {{number}}'],
    ['nav.breadcrumb.loading', /\S/],
    ['nav.discardDialog.title', 'Änderungen verwerfen?'],
    ['nav.discardDialog.confirm', 'Verwerfen'],
    ['nav.discardDialog.cancel', 'Weiter bearbeiten'],
  ];

  it.each(wording)('%s has the German text of the Design and an English one', (key, german) => {
    if (typeof german === 'string') expect(text(key, 'de')).toBe(german);
    else expect(text(key, 'de')).toMatch(german);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('the confirm and cancel labels of the leave dialog differ', () => {
    expect(text('nav.leaveDialog.confirm', 'de')).not.toBe(text('nav.leaveDialog.cancel', 'de'));
    expect(text('nav.leaveDialog.confirm', 'en')).not.toBe(text('nav.leaveDialog.cancel', 'en'));
  });
});

describe('learner header: home (/)', () => {
  it('is a landmark with the app name linking home and no up link', async () => {
    const result = await renderAt('/');
    await screen.findByText('Geografie');
    await findHeader();

    expect(queryHeaderControl(text('nav.categories'))).toBeNull();
    expect(queryHeaderControl(text('nav.leaveQuiz'))).toBeNull();

    await fireEvent.press(headerControl(text('nav.appName')));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });

  it('shows its texts in English when the language is English', async () => {
    await i18n.changeLanguage('en');

    await renderAt('/categories/' + GEOGRAFIE);
    await findHeader();

    expect(headerControl(text('nav.appName', 'en'))).toBeOnTheScreen();
    expect(headerControl(text('nav.categories', 'en'))).toBeOnTheScreen();
  });
});

describe('learner header: category (/categories/[id])', () => {
  it('leads up to the category list when opened directly by URL', async () => {
    const result = await renderAt(`/categories/${GEOGRAFIE}`);
    await screen.findByText('Hauptstädte Europas');
    await findHeader();

    await fireEvent.press(headerControl(text('nav.categories')));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });

  it('shows the category name as the header title', async () => {
    await renderAt(`/categories/${GEOGRAFIE}`);
    await screen.findByText('Hauptstädte Europas');

    expect(within(await findHeader()).getByText('Geografie')).toBeOnTheScreen();
  });

  it('links the app name home', async () => {
    const result = await renderAt(`/categories/${GEOGRAFIE}`);
    await findHeader();

    await fireEvent.press(headerControl(text('nav.appName')));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });

  // #116 re-spec: was one test, "keeps the header with the up link while
  // loading, on an error and when not found", that rendered three router
  // trees without unmounting; expo-router's global routing queue then sent
  // the last tree's navigation to the first tree. Split into one test per
  // state, one tree each, with every assertion kept. The fresh mockServer
  // of each test replaces the old `delete mockServer['categories.select']`.
  it('keeps the header with the up link while loading', async () => {
    mockServer['categories.select'] = 'pending';
    await renderAt(`/categories/${GEOGRAFIE}`);
    expect(await screen.findByText(text('category.loading'))).toBeOnTheScreen();
    expect(headerControl(text('nav.categories'))).toBeOnTheScreen();
    mockRelease();
  });

  it('keeps the header with the up link on an error', async () => {
    mockServer['categories.select'] = { error: { code: '', message: 'Failed to fetch' } };
    await renderAt(`/categories/${GEOGRAFIE}`);
    expect(
      await screen.findByText(text('category.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(headerControl(text('nav.categories'))).toBeOnTheScreen();
  });

  it('keeps the header with the up link when not found, and the up link goes home', async () => {
    const result = await renderAt(`/categories/${UNKNOWN_CATEGORY}`);
    expect(await screen.findByText(text('category.notFound'))).toBeOnTheScreen();
    // The not-found state keeps its own link too.
    expect(screen.getByText(text('category.backToCategories'))).toBeOnTheScreen();
    await fireEvent.press(headerControl(text('nav.categories')));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });
});

describe('learner header: quiz intro (/quizzes/[id] before Start)', () => {
  it('shows "Quiz verlassen" with the quiz name and leaves for the quiz’s category without asking', async () => {
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await screen.findByRole('button', { name: text('quiz.start') });
    expect(within(await findHeader()).getByText('Hauptstädte Europas')).toBeOnTheScreen();

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe(`/categories/${GEOGRAFIE}`));
  });

  it('leaves without asking from the "no questions" state', async () => {
    const result = await renderAt(`/quizzes/${EMPTY_QUIZ}`);
    expect(await screen.findByText(text('quiz.noQuestions'))).toBeOnTheScreen();

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe(`/categories/${GEOGRAFIE}`));
  });

  it('keeps a single page heading with the quiz name: the header title is no second heading', async () => {
    await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await screen.findByRole('button', { name: text('quiz.start') });
    await findHeader();

    expect(screen.getAllByRole('heading', { name: 'Hauptstädte Europas' })).toHaveLength(1);
  });

  it('goes home from an unknown quiz, whose category is unknown, and keeps the not-found link', async () => {
    const result = await renderAt(`/quizzes/${UNKNOWN_QUIZ}`);
    expect(await screen.findByText(text('quiz.notFound'))).toBeOnTheScreen();
    expect(screen.getByText(text('quiz.backToCategories'))).toBeOnTheScreen();

    const header = await findHeader();
    const [leave] = within(header).queryAllByText(navName(text('nav.leaveQuiz')));
    const [up] = within(header).queryAllByText(navName(text('nav.categories')));
    const control = leave ?? up;
    if (!control) throw new Error('The header offers no way out of an unknown quiz');
    await fireEvent.press(control);
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });

  it('keeps the header with a way out while the quiz is loading', async () => {
    mockServer['quizzes.select'] = 'pending';
    await renderAt(`/quizzes/${HAUPTSTAEDTE}`);

    expect(await screen.findByText(text('quiz.loading'))).toBeOnTheScreen();
    await findHeader();
    expect(
      queryHeaderControl(text('nav.leaveQuiz')) ?? queryHeaderControl(text('nav.categories')),
    ).not.toBeNull();
  });
});

describe('learner header: quiz player', () => {
  it('leaves for the category without asking before the first answer', async () => {
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    // Picking without submitting doesn't count as an answer.
    await fireEvent.press(screen.getByRole('radio', { name: answerName('Paris') }));

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe(`/categories/${GEOGRAFIE}`));
  });

  it('shows the quiz name as the header title during play', async () => {
    await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await screen.findByRole('button', { name: text('quiz.next') });

    expect(within(header()).getByText('Hauptstädte Europas')).toBeOnTheScreen();
    expect(headerControl(text('nav.leaveQuiz'))).toBeOnTheScreen();
  });

  it('keeps at most one heading with the quiz name after an answer', async () => {
    await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await screen.findByRole('button', { name: text('quiz.next') });
    await findHeader();

    expect(
      screen.queryAllByRole('heading', { name: 'Hauptstädte Europas' }).length,
    ).toBeLessThanOrEqual(1);
  });

  it('asks for confirmation after the first answer, with the Design’s message', async () => {
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await screen.findByRole('button', { name: text('quiz.next') });

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));

    const dialog = await findDialog();
    expect(within(dialog).getByText(text('nav.leaveDialog.message'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe(`/quizzes/${HAUPTSTAEDTE}`);
  });

  it('stays in the quiz, at the same question, when the confirmation is cancelled', async () => {
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await fireEvent.press(await screen.findByRole('button', { name: text('quiz.next') }));
    await screen.findByText(ITALY);

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));
    const dialog = await findDialog();
    await fireEvent.press(within(dialog).getByText(text('nav.leaveDialog.cancel')));
    await flush();

    expect(queryDialog()).toBeNull();
    expect(result.getPathname()).toBe(`/quizzes/${HAUPTSTAEDTE}`);
    expect(screen.getByText(ITALY)).toBeOnTheScreen();
  });

  it('goes to the quiz’s category after confirming, without writing anything', async () => {
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await screen.findByRole('button', { name: text('quiz.next') });
    const callsBefore = mockCalls.filter((call) => call.operation === 'rpc').length;

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));
    const dialog = await findDialog();
    await fireEvent.press(within(dialog).getByText(text('nav.leaveDialog.confirm')));

    await waitFor(() => expect(result.getPathname()).toBe(`/categories/${GEOGRAFIE}`));
    // Abandoning the attempt calls no function and writes no row (no new
    // RPC, no client-side score).
    expect(mockCalls.filter((call) => call.operation === 'rpc')).toHaveLength(callsBefore);
    expect(writes()).toEqual([]);
    expect(mockDb.attempts[0].score).toBe(1);
  });

  it('asks while the first answer is still being sent', async () => {
    mockServer['rpc.submit_answer'] = 'pending';
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await waitFor(() => expect(submitCalls()).toHaveLength(1));

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));

    expect(await findDialog()).toBeTruthy();
    expect(result.getPathname()).toBe(`/quizzes/${HAUPTSTAEDTE}`);
  });

  it('doesn’t ask when a new attempt from Play again has no answer yet', async () => {
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await fireEvent.press(await screen.findByRole('button', { name: text('quiz.next') }));
    await screen.findByText(ITALY);
    await answer('Rom');
    await fireEvent.press(await screen.findByRole('button', { name: text('quiz.seeResult') }));
    await fireEvent.press(
      await screen.findByRole('button', { name: text('quiz.result.playAgain') }),
    );
    expect(await screen.findByText(FRANCE)).toBeOnTheScreen();
    await waitFor(() => expect(mockDb.attempts).toHaveLength(2));

    await fireEvent.press(headerControl(text('nav.leaveQuiz')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe(`/categories/${GEOGRAFIE}`));
  });
});

describe('learner header: quiz result', () => {
  async function playToResult() {
    const result = await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await startQuiz();
    await answer('Paris');
    await fireEvent.press(await screen.findByRole('button', { name: text('quiz.next') }));
    await screen.findByText(ITALY);
    await answer('Mailand');
    await fireEvent.press(await screen.findByRole('button', { name: text('quiz.seeResult') }));
    await screen.findByText(text('quiz.result.title'));
    return result;
  }

  it('switches the header to "← <category name>" with the quiz name, without "Quiz verlassen"', async () => {
    await playToResult();

    await waitFor(() => expect(queryHeaderControl('Geografie')).not.toBeNull());
    expect(queryHeaderControl(text('nav.leaveQuiz'))).toBeNull();
    expect(within(header()).getByText('Hauptstädte Europas')).toBeOnTheScreen();
  });

  it('keeps at most one heading with the quiz name on the result', async () => {
    await playToResult();
    await findHeader();

    expect(
      screen.queryAllByRole('heading', { name: 'Hauptstädte Europas' }).length,
    ).toBeLessThanOrEqual(1);
  });

  it('links the app name home from the result', async () => {
    const result = await playToResult();
    await findHeader();

    await fireEvent.press(headerControl(text('nav.appName')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });

  it('leads up to the quiz’s category without asking', async () => {
    const result = await playToResult();
    await waitFor(() => expect(queryHeaderControl('Geografie')).not.toBeNull());

    await fireEvent.press(headerControl('Geografie'));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe(`/categories/${GEOGRAFIE}`));
  });
});

describe('learner header: "Verwaltung" link', () => {
  async function renderCategory() {
    const result = await renderAt(`/categories/${GEOGRAFIE}`);
    await screen.findByText('Hauptstädte Europas');
    await findHeader();
    await flush();
    return result;
  }

  it('is hidden from a visitor without a session, without reading a profile', async () => {
    await renderCategory();

    expect(queryHeaderControl(text('nav.admin'))).toBeNull();
    expect(mockCalls.filter((call) => call.table === 'profiles')).toEqual([]);
  });

  it('is hidden from an anonymous user, whatever their metadata and profile say', async () => {
    // Even a profile row saying admin must not show the link to an anonymous
    // user: only the is_anonymous rule can hide it here.
    mockProfiles[ANONYMOUS.id] = 'admin';
    mockAuth.session = sessionOf(ANONYMOUS);

    await renderCategory();

    expect(queryHeaderControl(text('nav.admin'))).toBeNull();
    // An anonymous user is never an admin, so the header doesn't ask.
    expect(mockCalls.filter((call) => call.table === 'profiles')).toEqual([]);
  });

  it('is hidden from a learner whose JWT metadata claims admin', async () => {
    mockAuth.session = sessionOf(LEARNER);

    await renderCategory();

    expect(queryHeaderControl(text('nav.admin'))).toBeNull();
  });

  it('is shown to an admin, read from profiles.role, and leads to the category list', async () => {
    mockAuth.session = sessionOf(ADMIN);
    const result = await renderCategory();

    await waitFor(() => expect(queryHeaderControl(text('nav.admin'))).not.toBeNull());
    const profileReads = mockCalls.filter((call) => call.table === 'profiles');
    expect(profileReads.some((call) => /\brole\b/.test(call.select ?? ''))).toBe(true);

    await fireEvent.press(headerControl(text('nav.admin')));
    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('is shown to an admin on the home screen and in the quiz too', async () => {
    mockAuth.session = sessionOf(ADMIN);

    await renderAt('/');
    await findHeader();
    await waitFor(() => expect(queryHeaderControl(text('nav.admin'))).not.toBeNull());

    await renderAt(`/quizzes/${HAUPTSTAEDTE}`);
    await findHeader();
    await waitFor(() => expect(queryHeaderControl(text('nav.admin'))).not.toBeNull());
  });

  it('is hidden while the role is being read', async () => {
    mockAuth.session = sessionOf(ADMIN);
    mockServer['profiles.select'] = 'pending';

    await renderCategory();

    expect(queryHeaderControl(text('nav.admin'))).toBeNull();
  });

  it('is hidden when the role can’t be read', async () => {
    mockAuth.session = sessionOf(ADMIN);
    mockServer['profiles.select'] = { error: { code: '', message: 'Failed to fetch' } };

    await renderCategory();
    await flush();

    expect(queryHeaderControl(text('nav.admin'))).toBeNull();
  });

  it('disappears when the admin signs out', async () => {
    mockAuth.session = sessionOf(ADMIN);
    await renderCategory();
    await waitFor(() => expect(queryHeaderControl(text('nav.admin'))).not.toBeNull());

    await act(async () => {
      mockAuth.session = null;
      mockEmit('SIGNED_OUT');
    });

    await waitFor(() => expect(queryHeaderControl(text('nav.admin'))).toBeNull());
  });
});
