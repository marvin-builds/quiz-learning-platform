import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';

import QuizScreen from '@/app/(learn)/quizzes/[quizId]';
import i18n from '@/i18n';

// Images in the quiz player: a question and its answers can carry an image
// (image_path, image_alt). The player shows it from the public URL of the
// quiz-images bucket, labelled with image_alt, and falls back to image_alt as
// text when the image can't be loaded, without breaking the question.
//
// Boundaries: the Supabase client (network) and the router. The fake client
// is a smaller version of the one in quiz-screen.test.tsx:
// - `from(table)` queries apply `eq`/`in` filters, `order` (also on embedded
//   tables via `referencedTable`), `maybeSingle`/`single` and embeds, and
//   return only the selected columns. Selecting `questions.explanation`,
//   `answers.is_correct` or `*` on those tables fails with 42501.
// - `rpc(name, args)` answers start_attempt and submit_answer; calls are
//   recorded in `mockRpcCalls`.
// - `storage.from(bucket).getPublicUrl(path)` returns the URL the local stack
//   would build, and records each call in `mockPublicUrlCalls`.
// - `auth` hands out an anonymous session.

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code: string; message: string } | null };
type Field = { key: string; column: string; embed?: Field[] };
type Order = { column: string; ascending: boolean; referencedTable?: string };
type Query = {
  table: string;
  select: string;
  orders: Order[];
  filters: { column: string; values: unknown[] }[];
  mode: 'many' | 'maybeSingle' | 'single';
};

const mockDb: Record<string, Row[]> = { quizzes: [], questions: [], answers: [] };
const mockRpcCalls: { name: string; args: Row }[] = [];
const mockPublicUrlCalls: { bucket: string; path: unknown }[] = [];
const mockParams: { current: Record<string, string> } = { current: {} };

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
    } else {
      projected[field.key] = row[field.column];
    }
  }
  return projected;
}

function mockRespond(query: Query): Result {
  const fields = mockParseFields(query.select);
  if (mockIsDenied(query.table, fields)) {
    return { data: null, error: { code: '42501', message: `permission denied` } };
  }
  const rows = mockSort(
    (mockDb[query.table] ?? []).filter((row) =>
      query.filters.every(({ column, values }) => values.includes(row[column])),
    ),
    query.orders.filter((order) => !order.referencedTable),
  ).map((row) => mockProject(row, fields, query));
  if (query.mode === 'many') return { data: rows, error: null };
  if (rows.length === 0 && query.mode === 'single') {
    return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
  }
  return { data: rows[0] ?? null, error: null };
}

function mockQueryBuilder(table: string) {
  const query: Query = { table, select: '*', orders: [], filters: [], mode: 'many' };
  let throwOnError = false;
  const builder = {
    select(columns?: string) {
      query.select = columns ?? '*';
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
      return Promise.resolve(mockRespond(query))
        .then((response) => {
          if (throwOnError && response.error) throw response.error;
          return response;
        })
        .then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function mockRpc(name: string, args: Row) {
  let single = false;
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
    throwOnError: () => builder,
    then<T>(onFulfilled: (value: Result) => T, onRejected?: (reason: unknown) => T) {
      mockRpcCalls.push({ name, args });
      const rows =
        name === 'submit_answer'
          ? [{ is_correct: true, points: 1, correct_answer_ids: [], explanation: null }]
          : null;
      const result: Result =
        name === 'start_attempt'
          ? { data: '60000000-0000-4000-8000-000000000001', error: null }
          : rows
            ? { data: single ? rows[0] : rows, error: null }
            : { data: null, error: { code: 'PGRST202', message: 'no such function' } };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const mockSession = {
  access_token: 'token',
  user: { id: '50000000-0000-4000-8000-000000000001', is_anonymous: true },
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
    rpc: (name: string, args: Row) => mockRpc(name, args),
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (path: unknown) => {
          mockPublicUrlCalls.push({ bucket, path });
          return {
            data: {
              publicUrl: `http://storage.test/storage/v1/object/public/${bucket}/${String(path)}`,
            },
          };
        },
      }),
    },
    auth: {
      getSession: () => Promise.resolve({ data: { session: mockSession }, error: null }),
      signInAnonymously: () =>
        Promise.resolve({ data: { session: mockSession, user: mockSession.user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

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

// Seed-like content: the quiz "Chemie-Grundlagen" with an image on its first
// question and on the answer Helium (as in supabase/seed.sql), and a second,
// single choice question without an image of its own but with an image on
// one answer.
const QUIZ = '20000000-0000-4000-8000-000000000003';
const BUCKET = 'quiz-images';
const publicUrl = (path: string) =>
  `http://storage.test/storage/v1/object/public/${BUCKET}/${path}`;

const question = (
  id: number,
  text: string,
  multiple: boolean,
  sortOrder: number,
  image: { path: string; alt: string } | null,
) => ({
  id: `30000000-0000-4000-8000-00000000000${id}`,
  quiz_id: QUIZ,
  text,
  image_path: image?.path ?? null,
  image_alt: image?.alt ?? null,
  multiple_correct: multiple,
  explanation: null,
  sort_order: sortOrder,
  created_at: '2026-10-01T00:00:00Z',
});
const answer = (
  id: number,
  questionId: string,
  text: string,
  correct: boolean,
  sortOrder: number,
  image: { path: string; alt: string } | null = null,
) => ({
  id: `40000000-0000-4000-8000-0000000000${String(id).padStart(2, '0')}`,
  question_id: questionId,
  text,
  image_path: image?.path ?? null,
  image_alt: image?.alt ?? null,
  is_correct: correct,
  sort_order: sortOrder,
  created_at: '2026-10-01T00:00:00Z',
});

const periodicTable = {
  path: '063fa988-b996-4b4e-908f-1118f445ae46.png',
  alt: 'Ausschnitt aus dem Periodensystem mit den Edelgasen',
};
const balloon = {
  path: '39c5ec8d-57d6-4ab5-8ff7-f32a80a0a25d.png',
  alt: 'Mit Helium gefüllter Ballon',
};
const goldBar = {
  path: '7a1d2e3f-4b5c-4d6e-8f70-8192a3b4c5d6.webp',
  alt: 'Ein Goldbarren',
};

const nobleGases = question(4, 'Welche dieser Elemente sind Edelgase?', true, 1, periodicTable);
const gold = question(5, 'Welches chemische Symbol hat Gold?', false, 2, null);
const helium = answer(11, nobleGases.id, 'Helium', true, 1, balloon);
const nitrogen = answer(12, nobleGases.id, 'Stickstoff', false, 2);
const neon = answer(13, nobleGases.id, 'Neon', true, 3);
const oxygen = answer(14, nobleGases.id, 'Sauerstoff', false, 4);
const ag = answer(15, gold.id, 'Ag', false, 1);
const au = answer(16, gold.id, 'Au', true, 2, goldBar);
const go = answer(17, gold.id, 'Go', false, 3);

function seedTables() {
  mockDb.quizzes = [
    {
      id: QUIZ,
      category_id: '10000000-0000-4000-8000-000000000002',
      title: 'Chemie-Grundlagen',
      description: 'Elemente und ihre Eigenschaften',
      sort_order: 1,
      published: true,
    },
  ];
  mockDb.questions = [gold, nobleGases];
  mockDb.answers = [oxygen, au, helium, go, neon, ag, nitrogen];
}

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

// An answer's radio or checkbox. Its accessible name is the answer text, and
// may include the alt text of the answer's image before or after it, as a
// browser computes the name from the content.
function answerName(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}( |$)|(^| )${escaped}$`);
}

const submitButton = () => screen.getByRole('button', { name: i18n.t('quiz.submit') });
const questionHeading = (text: string) => screen.getByRole('heading', { name: text });

async function startQuiz() {
  await renderWithQueryClient(<QuizScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));
  await screen.findByText(nobleGases.text);
}

// The keys this slice adds aren't in the typed resources yet, so look them up
// untyped; a missing key comes back as the key itself, which no screen shows.
const t = (key: string): string => (i18n.t as unknown as (key: string) => string)(key);

// After an answer is recorded, its feedback shows until Next is pressed.
const pressNext = async () =>
  fireEvent.press(await screen.findByRole('button', { name: t('quiz.next') }));

async function toSecondQuestion() {
  await fireEvent.press(screen.getByRole('checkbox', { name: answerName(helium.text) }));
  await fireEvent.press(submitButton());
  await pressNext();
  await screen.findByText(gold.text);
}

const roleOf = (node: TestInstance): unknown => node.props.role ?? node.props.accessibilityRole;

// The image's source as React Native's <Image> takes it: `source` as an
// object or an array of them, or the `src` shorthand.
function sourceUriOf(node: TestInstance): unknown {
  const { source, src } = node.props as { source?: unknown; src?: unknown };
  if (typeof src === 'string') return src;
  const first: unknown = Array.isArray(source) ? source[0] : source;
  return (first as { uri?: unknown } | undefined)?.uri;
}

// Every host image on the screen, labelled or not.
const allImages = () => screen.container.queryAll((node) => node.type === 'Image');

function closestWithRole(node: TestInstance, roles: string[]): TestInstance | null {
  let current: TestInstance | null = node.parent;
  while (current && !roles.includes(roleOf(current) as string)) current = current.parent;
  return current;
}

// A fixed height the image keeps before (and without) loading, so it can't
// collapse to 0×0 on the web: a positive number or px height as a style, or a
// NativeWind height class with a number or a fixed length (Jest leaves
// className as it is). `auto`, percentages, `h-auto`, `h-full` and `h-0` don't
// count.
function hasFixedHeight(node: TestInstance): boolean {
  const { height } = (StyleSheet.flatten(node.props.style) ?? {}) as { height?: unknown };
  if (typeof height === 'number' && height > 0) return true;
  if (typeof height === 'string' && /^\d*\.?\d+px$/.test(height) && parseFloat(height) > 0) {
    return true;
  }
  const className = String(node.props.className ?? '');
  return className
    .split(/\s+/)
    .some(
      (name) =>
        /^(h|size)-(\d*\.?\d+|\[\d*\.?\d+(px|rem)\])$/.test(name) &&
        parseFloat(name.replace(/^(h|size)-\[?/, '')) > 0,
    );
}

describe('images in the quiz player', () => {
  beforeEach(async () => {
    seedTables();
    mockRpcCalls.length = 0;
    mockPublicUrlCalls.length = 0;
    mockParams.current = { quizId: QUIZ };
    await i18n.changeLanguage('de');
  });

  it('shows the question image from the public URL of quiz-images, labelled with image_alt', async () => {
    await startQuiz();

    const image = screen.getByRole('image', { name: periodicTable.alt });
    expect(sourceUriOf(image)).toBe(publicUrl(periodicTable.path));
  });

  it('shows an answer image from the public URL inside its checkbox, and the answer stays pickable', async () => {
    await startQuiz();

    const image = screen.getByRole('image', { name: balloon.alt });
    expect(sourceUriOf(image)).toBe(publicUrl(balloon.path));
    const checkbox = screen.getByRole('checkbox', { name: answerName(helium.text) });
    expect(closestWithRole(image, ['checkbox', 'radio'])).toBe(checkbox);

    await fireEvent.press(checkbox);
    expect(checkbox).toBeChecked();
    await fireEvent.press(submitButton());
    await flush();

    expect(mockRpcCalls.filter((call) => call.name === 'submit_answer')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ question_id: nobleGases.id, answer_ids: [helium.id] }),
      }),
    ]);
  });

  it('shows an answer image inside its radio, and the answer stays pickable', async () => {
    await startQuiz();
    await toSecondQuestion();

    const image = screen.getByRole('image', { name: goldBar.alt });
    expect(sourceUriOf(image)).toBe(publicUrl(goldBar.path));
    const radio = screen.getByRole('radio', { name: answerName(au.text) });
    expect(closestWithRole(image, ['checkbox', 'radio'])).toBe(radio);

    await fireEvent.press(radio);
    expect(radio).toBeChecked();
    expect(submitButton()).toBeEnabled();
  });

  it('renders no image for a question or answer without image_path', async () => {
    await startQuiz();

    // Question with an image, one answer with an image, three without.
    expect(allImages()).toHaveLength(2);
    for (const other of [nitrogen, neon, oxygen]) {
      const checkbox = screen.getByRole('checkbox', { name: answerName(other.text) });
      expect(checkbox).toBeOnTheScreen();
      expect(allImages().some((image) => closestWithRole(image, ['checkbox']) === checkbox)).toBe(
        false,
      );
    }

    await toSecondQuestion();

    // No question image; only the answer Au has one.
    expect(allImages()).toHaveLength(1);
    expect(screen.getByRole('image', { name: goldBar.alt })).toBeOnTheScreen();
  });

  it('requests public URLs only for non-null image paths, from the quiz-images bucket', async () => {
    await startQuiz();
    await toSecondQuestion();

    expect(mockPublicUrlCalls.length).toBeGreaterThan(0);
    for (const call of mockPublicUrlCalls) {
      expect(call.bucket).toBe(BUCKET);
      expect([periodicTable.path, balloon.path, goldBar.path]).toContain(call.path);
    }
    const paths = new Set(mockPublicUrlCalls.map((call) => call.path));
    expect(paths).toEqual(new Set([periodicTable.path, balloon.path, goldBar.path]));
  });

  it('gives every image a fixed height, so it cannot collapse to 0×0 on the web', async () => {
    await startQuiz();

    const images = [
      screen.getByRole('image', { name: periodicTable.alt }),
      screen.getByRole('image', { name: balloon.alt }),
    ];
    for (const image of images) expect(hasFixedHeight(image)).toBe(true);
  });

  it('shows image_alt as text instead of a question image that fails to load, and the question still works', async () => {
    await startQuiz();

    await fireEvent(screen.getByRole('image', { name: periodicTable.alt }), 'error', {
      nativeEvent: { error: 'HTTP 404' },
    });

    expect(screen.queryByRole('image', { name: periodicTable.alt })).not.toBeOnTheScreen();
    expect(allImages().some((image) => sourceUriOf(image) === publicUrl(periodicTable.path))).toBe(
      false,
    );
    expect(screen.getByText(periodicTable.alt)).toBeOnTheScreen();

    expect(questionHeading(nobleGases.text)).toBeOnTheScreen();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    await fireEvent.press(screen.getByRole('checkbox', { name: answerName(neon.text) }));
    expect(screen.getByRole('checkbox', { name: answerName(neon.text) })).toBeChecked();
    expect(submitButton()).toBeEnabled();
    await fireEvent.press(submitButton());
    await pressNext();
    expect(await screen.findByText(gold.text)).toBeOnTheScreen();
  });

  it('shows image_alt as text instead of an answer image that fails to load, and the answer stays pickable', async () => {
    await startQuiz();

    await fireEvent(screen.getByRole('image', { name: balloon.alt }), 'error', {
      nativeEvent: { error: 'HTTP 404' },
    });

    expect(screen.queryByRole('image', { name: balloon.alt })).not.toBeOnTheScreen();
    expect(allImages().some((image) => sourceUriOf(image) === publicUrl(balloon.path))).toBe(false);
    const altText = screen.getByText(balloon.alt);
    // The fallback text takes the image's place inside the answer.
    const checkbox = closestWithRole(altText, ['checkbox', 'radio']);
    expect(checkbox).not.toBeNull();
    expect(roleOf(checkbox!)).toBe('checkbox');

    expect(questionHeading(nobleGases.text)).toBeOnTheScreen();
    expect(screen.getByRole('image', { name: periodicTable.alt })).toBeOnTheScreen();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    await fireEvent.press(checkbox!);
    expect(checkbox).toBeChecked();
    expect(submitButton()).toBeEnabled();
  });
});
