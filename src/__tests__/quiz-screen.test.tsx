import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { TestInstance } from 'test-renderer';

import QuizScreen from '@/app/(learn)/quizzes/[quizId]';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Like src/test-utils/render-with-query-client.tsx, but mutations get an
// infinite gcTime too: their default of five minutes leaves a timer behind
// that keeps Jest from exiting after the run.
function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// The quiz screen on `/quizzes/[quizId]`: the quiz's details, Start, and the
// player for single and multiple choice questions.
//
// Boundaries: the Supabase client (network) and the router (navigation).
// The fake client answers like the local stack would:
// - `from(table)` queries apply `eq`/`in` filters, `order` (also on embedded
//   tables via `referencedTable`, as `answers` or `questions.answers`),
//   `maybeSingle`/`single`, embeds (`questions(...)`, `answers(...)`), a
//   `{ count: 'exact', head }` option (count is null without it), and return
//   only the selected columns. A non-UUID id fails with 22P02. As the column
//   grants do, selecting `questions.explanation`, `answers.is_correct`, `*`
//   or a count-only embed (`questions(count)`) on those tables fails with
//   42501; aggregates such as `id.count()` fail with PGRST123, as PostgREST
//   has them disabled.
// - Reads of question texts or answers are "content" reads, controlled by
//   `mockRead.content`; every other read (the quiz, its question count) by
//   `mockRead.detail`.
// - `rpc(name, args)` answers with `mockRpcHandlers[name]`; each awaited call
//   is recorded in `mockRpcCalls`.
// - `auth.getSession()` returns `mockAuth.session`; `signInAnonymously()`
//   stores a new session (or fails with `mockAuth.signInError`).
// Rows come back in table order unless the query orders them, so the tables
// below are deliberately shuffled.

type Row = Record<string, unknown>;
type PostgrestError = {
  message: string;
  code: string;
  details?: string | null;
  hint?: string | null;
};
type Result = { data: unknown; error: PostgrestError | null; count?: number | null };
type ReadState = 'ok' | 'pending' | { error: PostgrestError };
type Field = { key: string; column: string; embed?: Field[] };
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
type Session = { access_token: string; user: { id: string; is_anonymous: boolean } };

const mockDb: Record<string, Row[]> = { quizzes: [], questions: [], answers: [] };
const mockRead: { detail: ReadState; content: ReadState } = { detail: 'ok', content: 'ok' };
const mockQueries: Query[] = [];
const mockRpcHandlers: Record<string, (args: Row) => Promise<Result>> = {};
const mockRpcCalls: { name: string; args: Row }[] = [];
const mockLog: string[] = [];
const mockAuth: { session: Session | null; signInError: Error | null; signIns: number } = {
  session: null,
  signInError: null,
  signIns: 0,
};
const mockParams: { current: Record<string, string> } = { current: {} };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARENT_KEY: Record<string, string> = { questions: 'quiz_id', answers: 'question_id' };
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
    const match = /^(?:(\w+):)?([\w*]+)(?:!\w+)?(?:\(([\s\S]*)\))?$/.exec(item);
    if (!match) throw new Error(`The fake client can't parse the select item "${item}"`);
    const [, alias, column, inner] = match;
    return {
      key: alias ?? column,
      column,
      embed: inner === undefined ? undefined : mockParseFields(inner),
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

// `path` is the embed path from the queried table (e.g. `questions.answers`);
// an embedded order names either that path or its last segment.
function mockProject(row: Row, fields: Field[], query: Query, path: string[] = []): Row {
  const projected: Row = {};
  for (const field of fields) {
    if (field.embed) {
      const childPath = [...path, field.column];
      const children = mockSort(
        mockChildren(field.column, row),
        query.orders.filter(
          (order) =>
            order.referencedTable === childPath.join('.') || order.referencedTable === field.column,
        ),
      );
      projected[field.key] = children.map((child) =>
        mockProject(child, field.embed!, query, childPath),
      );
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

  const state = mockIsContent(query.table, fields) ? mockRead.content : mockRead.detail;
  if (state === 'pending') return new Promise(() => {});
  if (state !== 'ok') return Promise.resolve({ data: null, error: state.error });

  const rows = mockSort(
    (mockDb[query.table] ?? []).filter((row) =>
      query.filters.every(({ column, values }) => values.includes(row[column])),
    ),
    query.orders.filter((order) => !order.referencedTable),
  ).map((row) => mockProject(row, fields, query));

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

function mockGetSession() {
  mockLog.push('auth:getSession');
  return Promise.resolve({ data: { session: mockAuth.session }, error: null });
}

function mockSignInAnonymously() {
  mockLog.push('auth:signInAnonymously');
  mockAuth.signIns += 1;
  if (mockAuth.signInError) {
    return Promise.resolve({ data: { session: null, user: null }, error: mockAuth.signInError });
  }
  const session: Session = {
    access_token: `token-${mockAuth.signIns}`,
    user: { id: `50000000-0000-4000-8000-00000000000${mockAuth.signIns}`, is_anonymous: true },
  };
  mockAuth.session = session;
  return Promise.resolve({ data: { session, user: session.user }, error: null });
}

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
    rpc: (name: string, args: Row) => mockRpc(name, args),
    auth: {
      getSession: () => mockGetSession(),
      signInAnonymously: () => mockSignInAnonymously(),
      getUser: () => {
        throw new Error('ensureSession must read the session locally, not through getUser');
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

// Page titles go through <Stack.Screen options={{ title }}>, which renders
// nothing here, since there is no navigator around a single screen.
jest.mock('expo-router', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Screen = () => null;
  return {
    ...jest.requireActual('expo-router'),
    Link: ({ href, children }: { href: unknown; children?: unknown }) =>
      createElement(View, { href } as object, children as never),
    Stack: Object.assign(() => null, { Screen }),
    useLocalSearchParams: () => mockParams.current,
  };
});

// Seed-like content (supabase/seed.sql): two single choice questions, then a
// multiple choice one with three of four answers correct.
const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const QUIZ = '20000000-0000-4000-8000-000000000001';
const EMPTY_QUIZ = '20000000-0000-4000-8000-000000000005';
const ATTEMPT = '60000000-0000-4000-8000-000000000001';

const quiz = {
  id: QUIZ,
  category_id: GEOGRAFIE,
  title: 'Hauptstädte Europas',
  description: 'Kennst du die Hauptstädte unserer Nachbarn?',
  sort_order: 1,
  published: true,
};
const emptyQuiz = {
  id: EMPTY_QUIZ,
  category_id: GEOGRAFIE,
  title: 'Seen der Schweiz',
  description: 'Bald mit Fragen',
  sort_order: 2,
  published: true,
};

const question = (id: number, text: string, multiple: boolean, sortOrder: number) => ({
  id: `30000000-0000-4000-8000-00000000000${id}`,
  quiz_id: QUIZ,
  text,
  image_path: null,
  image_alt: null,
  multiple_correct: multiple,
  explanation: `Erklärung ${id}`,
  sort_order: sortOrder,
  created_at: '2026-10-01T00:00:00Z',
});
const answer = (
  id: number,
  questionId: string,
  text: string,
  correct: boolean,
  sortOrder: number,
) => ({
  id: `40000000-0000-4000-8000-0000000000${String(id).padStart(2, '0')}`,
  question_id: questionId,
  text,
  image_path: null,
  image_alt: null,
  is_correct: correct,
  sort_order: sortOrder,
  created_at: '2026-10-01T00:00:00Z',
});

const france = question(1, 'Was ist die Hauptstadt von Frankreich?', false, 1);
const italy = question(2, 'Was ist die Hauptstadt von Italien?', false, 2);
const danube = question(3, 'Welche dieser Hauptstädte liegen an der Donau?', true, 3);
const paris = answer(1, france.id, 'Paris', true, 1);
const lyon = answer(2, france.id, 'Lyon', false, 2);
const marseille = answer(3, france.id, 'Marseille', false, 3);
const milan = answer(4, italy.id, 'Mailand', false, 1);
const rome = answer(5, italy.id, 'Rom', true, 2);
const naples = answer(6, italy.id, 'Neapel', false, 3);
const vienna = answer(7, danube.id, 'Wien', true, 1);
const prague = answer(8, danube.id, 'Prag', false, 2);
const bratislava = answer(9, danube.id, 'Bratislava', true, 3);
const budapest = answer(10, danube.id, 'Budapest', true, 4);

function seedTables() {
  mockDb.quizzes = [emptyQuiz, quiz];
  mockDb.questions = [danube, france, italy];
  mockDb.answers = [
    budapest,
    rome,
    lyon,
    prague,
    vienna,
    naples,
    paris,
    bratislava,
    milan,
    marseille,
  ];
}

const failure: PostgrestError = { code: 'PGRST000', message: 'connection refused' };
const notAvailable: PostgrestError = {
  code: 'P0001',
  message: 'not available',
  details: null,
  hint: null,
};
const submitted = (correctIds: string[]): Result => ({
  data: [{ is_correct: true, points: 1, correct_answer_ids: correctIds, explanation: null }],
  error: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Lets pending promises and the re-renders they cause settle.
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const callsOf = (name: string) => mockRpcCalls.filter((call) => call.name === name);

const startButton = () => screen.getByRole('button', { name: i18n.t('quiz.start') });
const submitButton = () => screen.getByRole('button', { name: i18n.t('quiz.submit') });
const progress = (current: number, total: number) => i18n.t('quiz.progress', { current, total });

async function startQuiz() {
  await renderWithQueryClient(<QuizScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));
  await screen.findByText(france.text);
}

async function answerWith(role: 'radio' | 'checkbox', texts: string[]) {
  for (const text of texts) await fireEvent.press(screen.getByRole(role, { name: text }));
  await fireEvent.press(submitButton());
}

const roleOf = (node: TestInstance): unknown => node.props.role ?? node.props.accessibilityRole;

// The nearest ancestor that is a (radio) group, and the name it is labelled
// with: its own label, or the text of the element it is labelled by.
function groupLabelOf(element: TestInstance): string | undefined {
  let group: TestInstance | null = element.parent;
  while (group && !['radiogroup', 'group'].includes(roleOf(group) as string)) group = group.parent;
  if (!group) throw new Error('The answer is not inside a group');

  const label = group.props['aria-label'] ?? group.props.accessibilityLabel;
  if (label) return label;
  const labelledBy = group.props['aria-labelledby'] ?? group.props.accessibilityLabelledBy;
  if (!labelledBy) return undefined;
  // React Native passes aria-labelledby on as an array of ids.
  const ids: unknown[] = [labelledBy].flat();
  const [labelElement] = screen.container.queryAll(
    (node) => ids.includes(node.props.nativeID) || ids.includes(node.props.id),
  );
  return labelElement ? textOf(labelElement) : undefined;
}

function textOf(node: TestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

const statusKeys = [
  'loading',
  'error',
  'notFound',
  'noQuestions',
  'unavailable',
  'startError',
  'questionsLoading',
  'questionsError',
  'submitError',
  'finished',
] as const;
const expectOnlyStatus = (shown: (typeof statusKeys)[number] | null) => {
  for (const key of statusKeys.filter((other) => other !== shown)) {
    expect(screen.queryByText(i18n.t(`quiz.${key}`))).not.toBeOnTheScreen();
  }
};

const plainKeys = [...statusKeys, 'retry', 'start', 'submit', 'multipleHint'] as const;

describe('<QuizScreen />', () => {
  beforeEach(async () => {
    seedTables();
    mockRead.detail = 'ok';
    mockRead.content = 'ok';
    mockQueries.length = 0;
    mockRpcCalls.length = 0;
    mockLog.length = 0;
    mockAuth.session = null;
    mockAuth.signInError = null;
    mockAuth.signIns = 0;
    for (const name of Object.keys(mockRpcHandlers)) delete mockRpcHandlers[name];
    mockRpcHandlers.start_attempt = () => Promise.resolve({ data: ATTEMPT, error: null });
    mockRpcHandlers.submit_answer = () => Promise.resolve(submitted([]));
    mockParams.current = { quizId: QUIZ };
    await i18n.changeLanguage('de');
  });

  describe('texts', () => {
    it('has a non-empty German and English text for each key, different per language', () => {
      for (const key of plainKeys) {
        expect(de).toHaveProperty(['quiz', key], expect.stringMatching(/\S/));
        expect(en).toHaveProperty(['quiz', key], expect.stringMatching(/\S/));
        expect(i18n.t(`quiz.${key}`, { lng: 'en' })).not.toBe(i18n.t(`quiz.${key}`, { lng: 'de' }));
      }
    });

    it('has a different text for each status in German and in English', () => {
      // expectOnlyStatus tells the states apart by their texts.
      // Read from the locale files, so a missing text counts as a duplicate
      // instead of falling back to its distinct key.
      for (const [lng, locale] of Object.entries({ de, en })) {
        const quizTexts = (locale as { quiz?: Record<string, string> }).quiz ?? {};
        const texts = statusKeys.map((key) => quizTexts[key]);
        const duplicates = statusKeys.filter((_, index) => texts.indexOf(texts[index]) !== index);
        expect({ lng, duplicateStatusTexts: duplicates }).toEqual({
          lng,
          duplicateStatusTexts: [],
        });
      }
    });

    it('says "question n of m" with both numbers in German and English', () => {
      for (const lng of ['de', 'en']) {
        const text = i18n.t('quiz.progress', { current: 2, total: 5, lng });
        expect(text).toMatch(/2\D+5/);
        expect(text).not.toMatch(/quiz\.progress/);
      }
      expect(i18n.t('quiz.progress', { current: 2, total: 5, lng: 'en' })).not.toBe(
        i18n.t('quiz.progress', { current: 2, total: 5, lng: 'de' }),
      );
    });

    it('states the number of questions with singular and plural in German and English', () => {
      for (const lng of ['de', 'en']) {
        const one = i18n.t('quiz.questionCount', { count: 1, lng });
        const three = i18n.t('quiz.questionCount', { count: 3, lng });
        expect(one).toContain('1');
        expect(three).toContain('3');
        expect(three).not.toMatch(/quiz\.questionCount/);
        expect(one.replace('1', '')).not.toBe(three.replace('3', ''));
      }
    });
  });

  describe('the quiz details', () => {
    it('shows the title, description, number of questions and a Start button', async () => {
      await renderWithQueryClient(<QuizScreen />);

      expect(await screen.findByText(quiz.title)).toBeOnTheScreen();
      expect(screen.getByText(quiz.description)).toBeOnTheScreen();
      expect(screen.getByText(i18n.t('quiz.questionCount', { count: 3 }))).toBeOnTheScreen();
      expect(startButton()).toBeEnabled();
      expect(screen.queryByText(france.text)).not.toBeOnTheScreen();
      expectOnlyStatus(null);
    });

    it('shows a loading state while the quiz is pending', async () => {
      mockRead.detail = 'pending';

      await renderWithQueryClient(<QuizScreen />);

      expect(screen.getByText(i18n.t('quiz.loading'))).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: i18n.t('quiz.start') })).not.toBeOnTheScreen();
      expectOnlyStatus('loading');
    });

    it('shows an error state when the quiz request fails, and loads it again on retry', async () => {
      mockRead.detail = { error: failure };

      await renderWithQueryClient(<QuizScreen />);
      const retry = await screen.findByRole('button', { name: i18n.t('quiz.retry') });
      expect(screen.getByText(i18n.t('quiz.error'))).toBeOnTheScreen();
      expectOnlyStatus('error');

      mockRead.detail = 'ok';
      await fireEvent.press(retry);

      expect(await screen.findByText(quiz.title)).toBeOnTheScreen();
      expect(screen.queryByText(i18n.t('quiz.error'))).not.toBeOnTheScreen();
    });

    it('shows a not-found state for an unknown or invisible quiz', async () => {
      mockParams.current = { quizId: '20000000-0000-4000-8000-000000000099' };

      await renderWithQueryClient(<QuizScreen />);

      expect(await screen.findByText(i18n.t('quiz.notFound'))).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: i18n.t('quiz.start') })).not.toBeOnTheScreen();
      expectOnlyStatus('notFound');
    });

    it('shows the not-found state for a quiz id that is not a UUID', async () => {
      mockParams.current = { quizId: 'gibt-es-nicht' };

      await renderWithQueryClient(<QuizScreen />);

      expect(await screen.findByText(i18n.t('quiz.notFound'))).toBeOnTheScreen();
      expectOnlyStatus('notFound');
    });

    it('says the quiz has no questions yet and offers no Start button', async () => {
      mockParams.current = { quizId: EMPTY_QUIZ };

      await renderWithQueryClient(<QuizScreen />);

      expect(await screen.findByText(i18n.t('quiz.noQuestions'))).toBeOnTheScreen();
      expect(screen.getByText(emptyQuiz.title)).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: i18n.t('quiz.start') })).not.toBeOnTheScreen();
      expectOnlyStatus('noQuestions');
    });

    it('shows its texts in English when the language is English', async () => {
      await i18n.changeLanguage('en');

      await renderWithQueryClient(<QuizScreen />);

      expect(
        await screen.findByRole('button', { name: i18n.t('quiz.start', { lng: 'en' }) }),
      ).toBeOnTheScreen();
      expect(
        screen.getByText(i18n.t('quiz.questionCount', { count: 3, lng: 'en' })),
      ).toBeOnTheScreen();
    });
  });

  describe('starting', () => {
    it('signs a visitor without a session in anonymously, then starts an attempt of the quiz', async () => {
      await startQuiz();

      expect(mockAuth.signIns).toBe(1);
      expect(callsOf('start_attempt')).toEqual([
        { name: 'start_attempt', args: { quiz_id: QUIZ } },
      ]);
      expect(mockLog.indexOf('auth:signInAnonymously')).toBeLessThan(
        mockLog.indexOf('rpc:start_attempt'),
      );
    });

    it('starts with the stored session without signing in again', async () => {
      mockAuth.session = {
        access_token: 'stored',
        user: { id: '50000000-0000-4000-8000-000000000009', is_anonymous: true },
      };

      await startQuiz();

      expect(mockAuth.signIns).toBe(0);
      expect(callsOf('start_attempt')).toHaveLength(1);
    });

    it('disables Start while starting and starts one attempt for two presses', async () => {
      const start = deferred<Result>();
      mockRpcHandlers.start_attempt = () => start.promise;

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));
      await waitFor(() => expect(callsOf('start_attempt')).toHaveLength(1));

      expect(startButton()).toBeDisabled();
      await fireEvent.press(startButton());
      await flush();
      expect(callsOf('start_attempt')).toHaveLength(1);
      expect(mockAuth.signIns).toBe(1);

      start.resolve({ data: ATTEMPT, error: null });
      expect(await screen.findByText(france.text)).toBeOnTheScreen();
      expect(callsOf('start_attempt')).toHaveLength(1);
    });

    it('loads the questions and answers only after the attempt has started', async () => {
      const start = deferred<Result>();
      mockRpcHandlers.start_attempt = () => start.promise;

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));
      await waitFor(() => expect(callsOf('start_attempt')).toHaveLength(1));
      await flush();

      const contentReads = () =>
        mockQueries.filter((query) =>
          mockIsContent(query.table, mockParseFields(query.select ?? '*')),
        );
      expect(contentReads()).toEqual([]);

      start.resolve({ data: ATTEMPT, error: null });

      expect(await screen.findByText(france.text)).toBeOnTheScreen();
      expect(contentReads().length).toBeGreaterThan(0);
    });

    it('shows an error with retry when starting fails, and starts on retry', async () => {
      mockRpcHandlers.start_attempt = () => Promise.resolve({ data: null, error: failure });

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));

      expect(await screen.findByText(i18n.t('quiz.startError'))).toBeOnTheScreen();
      expectOnlyStatus('startError');

      mockRpcHandlers.start_attempt = () => Promise.resolve({ data: ATTEMPT, error: null });
      await fireEvent.press(screen.getByRole('button', { name: i18n.t('quiz.retry') }));

      expect(await screen.findByText(france.text)).toBeOnTheScreen();
      expect(callsOf('start_attempt')).toHaveLength(2);
      expect(screen.queryByText(i18n.t('quiz.startError'))).not.toBeOnTheScreen();
    });

    it('shows an error with retry when the anonymous sign-in fails, and signs in on retry', async () => {
      mockAuth.signInError = new Error('Failed to fetch');

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));

      expect(await screen.findByText(i18n.t('quiz.startError'))).toBeOnTheScreen();
      expect(callsOf('start_attempt')).toEqual([]);

      mockAuth.signInError = null;
      await fireEvent.press(screen.getByRole('button', { name: i18n.t('quiz.retry') }));

      expect(await screen.findByText(france.text)).toBeOnTheScreen();
      expect(mockAuth.signIns).toBe(2);
      expect(callsOf('start_attempt')).toHaveLength(1);
    });

    it("says the quiz can't be played, without retry, when the database refuses the attempt", async () => {
      mockRpcHandlers.start_attempt = () => Promise.resolve({ data: null, error: notAvailable });

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));

      expect(await screen.findByText(i18n.t('quiz.unavailable'))).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: i18n.t('quiz.retry') })).not.toBeOnTheScreen();
      expect(
        screen.queryByRole('button', { name: i18n.t('quiz.start'), disabled: false }),
      ).not.toBeOnTheScreen();
      expectOnlyStatus('unavailable');
    });

    it('shows a loading state while the questions are pending', async () => {
      mockRead.content = 'pending';

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));

      expect(await screen.findByText(i18n.t('quiz.questionsLoading'))).toBeOnTheScreen();
      expectOnlyStatus('questionsLoading');
    });

    it('shows an error with retry when the questions fail to load, and loads them without a new attempt', async () => {
      mockRead.content = { error: failure };

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));

      expect(await screen.findByText(i18n.t('quiz.questionsError'))).toBeOnTheScreen();
      expectOnlyStatus('questionsError');

      mockRead.content = 'ok';
      await fireEvent.press(screen.getByRole('button', { name: i18n.t('quiz.retry') }));

      expect(await screen.findByText(france.text)).toBeOnTheScreen();
      expect(callsOf('start_attempt')).toHaveLength(1);
    });
  });

  describe('playing', () => {
    it('shows the first question by sort_order with "question 1 of 3" and its answers in order', async () => {
      await startQuiz();

      expect(screen.getByText(progress(1, 3))).toBeOnTheScreen();
      expect(screen.queryByText(italy.text)).not.toBeOnTheScreen();
      expect(screen.queryByText(danube.text)).not.toBeOnTheScreen();
      const rendered = screen.getAllByText(/^(Paris|Lyon|Marseille)$/);
      expect(rendered.map(textOf)).toEqual(['Paris', 'Lyon', 'Marseille']);
    });

    it('orders questions and answers by sort_order, then by id', async () => {
      const id = (n: number) => `30000000-0000-4000-8000-00000000000${n}`;
      const late = { ...question(1, 'Frage mit sort_order 2', false, 2), id: id(1) };
      const tieSecond = { ...question(3, 'Zweite Frage mit sort_order 1', false, 1), id: id(3) };
      const tieFirst = { ...question(2, 'Erste Frage mit sort_order 1', false, 1), id: id(2) };
      mockDb.questions = [late, tieSecond, tieFirst];
      mockDb.answers = [
        answer(1, tieFirst.id, 'Antwort C', false, 2),
        answer(3, tieFirst.id, 'Antwort B', true, 1),
        answer(2, tieFirst.id, 'Antwort A', false, 1),
        answer(4, tieSecond.id, 'Ja', true, 1),
        answer(5, late.id, 'Nein', true, 1),
      ];

      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));

      expect(await screen.findByText(tieFirst.text)).toBeOnTheScreen();
      const rendered = screen.getAllByText(/^Antwort [ABC]$/);
      expect(rendered.map(textOf)).toEqual(['Antwort A', 'Antwort B', 'Antwort C']);

      await answerWith('radio', ['Antwort A']);
      expect(await screen.findByText(tieSecond.text)).toBeOnTheScreen();
      await answerWith('radio', ['Ja']);
      expect(await screen.findByText(late.text)).toBeOnTheScreen();
    });

    it('shows single choice answers as unchecked radio buttons in a group named by the question', async () => {
      await startQuiz();

      for (const text of ['Paris', 'Lyon', 'Marseille']) {
        const radio = screen.getByRole('radio', { name: text });
        expect(radio).not.toBeChecked();
        expect(groupLabelOf(radio)).toBe(france.text);
      }
      expect(screen.queryAllByRole('checkbox')).toEqual([]);
      expect(screen.queryByText(i18n.t('quiz.multipleHint'))).not.toBeOnTheScreen();
    });

    it('replaces the selection with each pick on a single choice question', async () => {
      await startQuiz();

      await fireEvent.press(screen.getByRole('radio', { name: 'Paris' }));
      expect(screen.getByRole('radio', { name: 'Paris' })).toBeChecked();

      await fireEvent.press(screen.getByRole('radio', { name: 'Lyon' }));
      expect(screen.getByRole('radio', { name: 'Lyon' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Paris' })).not.toBeChecked();
      expect(screen.getByRole('radio', { name: 'Marseille' })).not.toBeChecked();
    });

    it('shows multiple choice answers as checkboxes in a group named by the question, with a hint', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await screen.findByText(italy.text);
      await answerWith('radio', ['Rom']);

      expect(await screen.findByText(danube.text)).toBeOnTheScreen();
      expect(screen.getByText(progress(3, 3))).toBeOnTheScreen();
      expect(screen.getByText(i18n.t('quiz.multipleHint'))).toBeOnTheScreen();
      for (const text of ['Wien', 'Prag', 'Bratislava', 'Budapest']) {
        const checkbox = screen.getByRole('checkbox', { name: text });
        expect(checkbox).not.toBeChecked();
        expect(groupLabelOf(checkbox)).toBe(danube.text);
      }
      expect(screen.queryAllByRole('radio')).toEqual([]);
    });

    it('toggles each pick on a multiple choice question', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await screen.findByText(italy.text);
      await answerWith('radio', ['Rom']);
      await screen.findByText(danube.text);

      await fireEvent.press(screen.getByRole('checkbox', { name: 'Wien' }));
      await fireEvent.press(screen.getByRole('checkbox', { name: 'Bratislava' }));
      expect(screen.getByRole('checkbox', { name: 'Wien' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Bratislava' })).toBeChecked();

      await fireEvent.press(screen.getByRole('checkbox', { name: 'Wien' }));
      expect(screen.getByRole('checkbox', { name: 'Wien' })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Bratislava' })).toBeChecked();
    });

    it('keeps Submit disabled until an answer is picked', async () => {
      await startQuiz();

      expect(submitButton()).toBeDisabled();
      await fireEvent.press(submitButton());
      await flush();
      expect(callsOf('submit_answer')).toEqual([]);

      await fireEvent.press(screen.getByRole('radio', { name: 'Paris' }));
      expect(submitButton()).toBeEnabled();
    });

    it('submits the picked answer for the question of the started attempt', async () => {
      await startQuiz();

      await answerWith('radio', ['Lyon', 'Paris']);

      await waitFor(() => expect(callsOf('submit_answer')).toHaveLength(1));
      expect(callsOf('submit_answer')[0].args).toEqual({
        attempt_id: ATTEMPT,
        question_id: france.id,
        answer_ids: [paris.id],
      });
    });

    it('submits every picked answer of a multiple choice question', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await screen.findByText(italy.text);
      await answerWith('radio', ['Rom']);
      await screen.findByText(danube.text);

      await answerWith('checkbox', ['Wien', 'Prag', 'Budapest']);

      await waitFor(() => expect(callsOf('submit_answer')).toHaveLength(3));
      const { args } = callsOf('submit_answer')[2];
      expect(args).toMatchObject({ attempt_id: ATTEMPT, question_id: danube.id });
      expect([...(args.answer_ids as string[])].sort()).toEqual(
        [vienna.id, prague.id, budapest.id].sort(),
      );
    });

    it('disables Submit while submitting and sends one answer for two presses', async () => {
      const submit = deferred<Result>();
      mockRpcHandlers.submit_answer = () => submit.promise;
      await startQuiz();

      await answerWith('radio', ['Paris']);
      await waitFor(() => expect(callsOf('submit_answer')).toHaveLength(1));

      expect(submitButton()).toBeDisabled();
      await fireEvent.press(submitButton());
      await flush();
      expect(callsOf('submit_answer')).toHaveLength(1);
      expect(screen.getByText(progress(1, 3))).toBeOnTheScreen();

      submit.resolve(submitted([paris.id]));
      expect(await screen.findByText(italy.text)).toBeOnTheScreen();
      expect(callsOf('submit_answer')).toHaveLength(1);
    });

    it('moves to the next question with nothing picked after the answer is recorded', async () => {
      mockRpcHandlers.submit_answer = () => Promise.resolve(submitted([paris.id]));
      await startQuiz();

      await answerWith('radio', ['Paris']);

      expect(await screen.findByText(italy.text)).toBeOnTheScreen();
      expect(screen.getByText(progress(2, 3))).toBeOnTheScreen();
      expect(screen.queryByText(france.text)).not.toBeOnTheScreen();
      for (const text of ['Mailand', 'Rom', 'Neapel']) {
        expect(screen.getByRole('radio', { name: text })).not.toBeChecked();
      }
      expect(submitButton()).toBeDisabled();
    });

    it('shows the finished state after the last question', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await screen.findByText(italy.text);
      await answerWith('radio', ['Rom']);
      await screen.findByText(danube.text);

      await answerWith('checkbox', ['Wien', 'Bratislava', 'Budapest']);

      expect(await screen.findByText(i18n.t('quiz.finished'))).toBeOnTheScreen();
      expect(screen.queryByText(danube.text)).not.toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: i18n.t('quiz.submit') })).not.toBeOnTheScreen();
      expect(callsOf('submit_answer')).toHaveLength(3);
      expectOnlyStatus('finished');
    });

    it('shows an error with retry when submitting fails, keeps the selection and sends it again on retry', async () => {
      mockRpcHandlers.submit_answer = () => Promise.resolve({ data: null, error: failure });
      await startQuiz();

      await answerWith('radio', ['Lyon']);

      expect(await screen.findByText(i18n.t('quiz.submitError'))).toBeOnTheScreen();
      expect(screen.getByText(france.text)).toBeOnTheScreen();
      expect(screen.getByText(progress(1, 3))).toBeOnTheScreen();
      expect(screen.getByRole('radio', { name: 'Lyon' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Paris' })).not.toBeChecked();

      mockRpcHandlers.submit_answer = () => Promise.resolve(submitted([paris.id]));
      await fireEvent.press(screen.getByRole('button', { name: i18n.t('quiz.retry') }));

      expect(await screen.findByText(italy.text)).toBeOnTheScreen();
      const calls = callsOf('submit_answer');
      expect(calls).toHaveLength(2);
      expect(calls[1].args).toEqual(calls[0].args);
      expect(calls[1].args).toMatchObject({ question_id: france.id, answer_ids: [lyon.id] });
      expect(screen.queryByText(i18n.t('quiz.submitError'))).not.toBeOnTheScreen();
    });

    it('selects explicit columns and never the solutions', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await screen.findByText(italy.text);
      await answerWith('radio', ['Rom']);
      await screen.findByText(danube.text);
      await answerWith('checkbox', ['Wien']);
      await screen.findByText(i18n.t('quiz.finished'));

      expect(mockQueries.length).toBeGreaterThan(0);
      for (const query of mockQueries) {
        expect(query.select).toEqual(expect.stringMatching(/\w/));
        expect(query.select).not.toContain('*');
        expect(query.select).not.toMatch(/is_correct|explanation/);
      }
    });
  });
});
