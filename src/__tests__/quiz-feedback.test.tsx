import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { TestInstance } from 'test-renderer';

import QuizScreen from '@/app/(learn)/quizzes/[quizId]';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// The feedback after each answer and the result screen, both on the quiz
// screen `/quizzes/[quizId]`: after submit_answer the question stays on
// screen with its verdict, a mark per answer and the explanation, then Next
// (or See result after the last question). The result shows the attempt's
// score and max_score as the database stored them, a whole-number
// percentage, Play again (a new attempt) and a link back to the category.
//
// Boundaries: the Supabase client (network) and the router. The fake client
// is the one of quiz-screen.test.tsx, trimmed, plus an `attempts` table:
// - `from(table)` queries apply `eq`/`in` filters, `order` (also on embedded
//   tables via `referencedTable`), `maybeSingle`/`single` and embeds, and
//   return only the selected columns. Selecting `questions.explanation`,
//   `answers.is_correct` or `*` on those tables fails with 42501.
// - Reads of `attempts` are controlled by `mockRead.attempt`, every other
//   read is answered from `mockDb`.
// - `rpc('start_attempt')` creates an attempt (score 0, max_score = number
//   of questions) and returns its id; `rpc('submit_answer')` scores the
//   picks as the migration does (any wrong pick 0, all correct 1, a correct
//   subset of a multiple choice question its share rounded to 2 decimals),
//   adds the points to the attempt's score and returns the solution. Both
//   can be replaced through `mockRpcHandlers`; calls are recorded in
//   `mockRpcCalls`.
// - `auth` hands out an anonymous session.

type Row = Record<string, unknown>;
type PostgrestError = {
  message: string;
  code: string;
  details?: string | null;
  hint?: string | null;
};
type Result = { data: unknown; error: PostgrestError | null };
type ReadState = 'ok' | 'pending' | { error: PostgrestError };
type Field = { key: string; column: string; embed?: Field[] };
type Order = { column: string; ascending: boolean; referencedTable?: string };
type Query = {
  table: string;
  select?: string;
  orders: Order[];
  filters: { column: string; values: unknown[] }[];
  mode: 'many' | 'maybeSingle' | 'single';
};
type Session = { access_token: string; user: { id: string; is_anonymous: boolean } };

const mockDb: Record<string, Row[]> = { quizzes: [], questions: [], answers: [], attempts: [] };
const mockRead: { attempt: ReadState } = { attempt: 'ok' };
// The max_score start_attempt stores; null: the number of questions.
const mockMaxScore: { current: number | null } = { current: null };
const mockQueries: Query[] = [];
const mockRpcHandlers: Record<string, (args: Row) => Promise<Result>> = {};
const mockRpcCalls: { name: string; args: Row }[] = [];
const mockParams: { current: Record<string, string> } = { current: {} };
const mockSession: Session = {
  access_token: 'token',
  user: { id: '50000000-0000-4000-8000-000000000001', is_anonymous: true },
};

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

function mockProject(row: Row, fields: Field[], query: Query, path: string[] = []): Row {
  const projected: Row = {};
  for (const field of fields) {
    if (field.embed) {
      const childPath = [...path, field.column];
      const key = PARENT_KEY[field.column];
      if (!key) throw new Error(`The fake client can't embed ${field.column}`);
      const children = mockSort(
        (mockDb[field.column] ?? []).filter((child) => child[key] === row.id),
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
  const fields = mockParseFields(query.select ?? '*');
  if (mockIsDenied(query.table, fields)) {
    return Promise.resolve({
      data: null,
      error: { code: '42501', message: `permission denied for table ${query.table}` },
    });
  }
  if (query.table === 'attempts') {
    const state = mockRead.attempt;
    if (state === 'pending') return new Promise(() => {});
    if (state !== 'ok') return Promise.resolve({ data: null, error: state.error });
  }
  const rows = mockSort(
    (mockDb[query.table] ?? []).filter((row) =>
      query.filters.every(({ column, values }) => values.includes(row[column])),
    ),
    query.orders.filter((order) => !order.referencedTable),
  ).map((row) => mockProject(row, fields, query));
  if (query.mode === 'many') return Promise.resolve({ data: rows, error: null });
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
  const query: Query = { table, orders: [], filters: [], mode: 'many' };
  let throwOnError = false;
  const builder = {
    select(columns?: string) {
      query.select = columns;
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

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
    rpc: (name: string, args: Row) => mockRpc(name, args),
    auth: {
      getSession: () => Promise.resolve({ data: { session: mockSession }, error: null }),
      signInAnonymously: () =>
        Promise.resolve({ data: { session: mockSession, user: mockSession.user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

// Links render as a host view that keeps its href. Page titles go through
// <Stack.Screen>, which renders nothing without a navigator.
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

// The seeded quiz "Hauptstädte Europas" (supabase/seed.sql): two single
// choice questions, then a multiple choice one with three of four answers
// correct. Italy has no explanation.
const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const QUIZ = '20000000-0000-4000-8000-000000000001';
const ATTEMPTS = ['60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002'];

const FRANCE_EXPLANATION = 'Paris ist seit dem Mittelalter die Hauptstadt Frankreichs.';
const DANUBE_EXPLANATION = 'Wien, Bratislava und Budapest liegen an der Donau, Prag an der Moldau.';

const question = (
  id: number,
  text: string,
  multiple: boolean,
  sortOrder: number,
  explanation: string | null,
) => ({
  id: `30000000-0000-4000-8000-00000000000${id}`,
  quiz_id: QUIZ,
  text,
  image_path: null,
  image_alt: null,
  multiple_correct: multiple,
  explanation,
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

const france = question(1, 'Was ist die Hauptstadt von Frankreich?', false, 1, FRANCE_EXPLANATION);
const italy = question(2, 'Was ist die Hauptstadt von Italien?', false, 2, null);
const danube = question(
  3,
  'Welche dieser Hauptstädte liegen an der Donau?',
  true,
  3,
  DANUBE_EXPLANATION,
);
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
  mockDb.quizzes = [
    {
      id: QUIZ,
      category_id: GEOGRAFIE,
      title: 'Hauptstädte Europas',
      description: 'Kennst du die Hauptstädte unserer Nachbarn?',
      sort_order: 1,
      published: true,
    },
  ];
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
  mockDb.attempts = [];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function mockStartAttempt(args: Row): Promise<Result> {
  const id = ATTEMPTS[mockDb.attempts.length];
  mockDb.attempts.push({
    id,
    user_id: mockSession.user.id,
    quiz_id: args.quiz_id,
    score: 0,
    max_score:
      mockMaxScore.current ?? mockDb.questions.filter((row) => row.quiz_id === args.quiz_id).length,
    started_at: '2026-10-01T00:00:00Z',
    finished_at: null,
  });
  return Promise.resolve({ data: id, error: null });
}

function mockSubmitAnswer(args: Row): Promise<Result> {
  const attempt = mockDb.attempts.find((row) => row.id === args.attempt_id);
  const asked = mockDb.questions.find((row) => row.id === args.question_id);
  if (!attempt || !asked) {
    return Promise.resolve({ data: null, error: { code: 'P0001', message: 'not found' } });
  }
  const correctIds = mockDb.answers
    .filter((row) => row.question_id === asked.id && row.is_correct)
    .map((row) => row.id as string);
  const picked = [...new Set(args.answer_ids as string[])];
  const wrong = picked.length === 0 || picked.some((id) => !correctIds.includes(id));
  const points = wrong
    ? 0
    : picked.length === correctIds.length
      ? 1
      : round2(picked.length / correctIds.length);
  attempt.score = round2((attempt.score as number) + points);
  return Promise.resolve({
    data: [
      {
        is_correct: points === 1,
        points,
        correct_answer_ids: correctIds,
        explanation: asked.explanation,
      },
    ],
    error: null,
  });
}

// The database stores `score` on the attempt with every answer; this makes
// it store `score` instead of the running sum, so a screen that sums the
// returned points on its own shows a different number.
function serverScoreBecomes(score: number) {
  mockRpcHandlers.submit_answer = async (args) => {
    const result = await mockSubmitAnswer(args);
    const attempt = mockDb.attempts.find((row) => row.id === args.attempt_id);
    if (attempt) attempt.score = score;
    return result;
  };
}

const failure: PostgrestError = { code: 'PGRST000', message: 'connection refused' };

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

// The keys this slice adds aren't in the typed resources yet, so look them up
// untyped; a missing key comes back as the key itself, which no screen shows.
const t = (key: string, options?: Record<string, unknown>): string =>
  (i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);

const callsOf = (name: string) => mockRpcCalls.filter((call) => call.name === name);
const button = (key: string) => screen.getByRole('button', { name: t(key) });
const queryButton = (key: string) => screen.queryByRole('button', { name: t(key) });
const progress = (current: number, total: number) => i18n.t('quiz.progress', { current, total });

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An answer's radio or checkbox. Its accessible name starts or ends with the
// answer text; the mark it gets after submitting may come before or after.
const answerName = (text: string) => new RegExp(`^${escape(text)}(?!\\w)|(?<!\\w)${escape(text)}$`);

type Role = 'radio' | 'checkbox';
const answerElement = (role: Role, text: string) =>
  screen.getByRole(role, { name: answerName(text) });

async function startQuiz() {
  await renderWithQueryClient(<QuizScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));
  await screen.findByText(france.text);
}

async function answerWith(role: Role, texts: string[]) {
  for (const text of texts) await fireEvent.press(answerElement(role, text));
  await fireEvent.press(button('quiz.submit'));
}

const pressNext = async () =>
  fireEvent.press(await screen.findByRole('button', { name: t('quiz.next') }));
const pressSeeResult = async () =>
  fireEvent.press(await screen.findByRole('button', { name: t('quiz.seeResult') }));

// Flow A: France right, Italy wrong, the Danube partly (two of three).
async function playFlowA() {
  await startQuiz();
  await answerWith('radio', ['Paris']);
  await pressNext();
  await screen.findByText(italy.text);
  await answerWith('radio', ['Mailand']);
  await pressNext();
  await screen.findByText(danube.text);
  await answerWith('checkbox', ['Wien', 'Bratislava']);
  await pressSeeResult();
}

function textOf(node: TestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ');
}

// The text of the elements the node is described by (aria-describedby).
function describedTextOf(node: TestInstance): string {
  const describedBy = node.props['aria-describedby'] ?? node.props.accessibilityDescribedBy;
  if (!describedBy) return '';
  const ids: unknown[] = [describedBy].flat().flatMap((id) => String(id).split(/\s+/));
  return screen.container
    .queryAll((other) => ids.includes(other.props.nativeID) || ids.includes(other.props.id))
    .map(textOf)
    .join(' ');
}

const MARKS = ['pickedCorrect', 'pickedWrong', 'missed'] as const;
type Mark = (typeof MARKS)[number];

// The marks an answer carries: visible as text inside the answer, and part of its accessible name or description, so a screen
// reader hears it with the answer (not only a color).
function marksOf(role: Role, text: string): Mark[] {
  const element = answerElement(role, text);
  const inside = textOf(element);
  const described = describedTextOf(element);
  const label: unknown = element.props['aria-label'] ?? element.props.accessibilityLabel;
  const name = typeof label === 'string' ? label : inside;
  return MARKS.filter((mark) => {
    const markText = t(`quiz.feedback.${mark}`);
    const visible = inside.includes(markText);
    const announced = name.includes(markText) || described.includes(markText);
    return visible && announced;
  });
}

const roleOf = (node: TestInstance): unknown => node.props.role ?? node.props.accessibilityRole;

// Whether the node is (inside) a live region a screen reader announces.
function isAnnounced(node: TestInstance): boolean {
  for (let current: TestInstance | null = node; current; current = current.parent) {
    const live = current.props['aria-live'] ?? current.props.accessibilityLiveRegion;
    if (live === 'polite' || live === 'assertive') return true;
    if (['status', 'alert'].includes(roleOf(current) as string)) return true;
  }
  return false;
}

// Resolves a string or `{ pathname, params }` href to the path it opens.
function pathOf(href: unknown): string {
  if (typeof href === 'string') return href;
  const { pathname, params = {} } = href as { pathname: string; params?: Record<string, string> };
  return pathname.replace(/\[(\w+)\]/g, (_, name: string) => params[name]);
}

function linkPathOf(element: TestInstance): string {
  for (let node: TestInstance | null = element; node; node = node.parent) {
    if (node.props.href !== undefined) return pathOf(node.props.href);
  }
  throw new Error('The element is not inside a link');
}

const attemptReads = () => mockQueries.filter((query) => query.table === 'attempts');

const plainKeys = [
  'next',
  'seeResult',
  'feedback.correct',
  'feedback.wrong',
  'feedback.pickedCorrect',
  'feedback.pickedWrong',
  'feedback.missed',
  'result.title',
  'result.loading',
  'result.error',
  'result.playAgain',
  'result.backToCategory',
] as const;

const lookUp = (locale: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, part) => (node as Row | undefined)?.[part], locale);

describe('answer feedback and the result screen', () => {
  beforeEach(async () => {
    seedTables();
    mockRead.attempt = 'ok';
    mockMaxScore.current = null;
    mockQueries.length = 0;
    mockRpcCalls.length = 0;
    for (const name of Object.keys(mockRpcHandlers)) delete mockRpcHandlers[name];
    mockRpcHandlers.start_attempt = mockStartAttempt;
    mockRpcHandlers.submit_answer = mockSubmitAnswer;
    mockParams.current = { quizId: QUIZ };
    await i18n.changeLanguage('de');
  });

  describe('texts', () => {
    it('has a non-empty German and English text for each new key, different per language', () => {
      for (const key of plainKeys) {
        expect({ key, de: lookUp(de, `quiz.${key}`) }).toEqual({
          key,
          de: expect.stringMatching(/\S/),
        });
        expect({ key, en: lookUp(en, `quiz.${key}`) }).toEqual({
          key,
          en: expect.stringMatching(/\S/),
        });
        expect(lookUp(en, `quiz.${key}`)).not.toBe(lookUp(de, `quiz.${key}`));
      }
    });

    it('has a partly-correct verdict in German and English that shows its points', () => {
      for (const [lng, locale] of Object.entries({ de, en })) {
        const partial =
          lookUp(locale, 'quiz.feedback.partial') ?? lookUp(locale, 'quiz.feedback.partial_one');
        expect({ lng, partial }).toEqual({
          lng,
          partial: expect.stringMatching(/\{\{\s*points\s*\}\}/),
        });
      }
      expect(t('quiz.feedback.partial', { points: '0.67', count: 1, lng: 'en' })).not.toBe(
        t('quiz.feedback.partial', { points: '0,67', count: 1, lng: 'de' }),
      );
    });

    it('has a different text for each mark, none containing another', () => {
      for (const lng of ['de', 'en']) {
        const texts = MARKS.map((mark) => t(`quiz.feedback.${mark}`, { lng }));
        for (const [index, text] of texts.entries()) {
          expect(text).not.toMatch(/quiz\.feedback/);
          for (const other of texts.filter((_, otherIndex) => otherIndex !== index)) {
            expect(other).not.toContain(text);
          }
        }
      }
    });

    it('no longer has the finished text, which the result screen replaces', () => {
      expect(lookUp(de, 'quiz.finished')).toBeUndefined();
      expect(lookUp(en, 'quiz.finished')).toBeUndefined();
    });
  });

  describe('feedback', () => {
    it('says the answer is correct, marks the pick as correct and shows the explanation', async () => {
      await startQuiz();
      expect(screen.queryByText(FRANCE_EXPLANATION)).not.toBeOnTheScreen();

      await answerWith('radio', ['Paris']);

      expect(await screen.findByText(t('quiz.feedback.correct'))).toBeOnTheScreen();
      expect(screen.getByText(france.text)).toBeOnTheScreen();
      expect(marksOf('radio', 'Paris')).toEqual(['pickedCorrect']);
      expect(marksOf('radio', 'Lyon')).toEqual([]);
      expect(marksOf('radio', 'Marseille')).toEqual([]);
      expect(screen.getByText(FRANCE_EXPLANATION)).toBeOnTheScreen();
      expect(screen.queryByText(t('quiz.feedback.wrong'))).not.toBeOnTheScreen();
    });

    it('says a wrong single choice answer is wrong, marks the pick wrong and the correct answer missed', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await pressNext();
      await screen.findByText(italy.text);

      await answerWith('radio', ['Mailand']);

      expect(await screen.findByText(t('quiz.feedback.wrong'))).toBeOnTheScreen();
      expect(marksOf('radio', 'Mailand')).toEqual(['pickedWrong']);
      expect(marksOf('radio', 'Rom')).toEqual(['missed']);
      expect(marksOf('radio', 'Neapel')).toEqual([]);
      expect(screen.queryByText(t('quiz.feedback.correct'))).not.toBeOnTheScreen();
    });

    it('shows no explanation for a question without one', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await pressNext();
      await screen.findByText(italy.text);

      await answerWith('radio', ['Rom']);

      expect(await screen.findByText(t('quiz.feedback.correct'))).toBeOnTheScreen();
      expect(screen.queryByText(FRANCE_EXPLANATION)).not.toBeOnTheScreen();
      expect(screen.queryByText(DANUBE_EXPLANATION)).not.toBeOnTheScreen();
      expect(screen.queryByText(/null|undefined/)).not.toBeOnTheScreen();
    });

    it('says a correct subset is partly correct with its points in German, marking picks correct and the rest missed', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await pressNext();
      await answerWith('radio', ['Rom']);
      await pressNext();
      await screen.findByText(danube.text);

      await answerWith('checkbox', ['Wien', 'Bratislava']);

      expect(await screen.findByText(/(^|\D)0,67 von 1 Punkt(?!\w)/)).toBeOnTheScreen();
      expect(
        screen.getByText(t('quiz.feedback.partial', { points: '0,67', count: 1 })),
      ).toBeOnTheScreen();
      for (const text of ['Wien', 'Prag', 'Bratislava', 'Budapest']) {
        expect(answerElement('checkbox', text)).toBeDisabled();
      }
      expect(queryButton('quiz.submit')).not.toBeOnTheScreen();
      expect(marksOf('checkbox', 'Wien')).toEqual(['pickedCorrect']);
      expect(marksOf('checkbox', 'Bratislava')).toEqual(['pickedCorrect']);
      expect(marksOf('checkbox', 'Budapest')).toEqual(['missed']);
      expect(marksOf('checkbox', 'Prag')).toEqual([]);
      expect(screen.getByText(DANUBE_EXPLANATION)).toBeOnTheScreen();
      expect(screen.queryByText(t('quiz.feedback.correct'))).not.toBeOnTheScreen();
      expect(screen.queryByText(t('quiz.feedback.wrong'))).not.toBeOnTheScreen();
    });

    it('formats partial points without trailing zeros, e.g. 0,5', async () => {
      // A multiple choice question with two correct answers of four.
      mockDb.questions = [danube];
      mockDb.answers = [vienna, prague, bratislava, { ...budapest, is_correct: false }];
      await renderWithQueryClient(<QuizScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));
      await screen.findByText(danube.text);

      await answerWith('checkbox', ['Wien']);

      expect(await screen.findByText(/(^|\D)0,5 von 1 Punkt(?!\w)/)).toBeOnTheScreen();
      expect(screen.queryByText(/0,50/)).not.toBeOnTheScreen();
    });

    it('says a multiple choice answer with a wrong pick is wrong, and marks every answer', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await pressNext();
      await answerWith('radio', ['Rom']);
      await pressNext();
      await screen.findByText(danube.text);

      await answerWith('checkbox', ['Wien', 'Prag']);

      expect(await screen.findByText(t('quiz.feedback.wrong'))).toBeOnTheScreen();
      expect(marksOf('checkbox', 'Wien')).toEqual(['pickedCorrect']);
      expect(marksOf('checkbox', 'Prag')).toEqual(['pickedWrong']);
      expect(marksOf('checkbox', 'Bratislava')).toEqual(['missed']);
      expect(marksOf('checkbox', 'Budapest')).toEqual(['missed']);
    });

    it.each([
      ['correct', 1, 'radio' as const, ['Paris'], () => t('quiz.feedback.correct')],
      ['wrong', 2, 'radio' as const, ['Mailand'], () => t('quiz.feedback.wrong')],
      [
        'partly correct',
        3,
        'checkbox' as const,
        ['Wien', 'Bratislava'],
        () => t('quiz.feedback.partial', { points: '0,67', count: 1 }),
      ],
    ])('announces the %s verdict in a live region', async (_, position, role, picks, verdict) => {
      await startQuiz();
      for (let earlier = 1; earlier < position; earlier += 1) {
        await answerWith('radio', earlier === 1 ? ['Paris'] : ['Rom']);
        await pressNext();
      }
      await screen.findByText(progress(position, 3));

      await answerWith(role, picks);

      expect(isAnnounced(await screen.findByText(verdict()))).toBe(true);
    });

    it('locks the answers and removes Submit while the feedback shows', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await screen.findByText(t('quiz.feedback.correct'));

      for (const text of ['Paris', 'Lyon', 'Marseille']) {
        expect(answerElement('radio', text)).toBeDisabled();
      }
      await fireEvent.press(answerElement('radio', 'Lyon'));
      await flush();
      expect(answerElement('radio', 'Lyon')).not.toBeChecked();
      expect(answerElement('radio', 'Paris')).toBeChecked();
      expect(queryButton('quiz.submit')).not.toBeOnTheScreen();
      expect(callsOf('submit_answer')).toHaveLength(1);
    });

    it('offers Next, not See result, before the last question', async () => {
      await startQuiz();

      await answerWith('radio', ['Paris']);

      expect(await screen.findByRole('button', { name: t('quiz.next') })).toBeEnabled();
      expect(queryButton('quiz.seeResult')).not.toBeOnTheScreen();
      expect(screen.getByText(progress(1, 3))).toBeOnTheScreen();
    });

    it('shows the next question with nothing picked and Submit disabled after Next', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);

      await pressNext();

      expect(await screen.findByText(italy.text)).toBeOnTheScreen();
      expect(screen.getByText(progress(2, 3))).toBeOnTheScreen();
      for (const text of ['Mailand', 'Rom', 'Neapel']) {
        expect(answerElement('radio', text)).not.toBeChecked();
        expect(answerElement('radio', text)).toBeEnabled();
        expect(marksOf('radio', text)).toEqual([]);
      }
      expect(button('quiz.submit')).toBeDisabled();
      expect(screen.queryByText(t('quiz.feedback.correct'))).not.toBeOnTheScreen();
      expect(screen.queryByText(FRANCE_EXPLANATION)).not.toBeOnTheScreen();
      expect(queryButton('quiz.next')).not.toBeOnTheScreen();
    });

    it('offers See result, not Next, after the last question', async () => {
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await pressNext();
      await answerWith('radio', ['Rom']);
      await pressNext();
      await screen.findByText(danube.text);

      await answerWith('checkbox', ['Wien', 'Bratislava', 'Budapest']);

      expect(await screen.findByRole('button', { name: t('quiz.seeResult') })).toBeEnabled();
      expect(queryButton('quiz.next')).not.toBeOnTheScreen();
      expect(screen.getByText(danube.text)).toBeOnTheScreen();
    });

    it('shows the verdicts, marks and partial points in English', async () => {
      await i18n.changeLanguage('en');
      await startQuiz();

      await answerWith('radio', ['Paris']);
      expect(await screen.findByText(t('quiz.feedback.correct', { lng: 'en' }))).toBeOnTheScreen();
      expect(marksOf('radio', 'Paris')).toEqual(['pickedCorrect']);
      await pressNext();

      await answerWith('radio', ['Mailand']);
      expect(await screen.findByText(t('quiz.feedback.wrong', { lng: 'en' }))).toBeOnTheScreen();
      expect(marksOf('radio', 'Mailand')).toEqual(['pickedWrong']);
      expect(marksOf('radio', 'Rom')).toEqual(['missed']);
      await pressNext();

      await answerWith('checkbox', ['Wien', 'Bratislava']);
      expect(await screen.findByText(/(^|\D)0\.67 of 1 point(?!\w)/)).toBeOnTheScreen();
      expect(marksOf('checkbox', 'Budapest')).toEqual(['missed']);
      expect(
        screen.getByRole('button', { name: t('quiz.seeResult', { lng: 'en' }) }),
      ).toBeOnTheScreen();
    });
  });

  describe('result', () => {
    it("shows the attempt's score and max_score as x of y points, with the percentage", async () => {
      await playFlowA();

      expect(await screen.findByText(t('quiz.result.title'))).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)1,67 von 3 Punkten(?!\w)/)).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)56\s%/)).toBeOnTheScreen();
      expect(screen.queryByText(danube.text)).not.toBeOnTheScreen();
      expect(queryButton('quiz.seeResult')).not.toBeOnTheScreen();
      expect(queryButton('quiz.submit')).not.toBeOnTheScreen();
    });

    it('reads score and max_score of the attempt from the database with explicit columns', async () => {
      await playFlowA();
      await screen.findByText(t('quiz.result.title'));

      expect(attemptReads().length).toBeGreaterThan(0);
      for (const query of attemptReads()) {
        expect(query.select).toMatch(/\bscore\b/);
        expect(query.select).toMatch(/\bmax_score\b/);
        expect(query.select).not.toContain('*');
        expect(query.filters).toContainEqual({ column: 'id', values: [ATTEMPTS[0]] });
      }
    });

    it('shows the score the server stored, not the sum of the returned points', async () => {
      serverScoreBecomes(2.5);

      await playFlowA();

      expect(await screen.findByText(/(^|\D)2,5 von 3 Punkten(?!\w)/)).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)83\s%/)).toBeOnTheScreen();
      expect(screen.queryByText(/1,67/)).not.toBeOnTheScreen();
    });

    it.each([
      [1.67, '1,67', '56'],
      [2, '2', '67'],
      [0, '0', '0'],
    ])('rounds a score of %d of 3 to a whole-number percentage', async (score, shown, percent) => {
      serverScoreBecomes(score);

      await playFlowA();

      expect(
        await screen.findByText(new RegExp(`(^|[^\\d,])${shown} von 3 Punkten(?!\\w)`)),
      ).toBeOnTheScreen();
      expect(screen.getByText(new RegExp(`(^|\\D)${percent}\\s%`))).toBeOnTheScreen();
    });

    it('says "1 von 1 Punkt" for a one-question quiz, without decimals', async () => {
      mockDb.questions = [france];
      await startQuiz();
      await answerWith('radio', ['Paris']);
      await pressSeeResult();

      expect(await screen.findByText(/(^|[^\d,])1 von 1 Punkt(?!\w)/)).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)100\s%/)).toBeOnTheScreen();
    });

    it("uses the attempt's stored max_score, not the number of questions", async () => {
      mockMaxScore.current = 4;

      await playFlowA();

      expect(await screen.findByText(/(^|\D)1,67 von 4 Punkten(?!\w)/)).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)42\s%/)).toBeOnTheScreen();
    });

    it('shows a loading state while the attempt is read', async () => {
      mockRead.attempt = 'pending';

      await playFlowA();

      expect(await screen.findByText(t('quiz.result.loading'))).toBeOnTheScreen();
      expect(screen.queryByText(/von 3 Punkten/)).not.toBeOnTheScreen();
    });

    it('shows an error with retry when reading the attempt fails, and reads it again on retry', async () => {
      mockRead.attempt = { error: failure };

      await playFlowA();

      expect(await screen.findByText(t('quiz.result.error'))).toBeOnTheScreen();
      const reads = attemptReads().length;
      mockRead.attempt = 'ok';
      await fireEvent.press(screen.getByRole('button', { name: i18n.t('quiz.retry') }));

      expect(await screen.findByText(/(^|\D)1,67 von 3 Punkten(?!\w)/)).toBeOnTheScreen();
      expect(attemptReads().length).toBeGreaterThan(reads);
      expect(screen.queryByText(t('quiz.result.error'))).not.toBeOnTheScreen();
      expect(callsOf('start_attempt')).toHaveLength(1);
      expect(callsOf('submit_answer')).toHaveLength(3);
    });

    it('links back to the category of the quiz', async () => {
      await playFlowA();

      const back = await screen.findByText(t('quiz.result.backToCategory'));
      expect(linkPathOf(back)).toBe(`/categories/${GEOGRAFIE}`);
    });

    it('starts a new attempt on Play again and shows question 1 with nothing picked', async () => {
      await playFlowA();
      await screen.findByText(t('quiz.result.title'));

      await fireEvent.press(button('quiz.result.playAgain'));

      expect(await screen.findByText(france.text)).toBeOnTheScreen();
      expect(callsOf('start_attempt')).toHaveLength(2);
      expect(screen.getByText(progress(1, 3))).toBeOnTheScreen();
      for (const text of ['Paris', 'Lyon', 'Marseille']) {
        expect(answerElement('radio', text)).not.toBeChecked();
      }
      expect(button('quiz.submit')).toBeDisabled();
      expect(screen.queryByText(t('quiz.result.title'))).not.toBeOnTheScreen();

      // The second run, all correct, ends on the second attempt's own result.
      await answerWith('radio', ['Paris']);
      await pressNext();
      await answerWith('radio', ['Rom']);
      await pressNext();
      await answerWith('checkbox', ['Wien', 'Bratislava', 'Budapest']);
      await pressSeeResult();

      expect(await screen.findByText(/(^|[^\d,])3 von 3 Punkten(?!\w)/)).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)100\s%/)).toBeOnTheScreen();
      expect(
        callsOf('submit_answer')
          .slice(3)
          .map((call) => call.args.attempt_id),
      ).toEqual([ATTEMPTS[1], ATTEMPTS[1], ATTEMPTS[1]]);
      expect(
        attemptReads().some((query) =>
          query.filters.some(
            (filter) => filter.column === 'id' && filter.values.includes(ATTEMPTS[1]),
          ),
        ),
      ).toBe(true);
    });

    it('shows the start error with retry when Play again fails to start, and starts on retry', async () => {
      await playFlowA();
      await screen.findByText(t('quiz.result.title'));
      mockRpcHandlers.start_attempt = () => Promise.resolve({ data: null, error: failure });

      await fireEvent.press(button('quiz.result.playAgain'));

      expect(await screen.findByText(i18n.t('quiz.startError'))).toBeOnTheScreen();
      mockRpcHandlers.start_attempt = mockStartAttempt;
      await fireEvent.press(screen.getByRole('button', { name: i18n.t('quiz.retry') }));

      expect(await screen.findByText(france.text)).toBeOnTheScreen();
      expect(screen.getByText(progress(1, 3))).toBeOnTheScreen();
    });

    it('shows the result texts in English', async () => {
      await i18n.changeLanguage('en');

      await playFlowA();

      expect(await screen.findByText(t('quiz.result.title', { lng: 'en' }))).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)1\.67 of 3 points(?!\w)/)).toBeOnTheScreen();
      expect(screen.getByText(/(^|\D)56%/)).toBeOnTheScreen();
      expect(
        screen.getByRole('button', { name: t('quiz.result.playAgain', { lng: 'en' }) }),
      ).toBeOnTheScreen();
      expect(screen.getByText(t('quiz.result.backToCategory', { lng: 'en' }))).toBeOnTheScreen();
    });

    it('selects explicit columns and never the solutions, through to the result and Play again', async () => {
      await playFlowA();
      await screen.findByText(t('quiz.result.title'));
      await fireEvent.press(button('quiz.result.playAgain'));
      await screen.findByText(france.text);

      expect(attemptReads().length).toBeGreaterThan(0);
      for (const query of mockQueries) {
        expect(query.select).toEqual(expect.stringMatching(/\w/));
        expect(query.select).not.toContain('*');
        expect(query.select).not.toMatch(/is_correct|explanation/);
      }
    });
  });
});
