// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// The admin's quiz preview (#84) on `/admin/quizzes/<quizId>/preview`,
// rendered through the real route tree in src/app with expo-router's
// renderRouter, behind the admin guard. The quiz's questions screen
// (`/admin/quizzes/<quizId>`, the quiz editor) links to it.
//
// - It shows the quiz, published or not and also in an unpublished category,
//   in the learner's player layout: one question at a time with the
//   player's progress ("Frage 1 von 3"), its answers by sort_order and Next
//   (quiz.next) to the following question, questions by sort_order.
// - It shows the solutions, marked as a preview: each correct answer is
//   named as correct (admin.preview.correctAnswer) and the explanation
//   follows under the player's explanation heading, nothing for a question
//   without one. A visible, translated preview marker (admin.preview.marker)
//   is on every preview screen: the questions, the empty state (a quiz
//   without questions), the not-found state (an unknown or malformed id).
// - It writes nothing: no start_attempt, no submit_answer, no anonymous
//   sign-in, no insert, update, delete or upsert, no Storage upload or
//   removal. It reads the rows the admin may select and the solutions
//   through admin_question() and admin_answers() only.
// - The guard turns away everyone but an admin before any of the quiz's
//   content or solutions is read or shown: a learner sees "no access", an
//   anonymous user or a visitor without a session goes to /admin/sign-in.
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack does: `from(table)` applies `eq`/`in` filters, `order` (also on
// embedded tables via `referencedTable`), `maybeSingle`/`single` and embeds,
// returns only the selected columns, refuses a non-UUID id with 22P02 and
// `questions.explanation`, `answers.is_correct` or `*` on those tables with
// 42501, for every role (the admin included); it returns drafts like the
// database does to an admin. admin_question() and admin_answers() answer an
// admin only, everyone else gets 'not available'. Every request, rpc,
// write, auth call and Storage call is recorded. Rows are stored out of
// order on purpose.

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

// A text with its placeholders filled in through i18next, after checking
// the key exists.
function label(key: string, values: Record<string, unknown> = {}, lng: 'de' | 'en' = shown()) {
  text(key, lng);
  return (i18n.t as (key: string, options: object) => string)(key, { ...values, lng });
}

type Row = Record<string, unknown>;
type PostgrestError = {
  message: string;
  code: string;
  details?: string | null;
  hint?: string | null;
};
type Result = { data: unknown; error: PostgrestError | null; count?: number | null };
type ReadState = 'ok' | 'pending' | { error: PostgrestError };
type Field = { key: string; column: string; inner?: boolean; embed?: Field[] };
type Order = { column: string; ascending: boolean; referencedTable?: string };
type Query = {
  table: string;
  select?: string;
  head: boolean;
  count: boolean;
  orders: Order[];
  filters: { column: string; values: unknown[] }[];
  mode: 'many' | 'maybeSingle' | 'single';
};
type User = { id: string; email?: string; is_anonymous: boolean };
type Session = { access_token: string; refresh_token: string; user: User };
type Listener = (event: string, session: Session | null) => void;

const mockDb: Record<string, Row[]> = {
  categories: [],
  quizzes: [],
  questions: [],
  answers: [],
  attempts: [],
  profiles: [],
};
const mockRead: { detail: ReadState; content: ReadState } = { detail: 'ok', content: 'ok' };
const mockQueries: Query[] = [];
const mockRpcHandlers: Record<string, (args: Row) => Promise<Result>> = {};
const mockRpcCalls: { name: string; args: Row }[] = [];
const mockLog: string[] = [];
// Writes of any kind: table writes, auth sign-ins, Storage changes.
const mockWrites: string[] = [];
const mockAuth = {
  session: null as Session | null,
  listeners: new Set<Listener>(),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARENT_KEY: Record<string, string> = { questions: 'quiz_id', answers: 'question_id' };
// To-one embeds: the column of the embedding row that references the embedded one.
const REFERENCE_KEY: Record<string, string> = { categories: 'category_id' };
const HIDDEN_COLUMNS: Record<string, string[]> = {
  questions: ['explanation', '*'],
  answers: ['is_correct', '*'],
};

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

function mockTouches(
  table: string,
  fields: Field[],
  visit: (table: string, field: Field) => boolean,
): boolean {
  return fields.some((field) =>
    field.embed ? mockTouches(field.column, field.embed, visit) : visit(table, field),
  );
}

// A count-only embed counts with a `select` on the whole row, which the
// column grants of questions and answers refuse.
function mockHasCountOnlyEmbed(fields: Field[]): boolean {
  return fields.some(
    (field) =>
      field.embed !== undefined &&
      ((field.column in HIDDEN_COLUMNS &&
        field.embed.length === 1 &&
        field.embed[0].column === 'count' &&
        !field.embed[0].embed) ||
        mockHasCountOnlyEmbed(field.embed)),
  );
}

const mockIsDenied = (table: string, fields: Field[]) =>
  mockHasCountOnlyEmbed(fields) ||
  mockTouches(table, fields, (t, field) => HIDDEN_COLUMNS[t]?.includes(field.column) ?? false);

const mockUsesAggregate = (select: string) =>
  /\.\s*\w+\s*\(\s*\)|(^|[\s,(])count\s*\(\s*\)/.test(select);

const mockIsContent = (table: string, fields: Field[]) =>
  table === 'answers' ||
  mockTouches(
    table,
    fields,
    (t, field) => t === 'answers' || (t === 'questions' && field.column === 'text'),
  );

function mockSort(rows: Row[], orders: Order[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const [x, y] = [a[column], b[column]] as [string | number, string | number];
      if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
    }
    return 0;
  });
}

function mockChildren(table: string, parent: Row): Row[] {
  const key = PARENT_KEY[table];
  if (!key) throw new Error(`The fake client can't embed ${table}`);
  return (mockDb[table] ?? []).filter((row) => row[key] === parent.id);
}

// Whether a row at `path` passes the filters on that path: `id` at the top,
// `categories.published` for the embedded category.
function mockMatches(row: Row, query: Query, path: string[]): boolean {
  return query.filters.every(({ column, values }) => {
    const segments = column.split('.');
    const name = segments.pop()!;
    return segments.join('.') !== path.join('.') || values.includes(row[name]);
  });
}

// `path` is the embed path from the queried table (e.g. `questions.answers`);
// an embedded order names either that path or its last segment. Null: an
// `!inner` embed has no row left, so the row itself drops out.
function mockProject(row: Row, fields: Field[], query: Query, path: string[] = []): Row | null {
  const projected: Row = {};
  for (const field of fields) {
    if (field.embed) {
      const childPath = [...path, field.column];
      const referenceKey = REFERENCE_KEY[field.column];
      if (referenceKey) {
        const referenced = (mockDb[field.column] ?? []).find(
          (other) => other.id === row[referenceKey] && mockMatches(other, query, childPath),
        );
        const embedded = referenced ? mockProject(referenced, field.embed, query, childPath) : null;
        if (field.inner && !embedded) return null;
        projected[field.key] = embedded;
        continue;
      }
      const children = mockSort(
        mockChildren(field.column, row).filter((child) => mockMatches(child, query, childPath)),
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

function mockRespond(query: Query): Promise<Result> {
  const invalidId = query.filters.find(
    ({ column, values }) =>
      /(^|_)id$/.test(column) && values.some((value) => !UUID.test(String(value))),
  );
  if (invalidId) {
    return Promise.resolve({
      data: null,
      error: {
        code: '22P02',
        message: `invalid input syntax for type uuid: "${invalidId.values}"`,
      },
    });
  }

  if (mockUsesAggregate(query.select ?? '')) {
    return Promise.resolve({
      data: null,
      error: { code: 'PGRST123', message: 'Use of aggregate functions is not allowed' },
    });
  }
  const fields = mockParseFields(query.select ?? '*');
  if (mockIsDenied(query.table, fields)) {
    return Promise.resolve({
      data: null,
      error: { code: '42501', message: `permission denied for table ${query.table}` },
    });
  }

  // Re-spec (#84): `mockRead` controls the preview's own reads only. The admin
  // guard's role read (`profiles`) always answers normally, or the guard
  // would never let the preview render its loading or error state.
  const state =
    query.table === 'profiles'
      ? 'ok'
      : mockIsContent(query.table, fields)
        ? mockRead.content
        : mockRead.detail;
  if (state === 'pending') return new Promise(() => {});
  if (state !== 'ok') return Promise.resolve({ data: null, error: state.error });

  const rows = mockSort(
    (mockDb[query.table] ?? []).filter((row) => mockMatches(row, query, [])),
    query.orders.filter((order) => !order.referencedTable),
  )
    .map((row) => mockProject(row, fields, query))
    .filter((row): row is Row => row !== null);

  const count = query.count ? rows.length : null;
  if (query.mode === 'many') {
    return Promise.resolve({ data: query.head ? null : rows, error: null, count });
  }
  if (rows.length > 1) {
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } });
  }
  if (rows.length === 0 && query.mode === 'single') {
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
  }
  return Promise.resolve({ data: rows[0] ?? null, error: null });
}

function mockThen<T>(
  result: Promise<Result>,
  throwOnError: boolean,
  onFulfilled: (value: Result) => T,
  onRejected?: (reason: unknown) => T,
) {
  return result
    .then((response) => {
      if (throwOnError && response.error) throw response.error;
      return response;
    })
    .then(onFulfilled, onRejected);
}

// Any write is recorded and refused; the preview must send none.
function mockWrite(table: string, operation: string) {
  mockWrites.push(`${operation}:${table}`);
  const refused = Promise.resolve({
    data: null,
    error: { code: '42501', message: `the preview must not ${operation} ${table}` },
  });
  const chain: Record<string, unknown> = {
    then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
      refused.then(onFulfilled, onRejected),
  };
  for (const method of ['select', 'eq', 'in', 'match', 'single', 'maybeSingle', 'abortSignal']) {
    chain[method] = () => chain;
  }
  return chain;
}

function mockQueryBuilder(table: string) {
  const query: Query = {
    table,
    head: false,
    count: false,
    orders: [],
    filters: [],
    mode: 'many',
  };
  let throwOnError = false;
  const builder = {
    select(columns?: string, options?: { head?: boolean; count?: string }) {
      query.select = columns;
      query.head = options?.head === true;
      query.count = options?.count !== undefined;
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
    eq(column: string, value: unknown) {
      query.filters.push({ column, values: [value] });
      return builder;
    },
    in(column: string, values: unknown[]) {
      query.filters.push({ column, values });
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
    insert: () => mockWrite(table, 'insert'),
    update: () => mockWrite(table, 'update'),
    upsert: () => mockWrite(table, 'upsert'),
    delete: () => mockWrite(table, 'delete'),
    abortSignal: () => builder,
    limit: () => builder,
    returns: () => builder,
    throwOnError() {
      throwOnError = true;
      return builder;
    },
    then<T>(onFulfilled: (value: Result) => T, onRejected?: (reason: unknown) => T) {
      mockQueries.push(query);
      mockLog.push(`from:${table}`);
      return mockThen(mockRespond(query), throwOnError, onFulfilled, onRejected);
    },
  };
  return builder;
}

function mockRpc(name: string, args: Row) {
  let single = false;
  let throwOnError = false;
  const builder = {
    single() {
      single = true;
      return builder;
    },
    maybeSingle() {
      single = true;
      return builder;
    },
    abortSignal: () => builder,
    returns: () => builder,
    throwOnError() {
      throwOnError = true;
      return builder;
    },
    then<T>(onFulfilled: (value: Result) => T, onRejected?: (reason: unknown) => T) {
      mockRpcCalls.push({ name, args });
      mockLog.push(`rpc:${name}`);
      const handler = mockRpcHandlers[name];
      const result = (
        handler
          ? handler(args)
          : Promise.resolve({
              data: null,
              error: { code: 'PGRST202', message: 'no such function' },
            })
      ).then((response) =>
        single && Array.isArray(response.data)
          ? { ...response, data: response.data[0] ?? null }
          : response,
      );
      return mockThen(result, throwOnError, onFulfilled, onRejected);
    },
  };
  return builder;
}

const mockIsAdmin = () =>
  mockDb.profiles.some(
    (profile) => profile.id === mockAuth.session?.user.id && profile.role === 'admin',
  );

const mockSupabase = {
  from: (table: string) => mockQueryBuilder(table),
  rpc: (name: string, args: Row) => mockRpc(name, args),
  auth: {
    getSession: () => {
      mockLog.push('auth:getSession');
      return Promise.resolve({ data: { session: mockAuth.session }, error: null });
    },
    getUser: () => Promise.resolve({ data: { user: mockAuth.session?.user ?? null }, error: null }),
    onAuthStateChange: (listener: Listener) => {
      mockAuth.listeners.add(listener);
      void Promise.resolve().then(() => listener('INITIAL_SESSION', mockAuth.session));
      return {
        data: { subscription: { unsubscribe: () => mockAuth.listeners.delete(listener) } },
      };
    },
    signInAnonymously: () => {
      mockWrites.push('auth:signInAnonymously');
      return Promise.resolve({
        data: { session: null, user: null },
        error: new Error('the preview must not sign in anonymously'),
      });
    },
    signOut: () => {
      mockAuth.session = null;
      for (const listener of mockAuth.listeners) listener('SIGNED_OUT', null);
      return Promise.resolve({ error: null });
    },
  },
  storage: {
    from: (bucket: string) => ({
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `http://storage.test/storage/v1/object/public/${bucket}/${path}` },
      }),
      upload: () => {
        mockWrites.push(`storage:upload:${bucket}`);
        return Promise.resolve({ data: null, error: new Error('the preview must not upload') });
      },
      update: () => {
        mockWrites.push(`storage:update:${bucket}`);
        return Promise.resolve({ data: null, error: new Error('the preview must not upload') });
      },
      remove: () => {
        mockWrites.push(`storage:remove:${bucket}`);
        return Promise.resolve({ data: null, error: new Error('the preview must not remove') });
      },
    }),
  },
};

jest.mock('@/lib/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

// The root layout imports the NativeWind stylesheet, which Jest can't load.
jest.mock('../../global.css', () => ({}));

// Fixtures ------------------------------------------------------------------

const ADMIN: User = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  is_anonymous: false,
};
const LEARNER: User = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  email: 'learner@example.com',
  is_anonymous: false,
};
const ANONYMOUS: User = { id: 'cccccccc-0000-4000-8000-000000000003', is_anonymous: true };

const sessionOf = (user: User): Session => ({
  access_token: `token-${user.id}`,
  refresh_token: `refresh-${user.id}`,
  user,
});

const DRAFTS = '10000000-0000-4000-8000-000000000002';
const QUIZ = '20000000-0000-4000-8000-000000000001';
const EMPTY_QUIZ = '20000000-0000-4000-8000-000000000002';
const UNKNOWN_QUIZ = '20000000-0000-4000-8000-0000000000ff';
const FRANCE = '30000000-0000-4000-8000-000000000001';
const FLAG = '30000000-0000-4000-8000-000000000002';
const RHINE = '30000000-0000-4000-8000-000000000003';

const QUIZ_TITLE = 'Entwurf: Europa';
const FRANCE_TEXT = 'Was ist die Hauptstadt von Frankreich?';
const FLAG_TEXT = 'Welche Farben hat die deutsche Flagge?';
const RHINE_TEXT = 'Welcher Fluss fließt durch Köln?';
const FRANCE_EXPLANATION = 'Paris ist seit dem Mittelalter die Hauptstadt Frankreichs.';
const RHINE_EXPLANATION = 'Köln liegt am Rhein.';

const answer = (
  id: number,
  question: string,
  answerText: string,
  is_correct: boolean,
  sort_order: number,
) => ({
  id: `40000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  question_id: question,
  text: answerText,
  image_path: null,
  image_alt: null,
  is_correct,
  sort_order,
  created_at: '2026-10-01T00:00:00Z',
});

function seed() {
  mockDb.categories = [
    {
      id: DRAFTS,
      name: 'Entwürfe',
      description: null,
      sort_order: 1,
      published: false,
      created_at: '2026-10-01T00:00:00Z',
    },
  ];
  mockDb.quizzes = [
    {
      id: EMPTY_QUIZ,
      category_id: DRAFTS,
      title: 'Leeres Quiz',
      description: null,
      sort_order: 2,
      published: false,
      created_at: '2026-10-01T00:00:00Z',
    },
    {
      id: QUIZ,
      category_id: DRAFTS,
      title: QUIZ_TITLE,
      description: 'Noch nicht veröffentlicht',
      sort_order: 1,
      published: false,
      created_at: '2026-10-01T00:00:00Z',
    },
  ];
  // Out of sort_order on purpose: France, then the flag, then the Rhine.
  mockDb.questions = [
    {
      id: RHINE,
      quiz_id: QUIZ,
      text: RHINE_TEXT,
      image_path: null,
      image_alt: null,
      multiple_correct: false,
      explanation: RHINE_EXPLANATION,
      sort_order: 3,
      created_at: '2026-10-01T00:00:00Z',
    },
    {
      id: FRANCE,
      quiz_id: QUIZ,
      text: FRANCE_TEXT,
      image_path: null,
      image_alt: null,
      multiple_correct: false,
      explanation: FRANCE_EXPLANATION,
      sort_order: 1,
      created_at: '2026-10-01T00:00:00Z',
    },
    {
      id: FLAG,
      quiz_id: QUIZ,
      text: FLAG_TEXT,
      image_path: null,
      image_alt: null,
      multiple_correct: true,
      explanation: null,
      sort_order: 2,
      created_at: '2026-10-01T00:00:00Z',
    },
  ];
  mockDb.answers = [
    answer(3, FRANCE, 'Marseille', false, 3),
    answer(1, FRANCE, 'Lyon', false, 1),
    answer(2, FRANCE, 'Paris', true, 2),
    answer(6, FLAG, 'Gold', true, 3),
    answer(4, FLAG, 'Schwarz', true, 1),
    answer(7, FLAG, 'Grün', false, 4),
    answer(5, FLAG, 'Rot', true, 2),
    answer(9, RHINE, 'Rhein', true, 2),
    answer(8, RHINE, 'Elbe', false, 1),
  ];
  mockDb.attempts = [];
  mockDb.profiles = [
    { id: ADMIN.id, role: 'admin', display_name: null },
    { id: LEARNER.id, role: 'learner', display_name: null },
    { id: ANONYMOUS.id, role: 'learner', display_name: null },
  ];
}

// admin_question(question_id) and admin_answers(question_id): an admin's
// reads of the solutions; anyone else gets 'not available'.
function installRpcHandlers() {
  for (const name of Object.keys(mockRpcHandlers)) delete mockRpcHandlers[name];
  const notAvailable = { data: null, error: { code: 'P0001', message: 'not available' } };
  mockRpcHandlers.admin_question = (args) => {
    if (!mockIsAdmin()) return Promise.resolve(notAvailable);
    const question = mockDb.questions.find((row) => row.id === args.question_id);
    return Promise.resolve({
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
    });
  };
  mockRpcHandlers.admin_answers = (args) => {
    if (!mockIsAdmin()) return Promise.resolve(notAvailable);
    const rows = mockDb.answers
      .filter((row) => row.question_id === args.question_id)
      .sort(
        (a, b) =>
          (a.sort_order as number) - (b.sort_order as number) ||
          String(a.id).localeCompare(String(b.id)),
      )
      .map(({ id, text: answerText, is_correct, sort_order }) => ({
        id,
        text: answerText,
        is_correct,
        sort_order,
      }));
    return Promise.resolve({ data: rows, error: null });
  };
  // A preview that starts an attempt or submits an answer is wrong whatever
  // the database says; the calls are recorded and refused.
  for (const name of ['start_attempt', 'submit_answer', 'save_question']) {
    mockRpcHandlers[name] = () =>
      Promise.resolve({ data: null, error: { code: '42501', message: `no ${name} in a preview` } });
  }
}

const previewUrl = (quizId: string) => `/admin/quizzes/${quizId}/preview`;

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

const marker = () => screen.queryByText(text('admin.preview.marker'));
const progress = (current: number, total: number) => label('quiz.progress', { current, total });
const correctMark = (answerText: string) =>
  label('admin.preview.correctAnswer', { answer: answerText });
const nextButton = () => screen.getByRole('button', { name: text('quiz.next') });

// Texts of `candidates` on the screen, top to bottom.
function shownInOrder(candidates: string[]): string[] {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(${candidates.map(escape).join('|')})$`);
  return screen.queryAllByText(pattern).map((element) => String(element.props.children));
}

// Requests that read the quiz's content or solutions.
const contentReads = () => [
  ...mockQueries
    .filter(
      (query) =>
        ['questions', 'answers'].includes(query.table) ||
        /questions|answers/.test(query.select ?? ''),
    )
    .map((query) => `from:${query.table}`),
  ...mockRpcCalls
    .filter((call) => ['admin_question', 'admin_answers'].includes(call.name))
    .map((call) => `rpc:${call.name}`),
];

// Every write the preview could send, and the attempt functions.
const forbidden = () => [
  ...mockWrites,
  ...mockRpcCalls
    .filter((call) => ['start_attempt', 'submit_answer', 'save_question'].includes(call.name))
    .map((call) => `rpc:${call.name}`),
];

beforeEach(async () => {
  seed();
  installRpcHandlers();
  mockRead.detail = 'ok';
  mockRead.content = 'ok';
  mockQueries.length = 0;
  mockRpcCalls.length = 0;
  mockLog.length = 0;
  mockWrites.length = 0;
  mockAuth.session = sessionOf(ADMIN);
  mockAuth.listeners.clear();
  await i18n.changeLanguage('de');
});

describe('preview texts', () => {
  it.each([
    'admin.preview.marker',
    'admin.preview.loading',
    'admin.preview.error',
    'admin.preview.retry',
    'admin.preview.empty',
    'admin.preview.notFound',
    'admin.preview.back',
    'admin.preview.correctAnswer',
    'admin.questions.preview',
  ])('%s has a German and an English text', (key) => {
    expect(text(key, 'de')).toMatch(/\S/);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('names the answer in its correct mark and the quiz in the preview link', () => {
    for (const lng of ['de', 'en'] as const) {
      expect(label('admin.preview.correctAnswer', { answer: 'Paris' }, lng)).toContain('Paris');
      expect(label('admin.questions.preview', { name: QUIZ_TITLE }, lng)).toContain(QUIZ_TITLE);
    }
  });
});

describe('opening the preview from the quiz editor', () => {
  it('links from the quiz’s questions screen to its preview', async () => {
    const router = await renderAt(`/admin/quizzes/${QUIZ}`);

    const link = await screen.findByRole('link', {
      name: label('admin.questions.preview', { name: QUIZ_TITLE }),
    });
    await fireEvent.press(link);
    await flush();

    expect(router.getPathname()).toBe(previewUrl(QUIZ));
    expect(await screen.findByText(text('admin.preview.marker'))).toBeOnTheScreen();
  });
});

describe('the preview (/admin/quizzes/<quizId>/preview)', () => {
  it('shows an unpublished quiz in an unpublished category, marked as a preview', async () => {
    await renderAt(previewUrl(QUIZ));

    expect(await screen.findByText(FRANCE_TEXT)).toBeOnTheScreen();
    // #116 re-spec: was `getByText(QUIZ_TITLE)`. The admin header's
    // breadcrumb now shows the quiz title as a segment too, so the query is
    // scoped to the preview's own heading; it still proves the preview shows
    // the quiz's title.
    expect(screen.getByRole('heading', { name: QUIZ_TITLE })).toBeOnTheScreen();
    expect(marker()).toBeOnTheScreen();
  });

  it('starts with the first question by sort_order, in the player’s layout with its progress', async () => {
    await renderAt(previewUrl(QUIZ));

    expect(await screen.findByText(FRANCE_TEXT)).toBeOnTheScreen();
    expect(screen.getByText(progress(1, 3))).toBeOnTheScreen();
    expect(screen.queryByText(FLAG_TEXT)).toBeNull();
    expect(screen.queryByText(RHINE_TEXT)).toBeNull();
  });

  it('shows the answers by sort_order and marks the correct one', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);

    expect(shownInOrder(['Lyon', 'Paris', 'Marseille'])).toEqual(['Lyon', 'Paris', 'Marseille']);
    expect(screen.getByText(correctMark('Paris'))).toBeOnTheScreen();
    expect(screen.queryByText(correctMark('Lyon'))).toBeNull();
    expect(screen.queryByText(correctMark('Marseille'))).toBeNull();
  });

  it('shows the question’s explanation under the player’s explanation heading', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);

    expect(screen.getByText(text('quiz.feedback.explanation'))).toBeOnTheScreen();
    expect(screen.getByText(FRANCE_EXPLANATION)).toBeOnTheScreen();
  });

  it('goes on with Next and marks every correct answer of a multiple choice question', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);

    await fireEvent.press(nextButton());
    await flush();

    expect(await screen.findByText(FLAG_TEXT)).toBeOnTheScreen();
    expect(screen.getByText(progress(2, 3))).toBeOnTheScreen();
    expect(screen.getByText(text('quiz.multipleHint'))).toBeOnTheScreen();
    expect(shownInOrder(['Schwarz', 'Rot', 'Gold', 'Grün'])).toEqual([
      'Schwarz',
      'Rot',
      'Gold',
      'Grün',
    ]);
    for (const correct of ['Schwarz', 'Rot', 'Gold']) {
      expect(screen.getByText(correctMark(correct))).toBeOnTheScreen();
    }
    expect(screen.queryByText(correctMark('Grün'))).toBeNull();
    expect(marker()).toBeOnTheScreen();
  });

  it('shows no explanation for a question without one', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);

    await fireEvent.press(nextButton());
    await flush();

    expect(await screen.findByText(FLAG_TEXT)).toBeOnTheScreen();
    expect(screen.queryByText(text('quiz.feedback.explanation'))).toBeNull();
    expect(screen.queryByText(FRANCE_EXPLANATION)).toBeNull();
  });

  it('reaches the last question by sort_order', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);

    await fireEvent.press(nextButton());
    await flush();
    await screen.findByText(FLAG_TEXT);
    await fireEvent.press(nextButton());
    await flush();

    expect(await screen.findByText(RHINE_TEXT)).toBeOnTheScreen();
    expect(screen.getByText(progress(3, 3))).toBeOnTheScreen();
    expect(screen.getByText(correctMark('Rhein'))).toBeOnTheScreen();
    expect(screen.getByText(RHINE_EXPLANATION)).toBeOnTheScreen();
    expect(marker()).toBeOnTheScreen();
  });

  it('shows the preview in English, marker and marks included', async () => {
    await i18n.changeLanguage('en');
    await renderAt(previewUrl(QUIZ));

    expect(await screen.findByText(FRANCE_TEXT)).toBeOnTheScreen();
    expect(screen.getByText(text('admin.preview.marker', 'en'))).toBeOnTheScreen();
    expect(
      screen.getByText(label('admin.preview.correctAnswer', { answer: 'Paris' }, 'en')),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(label('quiz.progress', { current: 1, total: 3 }, 'en')),
    ).toBeOnTheScreen();
  });

  it('reads the solutions through admin_question and admin_answers only', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);

    const solutionCalls = mockRpcCalls.filter((call) =>
      ['admin_question', 'admin_answers'].includes(call.name),
    );
    expect(solutionCalls.length).toBeGreaterThan(0);
    // No select named a solution column: the fake would have refused it.
    expect(
      mockQueries.filter((query) => /explanation|is_correct|\*/.test(query.select ?? '')),
    ).toEqual([]);
  });

  it('writes nothing while the admin goes through every question', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);
    // Pressing answers, if they can be pressed, changes nothing either.
    for (const answerText of ['Paris', 'Lyon']) {
      await fireEvent.press(screen.getByText(answerText));
    }
    await fireEvent.press(nextButton());
    await flush();
    await screen.findByText(FLAG_TEXT);
    await fireEvent.press(screen.getByText('Grün'));
    await fireEvent.press(nextButton());
    await flush();
    await screen.findByText(RHINE_TEXT);
    await fireEvent.press(screen.getByText('Elbe'));
    await flush();

    expect(forbidden()).toEqual([]);
    expect(mockLog.filter((entry) => entry.startsWith('rpc:'))).not.toContain('rpc:start_attempt');
    expect(mockDb.attempts).toEqual([]);
  });

  it('shows an empty state, marked as a preview, for a quiz without questions', async () => {
    await renderAt(previewUrl(EMPTY_QUIZ));

    expect(await screen.findByText(text('admin.preview.empty'))).toBeOnTheScreen();
    expect(marker()).toBeOnTheScreen();
    expect(forbidden()).toEqual([]);
  });

  it('shows a not-found state, marked as a preview, for an unknown quiz', async () => {
    await renderAt(previewUrl(UNKNOWN_QUIZ));

    expect(await screen.findByText(text('admin.preview.notFound'))).toBeOnTheScreen();
    expect(marker()).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: text('admin.preview.back') })).toBeOnTheScreen();
  });

  it('shows a not-found state for a malformed id without asking the database for it', async () => {
    await renderAt(previewUrl('kein-quiz'));

    expect(await screen.findByText(text('admin.preview.notFound'))).toBeOnTheScreen();
    expect(marker()).toBeOnTheScreen();
    expect(
      mockQueries.filter((query) =>
        query.filters.some(({ values }) => values.includes('kein-quiz')),
      ),
    ).toEqual([]);
  });

  it('shows a loading state, then an error with a retry when the quiz can’t be read', async () => {
    mockRead.detail = { error: { code: '', message: 'TypeError: Failed to fetch' } };
    mockRead.content = { error: { code: '', message: 'TypeError: Failed to fetch' } };
    await renderAt(previewUrl(QUIZ));

    // Re-spec (#84): generous, like the other admin screens' error tests: the
    // app's query client retries with backoff before it gives up.
    expect(
      await screen.findByText(text('admin.preview.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    mockRead.detail = 'ok';
    mockRead.content = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: text('admin.preview.retry') }));
    await flush();

    expect(await screen.findByText(FRANCE_TEXT)).toBeOnTheScreen();
  });

  it('shows a loading state while the quiz is read', async () => {
    mockRead.detail = 'pending';
    mockRead.content = 'pending';
    await renderAt(previewUrl(QUIZ));

    expect(await screen.findByText(text('admin.preview.loading'))).toBeOnTheScreen();
    expect(marker()).toBeOnTheScreen();
  });
});

describe('the preview after its question list changes', () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it('stays on the last question when a question was deleted elsewhere and the list is read again', async () => {
    await renderAt(previewUrl(QUIZ));
    await screen.findByText(FRANCE_TEXT);
    await fireEvent.press(nextButton());
    await flush();
    await screen.findByText(FLAG_TEXT);
    await fireEvent.press(nextButton());
    await flush();
    await screen.findByText(RHINE_TEXT);

    // Deleted in another tab; the list is stale after a minute and read
    // again when the window regains focus.
    mockDb.questions = mockDb.questions.filter((question) => question.id !== RHINE);
    mockDb.answers = mockDb.answers.filter((row) => row.question_id !== RHINE);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(61_000);
    });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await flush();

    expect(await screen.findByText(FLAG_TEXT)).toBeOnTheScreen();
    expect(screen.getByText(progress(2, 2))).toBeOnTheScreen();
    expect(screen.queryByText(RHINE_TEXT)).toBeNull();
    expect(screen.queryByText(text('admin.preview.loading'))).toBeNull();
  });
});

describe('who may open the preview', () => {
  it('shows a learner "no access" and reads none of the quiz’s content or solutions', async () => {
    mockAuth.session = sessionOf(LEARNER);
    await renderAt(previewUrl(QUIZ));

    expect(await screen.findByText(text('admin.guard.noAccess'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByText(FRANCE_TEXT)).toBeNull();
    expect(screen.queryByText(QUIZ_TITLE)).toBeNull();
    expect(contentReads()).toEqual([]);
    expect(forbidden()).toEqual([]);
  });

  it('sends an anonymous user to the sign-in screen without reading the quiz', async () => {
    mockAuth.session = sessionOf(ANONYMOUS);
    const router = await renderAt(previewUrl(QUIZ));
    await flush();

    await waitFor(() => expect(router.getPathname()).toBe('/admin/sign-in'));
    expect(screen.queryByText(FRANCE_TEXT)).toBeNull();
    expect(contentReads()).toEqual([]);
    expect(forbidden()).toEqual([]);
  });

  it('sends a visitor without a session to the sign-in screen without reading the quiz', async () => {
    mockAuth.session = null;
    const router = await renderAt(previewUrl(QUIZ));
    await flush();

    await waitFor(() => expect(router.getPathname()).toBe('/admin/sign-in'));
    expect(screen.queryByText(FRANCE_TEXT)).toBeNull();
    expect(contentReads()).toEqual([]);
    expect(forbidden()).toEqual([]);
  });

  it('turns a learner away from a published quiz’s preview too', async () => {
    mockDb.categories[0].published = true;
    mockDb.quizzes.forEach((quiz) => {
      quiz.published = true;
    });
    mockAuth.session = sessionOf(LEARNER);
    await renderAt(previewUrl(QUIZ));

    expect(await screen.findByText(text('admin.guard.noAccess'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByText(text('admin.preview.marker'))).toBeNull();
    expect(contentReads()).toEqual([]);
  });
});
