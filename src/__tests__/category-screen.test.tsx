import { fireEvent, screen } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import CategoryScreen from '@/app/(learn)/categories/[categoryId]';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import { renderWithQueryClient } from '@/test-utils/render-with-query-client';

// Boundaries: the Supabase client (network) and the router (navigation).
// The fake answers `supabase.from(table)` queries like PostgREST would: it
// applies `eq` filters, `maybeSingle`/`single`, embeds `quizzes(...)` in a
// category select, and rejects a non-UUID id with error 22P02. It returns the
// rows in the order given, so the screen must keep the order it receives.

type Row = Record<string, unknown>;
type PostgrestError = { message: string; code: string };
type TableResponse = { rows: Row[] } | { error: PostgrestError } | 'pending';
type Query = {
  table: string;
  select?: string;
  orders: [string, Record<string, unknown> | undefined][];
  filters: [string, unknown][];
  mode: 'many' | 'maybeSingle' | 'single';
};

const mockResponses: Record<string, TableResponse> = {};
const mockQueries: Query[] = [];
const mockParams: { current: Record<string, string> } = { current: {} };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mockRespond(query: Query): Promise<{ data: unknown; error: PostgrestError | null }> {
  const invalidId = query.filters.find(
    ([column, value]) => /(^|_)id$/.test(column) && !UUID.test(String(value)),
  );
  if (invalidId) {
    return Promise.resolve({
      data: null,
      error: { code: '22P02', message: `invalid input syntax for type uuid: "${invalidId[1]}"` },
    });
  }

  const embedsQuizzes = query.table === 'categories' && /\bquizzes\s*\(/.test(query.select ?? '');
  const involved = [mockResponses[query.table], embedsQuizzes ? mockResponses.quizzes : undefined];
  if (involved.includes('pending')) return new Promise(() => {});
  for (const response of involved) {
    if (response && response !== 'pending' && 'error' in response) {
      return Promise.resolve({ data: null, error: response.error });
    }
  }

  const rowsOf = (table: string) => {
    const response = mockResponses[table];
    return response && response !== 'pending' && 'rows' in response ? response.rows : [];
  };
  let rows = rowsOf(query.table).filter((row) =>
    query.filters.every(([column, value]) => !(column in row) || row[column] === value),
  );
  if (embedsQuizzes) {
    rows = rows.map((row) => ({
      ...row,
      quizzes: rowsOf('quizzes').filter((quiz) => quiz.category_id === row.id),
    }));
  }

  if (query.mode === 'many') return Promise.resolve({ data: rows, error: null });
  if (rows.length > 1) {
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } });
  }
  if (rows.length === 0 && query.mode === 'single') {
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
  }
  return Promise.resolve({ data: rows[0] ?? null, error: null });
}

function mockQueryBuilder(table: string) {
  const query: Query = { table, orders: [], filters: [], mode: 'many' };
  mockQueries.push(query);
  let throwOnError = false;
  const builder = {
    select(columns?: string) {
      query.select = columns;
      return builder;
    },
    order(column: string, options?: Record<string, unknown>) {
      query.orders.push([column, options]);
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
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
    abortSignal() {
      return builder;
    },
    limit() {
      return builder;
    },
    returns() {
      return builder;
    },
    throwOnError() {
      throwOnError = true;
      return builder;
    },
    then<T>(
      onFulfilled: (value: { data: unknown; error: PostgrestError | null }) => T,
      onRejected?: (reason: unknown) => T,
    ) {
      return mockRespond(query)
        .then((response) => {
          if (throwOnError && response.error) throw response.error;
          return response;
        })
        .then(onFulfilled, onRejected);
    },
  };
  return builder;
}

jest.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => mockQueryBuilder(table) },
}));

// Links render as a host view that keeps its href. Page titles go through
// <Stack.Screen options={{ title }}>, which renders nothing here, since there
// is no navigator around a single screen; e2e/browse.spec.ts checks them.
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

const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const OTHER_CATEGORY = '10000000-0000-4000-8000-000000000002';

const category = { id: GEOGRAFIE, name: 'Geografie', description: 'Länder und Städte' };
const quizzes = [
  {
    id: '20000000-0000-4000-8000-000000000002',
    category_id: GEOGRAFIE,
    title: 'Hauptstädte Europas',
    description: 'Kennst du die Hauptstädte?',
    sort_order: 1,
  },
  {
    id: '20000000-0000-4000-8000-000000000001',
    category_id: GEOGRAFIE,
    title: 'Berge der Alpen',
    description: 'Gipfel und Pässe',
    sort_order: 2,
  },
];
const quizOfOtherCategory = {
  id: '20000000-0000-4000-8000-000000000003',
  category_id: OTHER_CATEGORY,
  title: 'Chemie-Grundlagen',
  description: 'Elemente',
  sort_order: 1,
};

const keys = [
  'loading',
  'empty',
  'error',
  'retry',
  'notFound',
  'backToCategories',
] as const satisfies readonly (keyof typeof de.category)[];

// Resolves a string or `{ pathname, params }` href to the path it opens.
function pathOf(href: unknown): string {
  if (typeof href === 'string') return href;
  const { pathname, params = {} } = href as {
    pathname: string;
    params?: Record<string, string>;
  };
  return pathname.replace(/\[(\w+)\]/g, (_, name: string) => params[name]);
}

function linkPathOf(element: TestInstance): string {
  for (let node: TestInstance | null = element; node; node = node.parent) {
    if (node.props.href !== undefined) return pathOf(node.props.href);
  }
  throw new Error('The element is not inside a link');
}

const statusKeys = ['loading', 'empty', 'error', 'notFound'] as const;
const expectOnlyStatus = (shown: (typeof statusKeys)[number] | null) => {
  for (const key of statusKeys.filter((other) => other !== shown)) {
    expect(screen.queryByText(i18n.t(`category.${key}`))).not.toBeOnTheScreen();
  }
};

describe('<CategoryScreen />', () => {
  beforeEach(async () => {
    for (const table of Object.keys(mockResponses)) delete mockResponses[table];
    mockQueries.length = 0;
    mockParams.current = { categoryId: GEOGRAFIE };
    await i18n.changeLanguage('de');
  });

  it('has a non-empty German and English text for each state, different per language', () => {
    for (const key of keys) {
      expect(de).toHaveProperty(['category', key], expect.stringMatching(/\S/));
      expect(en).toHaveProperty(['category', key], expect.stringMatching(/\S/));
      expect(i18n.t(`category.${key}`, { lng: 'en' })).not.toBe(
        i18n.t(`category.${key}`, { lng: 'de' }),
      );
    }
  });

  it('shows the category name and its quizzes with title and description', async () => {
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: quizzes };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(category.name)).toBeOnTheScreen();
    for (const quiz of quizzes) {
      expect(await screen.findByText(quiz.title)).toBeOnTheScreen();
      expect(screen.getByText(quiz.description)).toBeOnTheScreen();
    }
    expectOnlyStatus(null);
  });

  it('links each quiz to its quiz screen', async () => {
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: quizzes };

    await renderWithQueryClient(<CategoryScreen />);

    for (const quiz of quizzes) {
      expect(linkPathOf(await screen.findByText(quiz.title))).toBe(`/quizzes/${quiz.id}`);
    }
  });

  it('shows only the quizzes of the opened category', async () => {
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: [...quizzes, quizOfOtherCategory] };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(quizzes[0].title)).toBeOnTheScreen();
    expect(screen.queryByText(quizOfOtherCategory.title)).not.toBeOnTheScreen();
  });

  it('requests the quizzes by sort_order and shows them in the order received', async () => {
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: quizzes };

    await renderWithQueryClient(<CategoryScreen />);

    const titles = quizzes.map((quiz) => quiz.title);
    await screen.findByText(titles[0]);
    const rendered = screen.getAllByText(new RegExp(`^(${titles.join('|')})$`));
    expect(rendered.map((element) => element.props.children)).toEqual(titles);

    const ascending = (options?: Record<string, unknown>) => options?.ascending !== false;
    const ordersQuizzes = mockQueries.some(
      (query) =>
        (query.table === 'quizzes' &&
          query.orders.some(
            ([column, options]) =>
              column === 'sort_order' &&
              ascending(options) &&
              !options?.referencedTable &&
              !options?.foreignTable,
          )) ||
        (query.table === 'categories' &&
          query.orders.some(
            ([column, options]) =>
              column === 'sort_order' &&
              ascending(options) &&
              (options?.referencedTable === 'quizzes' || options?.foreignTable === 'quizzes'),
          )),
    );
    expect(ordersQuizzes).toBe(true);
  });

  it('selects explicit columns, never *', async () => {
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: quizzes };

    await renderWithQueryClient(<CategoryScreen />);
    await screen.findByText(quizzes[0].title);

    expect(mockQueries.length).toBeGreaterThan(0);
    for (const query of mockQueries) {
      expect(query.select).toEqual(expect.stringMatching(/\w/));
      expect(query.select).not.toContain('*');
    }
  });

  it('shows a loading state while the category is pending', async () => {
    mockResponses.categories = 'pending';
    mockResponses.quizzes = 'pending';

    await renderWithQueryClient(<CategoryScreen />);

    expect(screen.getByText(i18n.t('category.loading'))).toBeOnTheScreen();
    expectOnlyStatus('loading');
  });

  it('shows the empty state and the category name when it has no quizzes', async () => {
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: [] };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(i18n.t('category.empty'))).toBeOnTheScreen();
    expect(screen.getByText(category.name)).toBeOnTheScreen();
    expectOnlyStatus('empty');
  });

  it('shows an error state when the category request fails', async () => {
    mockResponses.categories = { error: { code: 'PGRST000', message: 'connection refused' } };
    mockResponses.quizzes = { rows: quizzes };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(i18n.t('category.error'))).toBeOnTheScreen();
    expect(screen.queryByText(quizzes[0].title)).not.toBeOnTheScreen();
    expectOnlyStatus('error');
  });

  it('shows an error state when the quizzes request fails', async () => {
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { error: { code: 'PGRST000', message: 'connection refused' } };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(i18n.t('category.error'))).toBeOnTheScreen();
    expectOnlyStatus('error');
  });

  it('loads the quizzes again when retry is pressed after an error', async () => {
    mockResponses.categories = { error: { code: 'PGRST000', message: 'connection refused' } };
    mockResponses.quizzes = { error: { code: 'PGRST000', message: 'connection refused' } };

    await renderWithQueryClient(<CategoryScreen />);
    const retry = await screen.findByRole('button', { name: i18n.t('category.retry') });

    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: quizzes };
    await fireEvent.press(retry);

    expect(await screen.findByText(quizzes[0].title)).toBeOnTheScreen();
    expect(screen.queryByText(i18n.t('category.error'))).not.toBeOnTheScreen();
  });

  it('shows a not-found state with a link back to the category list for an unknown or invisible category', async () => {
    mockParams.current = { categoryId: '10000000-0000-4000-8000-000000000099' };
    mockResponses.categories = { rows: [] };
    mockResponses.quizzes = { rows: [] };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(i18n.t('category.notFound'))).toBeOnTheScreen();
    expect(linkPathOf(screen.getByText(i18n.t('category.backToCategories')))).toBe('/');
    expectOnlyStatus('notFound');
  });

  it('shows the not-found state for a category id that is not a UUID', async () => {
    mockParams.current = { categoryId: 'gibt-es-nicht' };
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: quizzes };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(i18n.t('category.notFound'))).toBeOnTheScreen();
    expectOnlyStatus('notFound');
  });

  it('shows its texts in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    mockResponses.categories = { rows: [category] };
    mockResponses.quizzes = { rows: [] };

    await renderWithQueryClient(<CategoryScreen />);

    expect(await screen.findByText(i18n.t('category.empty', { lng: 'en' }))).toBeOnTheScreen();
  });
});
