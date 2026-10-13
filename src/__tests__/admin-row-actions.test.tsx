// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Issue #117, short action labels in the admin lists, rendered through the
// real route tree in src/app with expo-router's renderRouter, behind the
// guard. In the category list, a category's quiz list and a quiz's question
// list, every row action shows a short label from i18next (the issue's
// table) and keeps an accessible name "<visible label>: <row name>" that
// starts with that label (WCAG 2.5.3) and names its row, so two rows'
// buttons stay apart. The move buttons show a decorative arrow ("↑ Nach
// oben"); their name starts with the word label ("Nach oben: Geografie").
// The actions come in the order navigate (Quizze / Fragen / Vorschau), edit,
// publish state, move, delete last. A quiz row gets a "Vorschau" link to the
// quiz's preview; the question list's page-level preview link is shortened
// the same way. The answers' actions in the question form are covered in
// src/components/__tests__/question-form-answer-actions.test.tsx.
//
// The accessible names come from the action keys the screens already use
// (admin.categories.actions.edit with {name}, …), now "Bearbeiten: {{name}}",
// so every existing lookup by key still finds the row's own button.
//
// Boundary: the Supabase client (network), the same fake as
// navigation-admin.test.tsx: `from('categories' | 'quizzes' | 'questions' |
// 'answers')` are in-memory tables (an admin sees every row);
// `questions.explanation`, `answers.is_correct` and `*` on those tables are
// 42501; admin_question(), admin_answers() and save_question() are
// admin-only.

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

// Content: Geografie (published) and Musik (draft); in Geografie the quizzes
// Hauptstädte Europas (draft) and Flüsse Europas (published); in Hauptstädte
// Europas three questions.
const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const MUSIK = '10000000-0000-4000-8000-000000000002';
const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';
const FLUESSE = '20000000-0000-4000-8000-000000000002';
const CATEGORY = 'Geografie';
const OTHER_CATEGORY = 'Musik';
const QUIZ = 'Hauptstädte Europas';
const OTHER_QUIZ = 'Flüsse Europas';
const QUESTIONS = [
  'Was ist die Hauptstadt von Spanien?',
  'Was ist die Hauptstadt von Frankreich?',
  'Was ist die Hauptstadt von Italien?',
];

function seed() {
  mockDb.categories = [
    { id: GEOGRAFIE, name: CATEGORY, description: null, sort_order: 1, published: true },
    { id: MUSIK, name: OTHER_CATEGORY, description: null, sort_order: 2, published: false },
  ];
  mockDb.quizzes = [
    {
      id: HAUPTSTAEDTE,
      category_id: GEOGRAFIE,
      title: QUIZ,
      description: null,
      sort_order: 1,
      published: false,
    },
    {
      id: FLUESSE,
      category_id: GEOGRAFIE,
      title: OTHER_QUIZ,
      description: null,
      sort_order: 2,
      published: true,
    },
  ];
  mockDb.questions = QUESTIONS.map((questionText, index) => ({
    id: `30000000-0000-4000-8000-00000000000${index + 1}`,
    quiz_id: HAUPTSTAEDTE,
    text: questionText,
    image_path: null,
    image_alt: null,
    multiple_correct: false,
    explanation: null,
    sort_order: index + 1,
    created_at: '2026-10-01T00:00:00Z',
  }));
  mockDb.answers = [];
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
  await i18n.changeLanguage('de');
});

afterEach(async () => {
  mockRelease();
  await i18n.changeLanguage('de');
});

async function renderAt(url: string): Promise<{ getPathname(): string }> {
  const result = renderRouter('src/app', { initialUrl: url });
  await result;
  return { getPathname: () => result.getPathname() };
}

function hostNodes(
  predicate: (node: TestInstance) => boolean,
  root: TestInstance = screen.container,
): TestInstance[] {
  return root.queryAll((node) => typeof node.type === 'string' && predicate(node));
}

const roleOf = (node: TestInstance) =>
  String(node.props.role ?? node.props.accessibilityRole ?? '');

const isAction = (node: TestInstance) => /^(button|link)$/.test(roleOf(node));

function textOf(node: TestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ');
}

// What a sighted user reads on a control.
const visibleText = (node: TestInstance) => textOf(node).replace(/\s+/g, ' ').trim();

// What a screen reader announces: the aria-label, else the text.
const accessibleName = (node: TestInstance) =>
  String(node.props['aria-label'] ?? node.props.accessibilityLabel ?? visibleText(node));

// The visible label without the move buttons' decorative arrow: the part the
// accessible name starts with.
const spoken = (label: string) => label.replace(/^[↑↓]\s*/u, '');

function insideAction(node: TestInstance): boolean {
  for (let current: TestInstance | null = node.parent; current; current = current.parent) {
    if (isAction(current)) return true;
  }
  return false;
}

// The row (card) whose title shows `title`: the closest ancestor of the
// title that holds actions.
function row(title: string): TestInstance {
  const [titleNode] = hostNodes(
    (node) =>
      roleOf(node) !== 'heading' &&
      !isAction(node) &&
      !insideAction(node) &&
      node.children.some((child) => typeof child === 'string') &&
      visibleText(node) === title,
  );
  if (!titleNode) throw new Error(`No row titled "${title}"`);
  for (let current: TestInstance | null = titleNode.parent; current; current = current.parent) {
    if (hostNodes(isAction, current).length > 0) return current;
  }
  throw new Error(`The row "${title}" has no actions`);
}

// The row's buttons and links in screen order, which is also the tab order.
const rowActions = (title: string) => hostNodes(isAction, row(title));

const findRow = (title: string) => waitFor(() => row(title));

type Expected = { label: string; key: string | null };

// The row's actions as the issue's table and order want them, in German:
// the visible label and the key of its accessible name (null: an action
// this slice adds, without a key yet).
function categoryActions(published: boolean): Expected[] {
  return [
    { label: 'Quizze', key: 'admin.categories.actions.quizzes' },
    { label: 'Bearbeiten', key: 'admin.categories.actions.edit' },
    published
      ? { label: 'Zurückziehen', key: 'admin.categories.actions.unpublish' }
      : { label: 'Veröffentlichen', key: 'admin.categories.actions.publish' },
    { label: '↑ Nach oben', key: 'admin.categories.actions.moveUp' },
    { label: '↓ Nach unten', key: 'admin.categories.actions.moveDown' },
    { label: 'Löschen', key: 'admin.categories.actions.delete' },
  ];
}

function quizActions(published: boolean): Expected[] {
  return [
    { label: 'Fragen', key: 'admin.quizzes.actions.questions' },
    { label: 'Vorschau', key: null },
    { label: 'Bearbeiten', key: 'admin.quizzes.actions.edit' },
    published
      ? { label: 'Zurückziehen', key: 'admin.quizzes.actions.unpublish' }
      : { label: 'Veröffentlichen', key: 'admin.quizzes.actions.publish' },
    { label: '↑ Nach oben', key: 'admin.quizzes.actions.moveUp' },
    { label: '↓ Nach unten', key: 'admin.quizzes.actions.moveDown' },
    { label: 'Löschen', key: 'admin.quizzes.actions.delete' },
  ];
}

const questionActions: Expected[] = [
  { label: 'Bearbeiten', key: 'admin.questions.actions.edit' },
  { label: '↑ Nach oben', key: 'admin.questions.actions.moveUp' },
  { label: '↓ Nach unten', key: 'admin.questions.actions.moveDown' },
  { label: 'Löschen', key: 'admin.questions.actions.delete' },
];

// German: the visible labels are the table's, in the row order; every name
// is "<label without arrow>: <row>" and is what the action's key gives.
function expectGermanRow(title: string, expected: Expected[]) {
  const actions = rowActions(title);
  expect(actions.map(accessibleName)).toEqual(
    expected.map((action) => `${spoken(action.label)}: ${title}`),
  );
  expect(actions.map(visibleText)).toEqual(expected.map((action) => action.label));
  expected.forEach((action, index) => {
    if (action.key)
      expect(accessibleName(actions[index]!)).toBe(label(action.key, { name: title }));
  });
}

// English: the labels come from en.json (not the German ones) and are short
// (the row's name isn't in them), each name still starts with its visible
// label and names the row, and is what the action's key gives in English.
// Returns the row's visible labels.
function expectEnglishRow(title: string, expected: Expected[]): string[] {
  const actions = rowActions(title);
  expect(actions).toHaveLength(expected.length);
  return expected.map((action, index) => {
    const node = actions[index]!;
    const shownLabel = visibleText(node);
    expect(shownLabel).not.toBe(action.label);
    expect(shownLabel).not.toContain(title);
    if (action.label.startsWith('↑')) expect(shownLabel).toMatch(/^↑ \S/u);
    if (action.label.startsWith('↓')) expect(shownLabel).toMatch(/^↓ \S/u);
    expect(accessibleName(node)).toBe(`${spoken(shownLabel)}: ${title}`);
    if (action.key) expect(accessibleName(node)).toBe(label(action.key, { name: title }));
    return shownLabel;
  });
}

// English on several rows: each row as above, and an action shows the same
// label on every row (a short label, not one made from the row).
function expectEnglishRows(rows: [title: string, expected: Expected[]][]) {
  const shownFor = new Map<string, string>();
  for (const [title, expected] of rows) {
    const labels = expectEnglishRow(title, expected);
    expected.forEach((action, index) => {
      const before = shownFor.get(action.label);
      if (before === undefined) shownFor.set(action.label, labels[index]!);
      else expect(labels[index]).toBe(before);
    });
  }
}

// Two rows' actions with the same visible label are different elements
// (role names match exactly in Testing Library),
// each found by its full name in its own row, and the label shows once per
// row; the row's name shows once, as its title.
function expectRowsApart(role: 'button' | 'link', shortLabel: string, titles: string[]) {
  const found = titles.map((title) =>
    screen.getByRole(role, { name: `${spoken(shortLabel)}: ${title}` }),
  );
  expect(new Set(found).size).toBe(titles.length);
  titles.forEach((title, index) => {
    expect(rowActions(title)).toContain(found[index]);
    expect(within(row(title)).getAllByText(shortLabel, { exact: true })).toHaveLength(1);
    expect(screen.getAllByText(title, { exact: true })).toHaveLength(1);
  });
}

describe('category list: row actions', () => {
  it('shows each row the short labels from the table, in the order navigate, edit, publish state, move, delete', async () => {
    await renderAt('/admin/categories');
    await findRow(CATEGORY);

    expect(rowActions(CATEGORY).map(visibleText)).toEqual(
      categoryActions(true).map((action) => action.label),
    );
    expect(rowActions(OTHER_CATEGORY).map(visibleText)).toEqual(
      categoryActions(false).map((action) => action.label),
    );
  });

  it('names every action "<label>: <category>", starting with its visible label', async () => {
    await renderAt('/admin/categories');
    await findRow(CATEGORY);

    expectGermanRow(CATEGORY, categoryActions(true));
    expectGermanRow(OTHER_CATEGORY, categoryActions(false));
  });

  it("keeps two rows' actions apart: each row's own button by its full name", async () => {
    await renderAt('/admin/categories');
    await findRow(CATEGORY);

    expectRowsApart('link', 'Quizze', [CATEGORY, OTHER_CATEGORY]);
    expectRowsApart('link', 'Bearbeiten', [CATEGORY, OTHER_CATEGORY]);
    expectRowsApart('button', 'Löschen', [CATEGORY, OTHER_CATEGORY]);
  });

  it('shows the short labels and the row names in English too', async () => {
    await i18n.changeLanguage('en');
    await renderAt('/admin/categories');
    await findRow(CATEGORY);

    expectEnglishRows([
      [CATEGORY, categoryActions(true)],
      [OTHER_CATEGORY, categoryActions(false)],
    ]);
  });
});

describe("a category's quiz list: row actions", () => {
  const url = `/admin/categories/${GEOGRAFIE}`;

  it('shows each row the short labels from the table, in the order navigate, edit, publish state, move, delete', async () => {
    await renderAt(url);
    await findRow(QUIZ);

    expect(rowActions(QUIZ).map(visibleText)).toEqual(
      quizActions(false).map((action) => action.label),
    );
    expect(rowActions(OTHER_QUIZ).map(visibleText)).toEqual(
      quizActions(true).map((action) => action.label),
    );
  });

  it('names every action "<label>: <quiz>", starting with its visible label', async () => {
    await renderAt(url);
    await findRow(QUIZ);

    expectGermanRow(QUIZ, quizActions(false));
    expectGermanRow(OTHER_QUIZ, quizActions(true));
  });

  it("keeps two rows' actions apart: each row's own button by its full name", async () => {
    await renderAt(url);
    await findRow(QUIZ);

    expectRowsApart('link', 'Fragen', [QUIZ, OTHER_QUIZ]);
    expectRowsApart('link', 'Vorschau', [QUIZ, OTHER_QUIZ]);
    expectRowsApart('link', 'Bearbeiten', [QUIZ, OTHER_QUIZ]);
    expectRowsApart('button', 'Löschen', [QUIZ, OTHER_QUIZ]);
  });

  it("a quiz row's Vorschau opens that quiz's preview", async () => {
    const router = await renderAt(url);
    await findRow(QUIZ);

    await fireEvent.press(screen.getByRole('link', { name: `Vorschau: ${OTHER_QUIZ}` }));

    await waitFor(() => expect(router.getPathname()).toBe(`/admin/quizzes/${FLUESSE}/preview`));
  });

  it('shows the short labels and the row names in English too', async () => {
    await i18n.changeLanguage('en');
    await renderAt(url);
    await findRow(QUIZ);

    expectEnglishRows([
      [QUIZ, quizActions(false)],
      [OTHER_QUIZ, quizActions(true)],
    ]);
  });
});

describe("a quiz's question list: row actions", () => {
  const url = `/admin/quizzes/${HAUPTSTAEDTE}`;

  it('shows each row the short labels from the table, in the order edit, move, delete', async () => {
    await renderAt(url);
    await findRow(QUESTIONS[0]!);

    for (const question of QUESTIONS) {
      expect(rowActions(question).map(visibleText)).toEqual(
        questionActions.map((action) => action.label),
      );
    }
  });

  it('names every action "<label>: <question>", starting with its visible label', async () => {
    await renderAt(url);
    await findRow(QUESTIONS[0]!);

    for (const question of QUESTIONS) expectGermanRow(question, questionActions);
  });

  it("keeps two rows' actions apart: each row's own button by its full name", async () => {
    await renderAt(url);
    await findRow(QUESTIONS[0]!);

    expectRowsApart('link', 'Bearbeiten', QUESTIONS);
    expectRowsApart('button', 'Löschen', QUESTIONS);
    expectRowsApart('button', '↑ Nach oben', QUESTIONS);
  });

  it('shows the preview link as "Vorschau", named with the quiz', async () => {
    await renderAt(url);
    await findRow(QUESTIONS[0]!);

    const preview = screen.getByRole('link', {
      name: label('admin.questions.preview', { name: QUIZ }),
    });
    expect(visibleText(preview)).toBe('Vorschau');
    expect(accessibleName(preview)).toBe(`Vorschau: ${QUIZ}`);
  });

  it('shows the short labels and the row names in English too', async () => {
    await i18n.changeLanguage('en');
    await renderAt(url);
    await findRow(QUESTIONS[0]!);

    expectEnglishRows(QUESTIONS.map((question) => [question, questionActions]));
    const preview = screen.getByRole('link', {
      name: label('admin.questions.preview', { name: QUIZ }),
    });
    expect(visibleText(preview)).not.toBe('Vorschau');
    expect(visibleText(preview)).not.toContain(QUIZ);
    expect(accessibleName(preview)).toBe(`${visibleText(preview)}: ${QUIZ}`);
  });
});
