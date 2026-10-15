// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Issue #116, the admin side of the navigation, rendered through the real
// route tree in src/app with expo-router's renderRouter, behind the guard:
// - An admin header (role banner) on every guarded screen and on the
//   sign-in screen. Left: "Verwaltung", linking to the category list.
//   Right: "Zur App" (learner home) and "Abmelden" (signs out to the
//   learner area); the sign-in screen has no "Abmelden" and no breadcrumb,
//   and the guard's loading, error and no-access states have the header
//   with "Zur App" and "Abmelden" but no breadcrumb.
// - A breadcrumb (role navigation, with a label): Kategorien › Category ›
//   Quiz › Frage n / Vorschau / the form's title. Every segment but the
//   current one leads to its screen; the current one has aria-current
//   "page". On a phone only the parent ("← Parent") and the current title
//   show; on a wide window the whole chain. The parents come from the
//   Design's table, also when a screen is opened directly by URL. Names come
//   from the admin row selects; while they load, a neutral placeholder,
//   never an id. A form screen's current segment is its page title; the
//   edited entity is no extra level (quiz edit: Kategorien › Category ›
//   Quiz bearbeiten).
// - Leaving a changed form through the header or breadcrumb (including
//   "Zur App" and "Abmelden") asks "Änderungen verwerfen?" (Verwerfen /
//   Weiter bearbeiten); an unchanged form, one changed back to its loaded
//   values and saving don't ask.
//
// The window width is a device boundary: tests set it with
// Dimensions.set, phone 390 px and desktop 1280 px, like the e2e projects.
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack does to the seed admin: `from('categories' | 'quizzes' |
// 'questions' | 'answers')` are in-memory tables (an admin sees every row,
// anyone else only published content); `questions.explanation`,
// `answers.is_correct` and `*` on those tables are 42501 for every role;
// admin_question(), admin_answers() and save_question() are admin-only.
// Updates of categories and quizzes return the written ids. `profiles`:
// own row only, anon 42501. `mockServer['<table>.<operation>']` and
// `mockServer['rpc.<function>']` hold ('pending') or fail a request.
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

// A text with its placeholders filled in, through i18next. Checks the key exists first.
function label(key: string, values: Record<string, string | number> = {}) {
  text(key);
  return (i18n.t as (key: string, options: object) => string)(key, values);
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
  user_metadata: {},
  app_metadata: { provider: 'email' },
};

const mockAuth = {
  session: null as Session | null,
  listeners: new Set<Listener>(),
  signOuts: 0,
};
const mockProfiles: Record<string, 'learner' | 'admin'> = {};
const mockDb: Record<string, Row[]> = {
  categories: [],
  quizzes: [],
  questions: [],
  answers: [],
};
const mockServer: Record<string, ServerState> = {};
const mockHeld: (() => void)[] = [];
const mockCalls: Query[] = [];

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

const notAvailable: Result = { data: null, error: { code: 'P0001', message: 'not available' } };

// public.admin_question(question_id): one question with its explanation.
function mockAdminQuestion(args: Row): Result {
  if (!mockIsAdmin()) return notAvailable;
  const question = mockDb.questions.find((row) => row.id === args.question_id);
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

// public.admin_answers(question_id): its answers with is_correct, by sort_order.
function mockAdminAnswers(args: Row): Result {
  if (!mockIsAdmin()) return notAvailable;
  return {
    data: mockDb.answers
      .filter((row) => row.question_id === args.question_id)
      .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
      .map((row) => ({
        id: row.id,
        text: row.text,
        is_correct: row.is_correct,
        sort_order: row.sort_order,
      })),
    error: null,
  };
}

// public.save_question(...): only the text matters here; returns the id.
function mockSaveQuestion(args: Row): Result {
  if (!mockIsAdmin()) return { data: null, error: { code: '42501', message: 'permission denied' } };
  const question = mockDb.questions.find((row) => row.id === args.question_id);
  if (args.question_id != null && !question) return notAvailable;
  if (question) question.text = args.text;
  return { data: question?.id ?? '30000000-0000-4000-8000-0000000000aa', error: null };
}

// Inserts and updates of categories and quizzes by an admin; anything else
// is refused. Updates return the written ids.
function mockWrite(query: Query): Result {
  if (!mockIsAdmin() || !['categories', 'quizzes'].includes(query.table)) {
    return {
      data: null,
      error: { code: '42501', message: `permission denied for ${query.table}` },
    };
  }
  if (query.operation === 'insert') return { data: null, error: null };
  const found = (mockDb[query.table] ?? []).filter((row) => mockMatches(row, query, []));
  if (query.operation === 'update') {
    for (const row of found) Object.assign(row, query.values as Row);
  }
  return { data: found.map((row) => ({ id: row.id })), error: null };
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
      query.table === 'admin_question'
        ? mockAdminQuestion(args)
        : query.table === 'admin_answers'
          ? mockAdminAnswers(args)
          : query.table === 'save_question'
            ? mockSaveQuestion(args)
            : {
                data: null,
                error: { code: 'PGRST202', message: `Could not find the function ${query.table}` },
              };
  } else if (query.operation === 'select') {
    result = mockSelect(query);
  } else {
    result = mockWrite(query);
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
      // supabase-js reports the current session right after subscribing.
      void Promise.resolve().then(() => listener('INITIAL_SESSION', mockAuth.session));
      return {
        data: { subscription: { unsubscribe: () => mockAuth.listeners.delete(listener) } },
      };
    },
    signInWithPassword: (credentials: { email: string; password: string }) => {
      if (credentials.email !== ADMIN.email || credentials.password !== 'admin-password') {
        return Promise.resolve({
          data: { user: null, session: null },
          error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials' },
        });
      }
      mockAuth.session = sessionOf(ADMIN);
      mockEmit('SIGNED_IN');
      return Promise.resolve({ data: { user: ADMIN, session: mockAuth.session }, error: null });
    },
    signInAnonymously: () => {
      const user: User = {
        id: 'dddddddd-0000-4000-8000-000000000001',
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
      mockAuth.signOuts += 1;
      mockAuth.session = null;
      mockEmit('SIGNED_OUT');
      return Promise.resolve({ error: null });
    },
  },
  storage: {
    from: () => ({
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${path}` } }),
      upload: () => Promise.resolve({ data: null, error: null }),
      remove: () => Promise.resolve({ data: [], error: null }),
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

// The device's image picker, a boundary: an image pick is a change to a form.
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(() =>
    Promise.resolve({
      canceled: false,
      assets: [
        {
          uri: 'file:///picked/Dachs.webp',
          mimeType: 'image/webp',
          fileSize: 4096,
          fileName: 'Dachs.webp',
          width: 640,
          height: 480,
          type: 'image',
        },
      ],
    }),
  ),
  requestMediaLibraryPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' }),
  ),
}));

function sessionOf(user: User): Session {
  return { access_token: `token-${user.id}`, refresh_token: `refresh-${user.id}`, user };
}

// Content: Geografie with "Hauptstädte Europas", whose questions are stored
// out of order. By sort_order and then id, as the admin's list orders them:
// Spanien (1), Frankreich (2, smaller id), Italien (2) — Italien is "Frage 3".
const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';
const FRANCE = '30000000-0000-4000-8000-000000000003';
const ITALY = '30000000-0000-4000-8000-000000000004';
const SPAIN = '30000000-0000-4000-8000-000000000005';
const CATEGORY_NAME = 'Geografie';
const QUIZ_TITLE = 'Hauptstädte Europas';
const ITALY_TEXT = 'Was ist die Hauptstadt von Italien?';

function seed() {
  mockDb.categories = [
    { id: GEOGRAFIE, name: CATEGORY_NAME, description: null, sort_order: 1, published: true },
  ];
  mockDb.quizzes = [
    {
      id: HAUPTSTAEDTE,
      category_id: GEOGRAFIE,
      title: QUIZ_TITLE,
      description: null,
      sort_order: 1,
      published: false,
    },
  ];
  const question = (id: string, questionText: string, sortOrder: number) => ({
    id,
    quiz_id: HAUPTSTAEDTE,
    text: questionText,
    image_path: null,
    image_alt: null,
    multiple_correct: false,
    explanation: null,
    sort_order: sortOrder,
    created_at: '2026-10-01T00:00:00Z',
  });
  mockDb.questions = [
    question(ITALY, ITALY_TEXT, 2),
    question(SPAIN, 'Was ist die Hauptstadt von Spanien?', 1),
    question(FRANCE, 'Was ist die Hauptstadt von Frankreich?', 2),
  ];
  const answer = (n: number, questionId: string, answerText: string, correct: boolean) => ({
    id: `40000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    question_id: questionId,
    text: answerText,
    image_path: null,
    image_alt: null,
    is_correct: correct,
    sort_order: n,
    created_at: '2026-10-01T00:00:00Z',
  });
  mockDb.answers = [
    answer(1, ITALY, 'Rom', true),
    answer(2, ITALY, 'Mailand', false),
    answer(3, FRANCE, 'Paris', true),
    answer(4, FRANCE, 'Lyon', false),
    answer(5, SPAIN, 'Madrid', true),
    answer(6, SPAIN, 'Sevilla', false),
  ];
}

const PHONE = 390;
const DESKTOP = 1280;
const initialWindow = Dimensions.get('window');
const initialScreen = Dimensions.get('screen');

// The device's window width, a boundary like the network. Set before
// rendering, so no screen is listening yet.
function setWindowWidth(width: number) {
  Dimensions.set({
    window: { ...initialWindow, width, height: 844 },
    screen: { ...initialScreen, width, height: 844 },
  } as never);
}

beforeEach(async () => {
  mockAuth.session = sessionOf(ADMIN);
  mockAuth.listeners.clear();
  mockAuth.signOuts = 0;
  for (const id of Object.keys(mockProfiles)) delete mockProfiles[id];
  mockProfiles[ADMIN.id] = 'admin';
  mockProfiles[LEARNER.id] = 'learner';
  for (const key of Object.keys(mockServer)) delete mockServer[key];
  mockHeld.length = 0;
  mockCalls.length = 0;
  seed();
  setWindowWidth(DESKTOP);
  await i18n.changeLanguage('de');
});

afterEach(() => {
  mockRelease();
  Dimensions.set({ window: initialWindow, screen: initialScreen } as never);
});

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
// after a decorative arrow ("← Geografie").
const navName = (name: string) => new RegExp(`^(?:[←‹<]\\s*)?${escape(name)}$`);

function hostNodes(
  predicate: (node: TestInstance) => boolean,
  root: TestInstance = screen.container,
): TestInstance[] {
  return root.queryAll((node) => typeof node.type === 'string' && predicate(node));
}

const roleOf = (node: TestInstance) =>
  String(node.props.role ?? node.props.accessibilityRole ?? '');

// The last of several: screens a stack keeps mounted behind the current one
// come first in the tree.
const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

function header(): TestInstance {
  const banner = last(hostNodes((node) => roleOf(node) === 'banner'));
  if (!banner) throw new Error('No element with role banner (the header)');
  return banner;
}

const findHeader = () => waitFor(() => header());

const queryBreadcrumb = (): TestInstance | undefined =>
  last(hostNodes((node) => roleOf(node) === 'navigation'));

function breadcrumb(): TestInstance {
  const nav = queryBreadcrumb();
  if (!nav) throw new Error('No element with role navigation (the breadcrumb)');
  return nav;
}

const findBreadcrumb = () => waitFor(() => breadcrumb());

function inHeader(name: string): TestInstance {
  const [match] = within(header()).queryAllByText(navName(name));
  if (!match) throw new Error(`The header has no control "${name}"`);
  return match;
}

const queryInHeader = (name: string): TestInstance | null =>
  within(header()).queryAllByText(navName(name))[0] ?? null;

function segment(name: string): TestInstance {
  const [match] = within(breadcrumb()).queryAllByText(navName(name));
  if (!match) throw new Error(`The breadcrumb has no segment "${name}"`);
  return match;
}

const findSegment = (name: string) => waitFor(() => segment(name));

function textOf(node: TestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ');
}

// Hidden from sight and from assistive technology: display none, or an
// accessibility hiding prop on the node or an ancestor.
function isHidden(node: TestInstance): boolean {
  for (let current: TestInstance | null = node; current; current = current.parent) {
    const props = current.props;
    const styles = ([] as unknown[]).concat(props.style ?? []).flat(Infinity) as (
      Record<string, unknown> | null | undefined | false
    )[];
    if (styles.some((style) => style && style.display === 'none')) return true;
    if (
      props['aria-hidden'] === true ||
      props.accessibilityElementsHidden === true ||
      props.importantForAccessibility === 'no-hide-descendants'
    )
      return true;
  }
  return false;
}

// The node itself or an ancestor up to (and including) `root`.
function upTo(node: TestInstance, root: TestInstance): TestInstance[] {
  const chain: TestInstance[] = [];
  for (let current: TestInstance | null = node; current; current = current.parent) {
    chain.push(current);
    if (current === root) break;
  }
  return chain;
}

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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// The Design's parents. `chain` is the breadcrumb's linked segments from the
// top, each with the path it leads to; the last is the parent ("up").
// `current` is the current segment. `ready` is a text the screen shows once
// it has loaded.
type Crumb = { name: () => string; path: string };
type Route = { url: string; chain: Crumb[]; current: () => string; ready: () => string };

const categoriesCrumb: Crumb = {
  name: () => text('nav.breadcrumb.categories'),
  path: '/admin/categories',
};
const categoryCrumb: Crumb = { name: () => CATEGORY_NAME, path: `/admin/categories/${GEOGRAFIE}` };
const quizCrumb: Crumb = { name: () => QUIZ_TITLE, path: `/admin/quizzes/${HAUPTSTAEDTE}` };

const ROUTES: Route[] = [
  {
    url: '/admin/categories/new',
    chain: [categoriesCrumb],
    current: () => text('admin.categories.form.createTitle'),
    ready: () => text('admin.categories.form.name'),
  },
  {
    url: `/admin/categories/${GEOGRAFIE}/edit`,
    chain: [categoriesCrumb],
    current: () => text('admin.categories.form.editTitle'),
    ready: () => text('admin.categories.form.name'),
  },
  {
    url: `/admin/categories/${GEOGRAFIE}`,
    chain: [categoriesCrumb],
    current: () => CATEGORY_NAME,
    ready: () => text('admin.quizzes.create'),
  },
  {
    url: `/admin/categories/${GEOGRAFIE}/quizzes/new`,
    chain: [categoriesCrumb, categoryCrumb],
    current: () => text('admin.quizzes.form.createTitle'),
    ready: () => text('admin.quizzes.form.title'),
  },
  {
    url: `/admin/quizzes/${HAUPTSTAEDTE}`,
    chain: [categoriesCrumb, categoryCrumb],
    current: () => QUIZ_TITLE,
    ready: () => text('admin.questions.create'),
  },
  {
    url: `/admin/quizzes/${HAUPTSTAEDTE}/edit`,
    chain: [categoriesCrumb, categoryCrumb],
    current: () => text('admin.quizzes.form.editTitle'),
    ready: () => text('admin.quizzes.form.title'),
  },
  {
    url: `/admin/quizzes/${HAUPTSTAEDTE}/questions/new`,
    chain: [categoriesCrumb, categoryCrumb, quizCrumb],
    current: () => text('admin.questions.form.createTitle'),
    ready: () => text('admin.questions.form.text'),
  },
  {
    url: `/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}`,
    chain: [categoriesCrumb, categoryCrumb, quizCrumb],
    current: () => label('nav.breadcrumb.question', { number: 3 }),
    ready: () => text('admin.questions.form.text'),
  },
  {
    url: `/admin/quizzes/${HAUPTSTAEDTE}/preview`,
    chain: [categoriesCrumb, categoryCrumb, quizCrumb],
    current: () => text('nav.breadcrumb.preview'),
    ready: () => text('admin.preview.marker'),
  },
];

const GUARDED_URLS = ['/admin/categories', ...ROUTES.map((route) => route.url)];

async function renderReady(route: Route) {
  const result = await renderAt(route.url);
  // A label, a button or a plain text, whichever the screen shows.
  await waitFor(() =>
    expect(
      screen.queryAllByText(route.ready()).length +
        screen.queryAllByLabelText(route.ready()).length,
    ).toBeGreaterThan(0),
  );
  await flush();
  return result;
}

// Every linked segment of the chain at desktop width: [url, segment, path].
const CHAIN_LINKS = ROUTES.flatMap((route) =>
  route.chain.map((crumb) => [route.url, crumb, route] as const),
);

describe('admin breadcrumb: up to the logical parent, opened directly by URL', () => {
  it.each(ROUTES.map((route) => [route.url, route] as const))(
    '%s: on a phone, "← parent" leads to the parent from the Design’s table',
    async (_url, route) => {
      setWindowWidth(PHONE);
      const result = await renderReady(route);
      const parent = route.chain[route.chain.length - 1];
      await findSegment(parent.name());

      // Only the parent and the current title, so it never wraps: no
      // visible segment for any other ancestor.
      for (const ancestor of route.chain.slice(0, -1)) {
        const visible = within(breadcrumb())
          .queryAllByText(navName(ancestor.name()))
          .filter((node) => !isHidden(node));
        expect(visible).toEqual([]);
      }
      const titles = [
        ...within(breadcrumb()).queryAllByText(navName(route.current())),
        ...within(header()).queryAllByText(navName(route.current())),
      ].filter((node) => !isHidden(node));
      expect(titles.length).toBeGreaterThan(0);

      await fireEvent.press(segment(parent.name()));

      await waitFor(() => expect(result.getPathname()).toBe(parent.path));
    },
  );

  it.each(CHAIN_LINKS.map(([url, crumb, route]) => [url, crumb.path, crumb, route] as const))(
    '%s: on a wide window, the segment for %s leads there',
    async (_url, _path, crumb, route) => {
      const result = await renderReady(route);

      await fireEvent.press(await findSegment(crumb.name()));

      await waitFor(() => expect(result.getPathname()).toBe(crumb.path));
    },
  );

  it.each(ROUTES.map((route) => [route.url, route] as const))(
    '%s: the current segment is marked aria-current="page" and is no link',
    async (_url, route) => {
      await renderReady(route);
      const nav = await findBreadcrumb();

      const current = await findSegment(route.current());
      const chain = upTo(current, nav);
      expect(chain.some((node) => node.props['aria-current'] === 'page')).toBe(true);
      expect(chain.some((node) => node.props.href !== undefined || roleOf(node) === 'link')).toBe(
        false,
      );
    },
  );

  it('shows only "Kategorien" as the current segment on the category list', async () => {
    await renderAt('/admin/categories');
    await screen.findByText(CATEGORY_NAME);
    const nav = await findBreadcrumb();

    const current = await findSegment(text('nav.breadcrumb.categories'));
    expect(upTo(current, nav).some((node) => node.props['aria-current'] === 'page')).toBe(true);
    expect(within(nav).queryAllByText(navName(CATEGORY_NAME))).toEqual([]);
  });

  it('labels the breadcrumb as a navigation landmark', async () => {
    await renderReady(ROUTES[ROUTES.length - 1]);
    const nav = await findBreadcrumb();

    expect(nav.props['aria-label'] ?? nav.props.accessibilityLabel).toBe(
      text('nav.breadcrumb.label'),
    );
  });

  it('numbers a question by its place in the admin’s list (sort_order, then id)', async () => {
    await renderAt(`/admin/quizzes/${HAUPTSTAEDTE}/questions/${FRANCE}`);

    expect(await findSegment(label('nav.breadcrumb.question', { number: 2 }))).toBeTruthy();
  });

  it('shows only one "← parent" on a phone when the question isn’t in the quiz', async () => {
    setWindowWidth(PHONE);
    const missing = '30000000-0000-4000-8000-0000000000ff';
    await renderAt(`/admin/quizzes/${HAUPTSTAEDTE}/questions/${missing}`);
    await findSegment(QUIZ_TITLE);
    for (let i = 0; i < 5; i += 1) await flush();

    const category = within(breadcrumb())
      .queryAllByText(navName(CATEGORY_NAME))
      .filter((node) => !isHidden(node));
    expect(category.map(textOf)).toEqual([]);
  });

  it('keeps a long parent name on one line on a phone', async () => {
    setWindowWidth(PHONE);
    await renderReady(ROUTES[ROUTES.length - 1]);

    const parent = await findSegment(QUIZ_TITLE);

    expect(parent.props.numberOfLines).toBe(1);
  });

  it('gives the preview a way back to its quiz', async () => {
    setWindowWidth(PHONE);
    const result = await renderAt(`/admin/quizzes/${HAUPTSTAEDTE}/preview`);
    await screen.findByText(ITALY_TEXT.replace('Italien', 'Spanien'));

    await fireEvent.press(await findSegment(QUIZ_TITLE));

    await waitFor(() => expect(result.getPathname()).toBe(`/admin/quizzes/${HAUPTSTAEDTE}`));
  });

  it('shows a neutral placeholder, never an id, while the names load', async () => {
    mockServer['quizzes.select'] = 'pending';
    mockServer['categories.select'] = 'pending';
    await renderAt(`/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}`);
    const nav = await findBreadcrumb();
    await flush();

    expect(textOf(nav)).not.toMatch(UUID);
    expect(textOf(header())).not.toMatch(UUID);
    expect(within(nav).queryAllByText(text('nav.breadcrumb.loading')).length).toBeGreaterThan(0);
  });

  it('shows no id in the header or breadcrumb when the names fail to load', async () => {
    const failure = { error: { code: '', message: 'Failed to fetch' } };
    mockServer['quizzes.select'] = failure;
    mockServer['categories.select'] = failure;
    await renderAt(`/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}`);
    await findHeader();
    for (let i = 0; i < 5; i += 1) await flush();

    expect(textOf(header())).not.toMatch(UUID);
    const nav = queryBreadcrumb();
    if (nav) expect(textOf(nav)).not.toMatch(UUID);
  });

  // Without a quiz there is no category to name: the segment is left out,
  // not a placeholder that never resolves.
  const MISSING_QUIZ = '20000000-0000-4000-8000-0000000000ff';
  const QUIZ_UNREADABLE = [
    [
      'fails to load',
      HAUPTSTAEDTE,
      () => {
        mockServer['quizzes.select'] = { error: { code: '', message: 'Failed to fetch' } };
      },
    ],
    ['doesn’t exist', MISSING_QUIZ, () => {}],
  ] as const;

  it.each(QUIZ_UNREADABLE)(
    'leaves the category out when the quiz %s, without a lasting placeholder',
    async (_case, quizId, arrange) => {
      arrange();
      await renderAt(`/admin/quizzes/${quizId}/questions/${ITALY}`);
      await findSegment(text('nav.breadcrumb.categories'));
      for (let i = 0; i < 5; i += 1) await flush();

      const nav = breadcrumb();
      expect(
        within(nav)
          .queryAllByText(navName(text('nav.breadcrumb.loading')))
          .map(textOf),
      ).toEqual([]);
      const links = hostNodes((node) => roleOf(node) === 'link', nav).filter(
        (node) => !isHidden(node),
      );
      expect(links.map((node) => textOf(node).replace('←', '').trim())).toEqual([
        text('nav.breadcrumb.categories'),
      ]);
    },
  );

  it.each(QUIZ_UNREADABLE)(
    'on a phone, leads up to "Kategorien" when the quiz %s',
    async (_case, quizId, arrange) => {
      setWindowWidth(PHONE);
      arrange();
      const result = await renderAt(`/admin/quizzes/${quizId}`);
      // While the quiz loads, the phone shows its placeholder, not "Kategorien".
      for (let i = 0; i < 5; i += 1) await flush();
      await findSegment(text('nav.breadcrumb.categories'));

      expect(within(breadcrumb()).queryAllByText(navName(text('nav.breadcrumb.loading')))).toEqual(
        [],
      );

      await fireEvent.press(segment(text('nav.breadcrumb.categories')));

      await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
    },
  );

  it('shows its texts in English when the language is English', async () => {
    await i18n.changeLanguage('en');

    await renderReady(ROUTES[ROUTES.length - 1]);

    expect(await findSegment(text('nav.breadcrumb.categories', 'en'))).toBeTruthy();
    expect(segment(text('nav.breadcrumb.preview', 'en'))).toBeTruthy();
    expect(inHeader(text('nav.admin', 'en'))).toBeTruthy();
    expect(inHeader(text('nav.toApp', 'en'))).toBeTruthy();
    expect(inHeader(text('nav.signOut', 'en'))).toBeTruthy();
  });
});

describe('admin header', () => {
  it.each(GUARDED_URLS)('%s has "Verwaltung", "Zur App" and "Abmelden"', async (url) => {
    await renderAt(url);
    await findHeader();
    await flush();

    expect(inHeader(text('nav.admin'))).toBeTruthy();
    expect(inHeader(text('nav.toApp'))).toBeTruthy();
    expect(inHeader(text('nav.signOut'))).toBeTruthy();
  });

  it('"Verwaltung" leads to the category list', async () => {
    const result = await renderAt(`/admin/quizzes/${HAUPTSTAEDTE}/preview`);
    await findHeader();

    await fireEvent.press(inHeader(text('nav.admin')));

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('"Zur App" leads to the learner home', async () => {
    const result = await renderAt(`/admin/categories/${GEOGRAFIE}`);
    await findHeader();

    await fireEvent.press(inHeader(text('nav.toApp')));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(mockAuth.signOuts).toBe(0);
  });

  it('"Abmelden" signs out to the learner area', async () => {
    const result = await renderAt(`/admin/quizzes/${HAUPTSTAEDTE}`);
    await findHeader();

    await fireEvent.press(inHeader(text('nav.signOut')));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(mockAuth.signOuts).toBe(1);
    expect(mockAuth.session?.user.id).not.toBe(ADMIN.id);
  });

  it('is on the sign-in screen with "Verwaltung" and "Zur App", without "Abmelden" or a breadcrumb', async () => {
    mockAuth.session = null;
    const result = await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));
    await findHeader();

    expect(inHeader(text('nav.admin'))).toBeTruthy();
    expect(queryInHeader(text('nav.signOut'))).toBeNull();
    expect(queryBreadcrumb()).toBeUndefined();

    await fireEvent.press(inHeader(text('nav.toApp')));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });

  describe('in the guard’s states, without a breadcrumb', () => {
    async function expectGuardHeader() {
      await findHeader();
      expect(inHeader(text('nav.toApp'))).toBeTruthy();
      expect(inHeader(text('nav.signOut'))).toBeTruthy();
      expect(queryBreadcrumb()).toBeUndefined();
    }

    it('while the role is being read', async () => {
      mockServer['profiles.select'] = 'pending';
      await renderAt(`/admin/categories/${GEOGRAFIE}`);
      expect(await screen.findByText(text('admin.guard.loading'))).toBeOnTheScreen();

      await expectGuardHeader();
    });

    it('when the role can’t be read', async () => {
      mockServer['profiles.select'] = { error: { code: '', message: 'Failed to fetch' } };
      await renderAt(`/admin/categories/${GEOGRAFIE}`);
      expect(
        await screen.findByText(text('admin.guard.error'), {}, { timeout: 15_000 }),
      ).toBeOnTheScreen();

      await expectGuardHeader();
    });

    it('for a learner without access, who can sign out from the header', async () => {
      mockAuth.session = sessionOf(LEARNER);
      const result = await renderAt(`/admin/categories/${GEOGRAFIE}`);
      expect(await screen.findByText(text('admin.guard.noAccess'))).toBeOnTheScreen();
      await expectGuardHeader();

      await fireEvent.press(inHeader(text('nav.signOut')));

      await waitFor(() => expect(result.getPathname()).toBe('/'));
      expect(mockAuth.signOuts).toBe(1);
    });
  });
});

describe('leaving a changed admin form', () => {
  const editCategoryUrl = `/admin/categories/${GEOGRAFIE}/edit`;
  const nameField = () => screen.getByLabelText(text('admin.categories.form.name'));

  async function openEditCategory() {
    const result = await renderAt(editCategoryUrl);
    await screen.findByDisplayValue(CATEGORY_NAME);
    await findBreadcrumb();
    return result;
  }

  it('leaves an unchanged form through the breadcrumb without asking', async () => {
    const result = await openEditCategory();

    await fireEvent.press(segment(text('nav.breadcrumb.categories')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('leaves an unchanged form through the header’s "Zur App" without asking', async () => {
    const result = await openEditCategory();

    await fireEvent.press(inHeader(text('nav.toApp')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe('/'));
  });

  it('leaves an unchanged form through the header’s "Verwaltung" without asking', async () => {
    const result = await openEditCategory();

    await fireEvent.press(inHeader(text('nav.admin')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('asks "Änderungen verwerfen?" when a changed form is left through the breadcrumb', async () => {
    const result = await openEditCategory();
    await fireEvent.changeText(nameField(), 'Erdkunde');

    await fireEvent.press(segment(text('nav.breadcrumb.categories')));

    const dialog = await findDialog();
    expect(within(dialog).getByText(text('nav.discardDialog.title'))).toBeOnTheScreen();
    expect(within(dialog).getByText(text('nav.discardDialog.confirm'))).toBeOnTheScreen();
    expect(within(dialog).getByText(text('nav.discardDialog.cancel'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe(editCategoryUrl);
  });

  it('"Weiter bearbeiten" stays on the form with the input kept', async () => {
    const result = await openEditCategory();
    await fireEvent.changeText(nameField(), 'Erdkunde');
    await fireEvent.press(segment(text('nav.breadcrumb.categories')));

    await fireEvent.press(within(await findDialog()).getByText(text('nav.discardDialog.cancel')));
    await flush();

    expect(queryDialog()).toBeNull();
    expect(result.getPathname()).toBe(editCategoryUrl);
    expect(nameField().props.value).toBe('Erdkunde');
  });

  it('"Verwerfen" goes where the breadcrumb led, without saving', async () => {
    const result = await openEditCategory();
    await fireEvent.changeText(nameField(), 'Erdkunde');
    await fireEvent.press(segment(text('nav.breadcrumb.categories')));

    await fireEvent.press(within(await findDialog()).getByText(text('nav.discardDialog.confirm')));

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
    expect(mockCalls.filter((call) => call.operation === 'update')).toEqual([]);
    expect(mockDb.categories[0].name).toBe(CATEGORY_NAME);
  });

  it('doesn’t ask when the form was changed back to its loaded values', async () => {
    const result = await openEditCategory();
    await fireEvent.changeText(nameField(), 'Erdkunde');
    await fireEvent.changeText(nameField(), CATEGORY_NAME);

    await fireEvent.press(segment(text('nav.breadcrumb.categories')));
    await flush();

    expect(queryDialog()).toBeNull();
    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('asks before leaving through the header, then not after saving', async () => {
    const result = await openEditCategory();
    await fireEvent.changeText(nameField(), 'Erdkunde');

    await fireEvent.press(inHeader(text('nav.admin')));
    await fireEvent.press(within(await findDialog()).getByText(text('nav.discardDialog.cancel')));
    await flush();
    await fireEvent.press(screen.getByRole('button', { name: text('admin.categories.form.save') }));

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
    expect(queryDialog()).toBeNull();
    expect(mockDb.categories[0].name).toBe('Erdkunde');
  });

  it('asks before "Zur App" leaves a changed new-category form', async () => {
    const result = await renderAt('/admin/categories/new');
    await fireEvent.changeText(
      await screen.findByLabelText(text('admin.categories.form.name')),
      'Musik',
    );
    await findHeader();

    await fireEvent.press(inHeader(text('nav.toApp')));

    expect(await findDialog()).toBeTruthy();
    expect(result.getPathname()).toBe('/admin/categories/new');
  });

  it('asks before "Abmelden" signs out of a changed quiz form, and signs out after "Verwerfen"', async () => {
    const url = `/admin/quizzes/${HAUPTSTAEDTE}/edit`;
    const result = await renderAt(url);
    await fireEvent.changeText(await screen.findByDisplayValue(QUIZ_TITLE), 'Hauptstädte');
    await findHeader();

    await fireEvent.press(inHeader(text('nav.signOut')));
    const dialog = await findDialog();
    expect(mockAuth.signOuts).toBe(0);
    expect(result.getPathname()).toBe(url);

    await fireEvent.press(within(dialog).getByText(text('nav.discardDialog.confirm')));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(mockAuth.signOuts).toBe(1);
  });

  it('asks when a changed answer would be lost through the quiz’s breadcrumb segment', async () => {
    const url = `/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}`;
    const result = await renderAt(url);
    await fireEvent.changeText(
      await screen.findByLabelText(label('admin.questions.form.answers.text', { number: 1 })),
      'Neapel',
    );

    await fireEvent.press(await findSegment(QUIZ_TITLE));

    expect(await findDialog()).toBeTruthy();
    expect(result.getPathname()).toBe(url);
  });

  it('asks when a changed new-quiz form would be lost through the category segment', async () => {
    const url = `/admin/categories/${GEOGRAFIE}/quizzes/new`;
    const result = await renderAt(url);
    await fireEvent.changeText(
      await screen.findByLabelText(text('admin.quizzes.form.title')),
      'Flüsse Europas',
    );

    await fireEvent.press(await findSegment(CATEGORY_NAME));

    expect(await findDialog()).toBeTruthy();
    expect(result.getPathname()).toBe(url);
    expect(mockDb.quizzes).toHaveLength(1);
  });

  it('counts an image pick as a change and asks before the quiz’s segment leaves it', async () => {
    const url = `/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}`;
    const result = await renderAt(url);
    await screen.findByLabelText(text('admin.questions.form.text'));
    await findBreadcrumb();

    await fireEvent.press(
      await screen.findByRole('button', { name: text('admin.questions.form.image.pick') }),
    );
    await flush();

    await fireEvent.press(await findSegment(QUIZ_TITLE));

    expect(await findDialog()).toBeTruthy();
    expect(result.getPathname()).toBe(url);
  });

  it('asks when a new question with text would be lost through the category segment', async () => {
    const url = `/admin/quizzes/${HAUPTSTAEDTE}/questions/new`;
    const result = await renderAt(url);
    await fireEvent.changeText(
      await screen.findByLabelText(text('admin.questions.form.text')),
      'Was ist die Hauptstadt von Polen?',
    );

    await fireEvent.press(await findSegment(CATEGORY_NAME));

    expect(await findDialog()).toBeTruthy();
    expect(result.getPathname()).toBe(url);
  });
});
