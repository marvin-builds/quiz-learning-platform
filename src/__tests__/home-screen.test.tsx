import { screen } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import HomeScreen from '@/app/(learn)/index';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import { renderWithQueryClient } from '@/test-utils/render-with-query-client';

// Boundaries: the Supabase client (network) and the router (navigation).
// The fake records each `supabase.from(table)` query and answers with the
// rows of `mockResponse`, in the order given.

type PostgrestError = { message: string; code: string };
type Query = {
  table: string;
  select?: string;
  orders: [string, Record<string, unknown> | undefined][];
};

const mockResponse: { current: { data: unknown; error: PostgrestError | null } } = {
  current: { data: [], error: null },
};
const mockQueries: Query[] = [];

function mockQueryBuilder(table: string) {
  const query: Query = { table, orders: [] };
  mockQueries.push(query);
  const builder = {
    select(columns?: string) {
      query.select = columns;
      return builder;
    },
    order(column: string, options?: Record<string, unknown>) {
      query.orders.push([column, options]);
      return builder;
    },
    abortSignal() {
      return builder;
    },
    then<T>(
      onFulfilled: (value: { data: unknown; error: PostgrestError | null }) => T,
      onRejected?: (reason: unknown) => T,
    ) {
      return Promise.resolve(mockResponse.current).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

jest.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => mockQueryBuilder(table) },
}));

// Links render as a host view that keeps its href; screen titles and <Head>
// render nothing, since there is no navigator around a single screen here.
jest.mock('expo-router', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Screen = () => null;
  return {
    ...jest.requireActual('expo-router'),
    Link: ({ href, children }: { href: unknown; children?: unknown }) =>
      createElement(View, { href } as object, children as never),
    Stack: Object.assign(() => null, { Screen }),
    Head: () => null,
  };
});

const categories = [
  {
    id: '10000000-0000-4000-8000-000000000002',
    name: 'Naturwissenschaften',
    description: 'Chemie, Physik und Biologie',
    sort_order: 1,
  },
  {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Geografie',
    description: 'Länder, Städte und Flüsse',
    sort_order: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    name: 'Geschichte',
    description: 'Von der Antike bis heute',
    sort_order: 3,
  },
];

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

describe('<HomeScreen /> category list', () => {
  beforeEach(async () => {
    mockQueries.length = 0;
    mockResponse.current = { data: categories, error: null };
    await i18n.changeLanguage('de');
  });

  it('has a German and an English page title for the category list, different per language', () => {
    expect(de).toHaveProperty(['categories', 'title'], expect.stringMatching(/\S/));
    expect(en).toHaveProperty(['categories', 'title'], expect.stringMatching(/\S/));
    expect(i18n.t('categories.title', { lng: 'en' })).not.toBe(
      i18n.t('categories.title', { lng: 'de' }),
    );
  });

  it('shows the German heading', async () => {
    await renderWithQueryClient(<HomeScreen />);

    expect(screen.getByText(de.home.title)).toBeOnTheScreen();
  });

  it('shows the English heading when the language is English', async () => {
    await i18n.changeLanguage('en');

    await renderWithQueryClient(<HomeScreen />);

    expect(screen.getByText(en.home.title)).toBeOnTheScreen();
  });

  it('lists each category with its name and description', async () => {
    await renderWithQueryClient(<HomeScreen />);

    for (const category of categories) {
      expect(await screen.findByText(category.name)).toBeOnTheScreen();
      expect(screen.getByText(category.description)).toBeOnTheScreen();
    }
  });

  it('shows a category without a description by its name', async () => {
    mockResponse.current = {
      data: [{ ...categories[0], description: null }],
      error: null,
    };

    await renderWithQueryClient(<HomeScreen />);

    expect(await screen.findByText(categories[0].name)).toBeOnTheScreen();
  });

  it('links each category to its category screen', async () => {
    await renderWithQueryClient(<HomeScreen />);

    for (const category of categories) {
      expect(linkPathOf(await screen.findByText(category.name))).toBe(`/categories/${category.id}`);
    }
  });

  it('requests the categories by sort_order and shows them in the order received', async () => {
    await renderWithQueryClient(<HomeScreen />);

    const names = categories.map((category) => category.name);
    await screen.findByText(names[0]);
    const rendered = screen.getAllByText(new RegExp(`^(${names.join('|')})$`));
    expect(rendered.map((element) => element.props.children)).toEqual(names);

    const categoryQueries = mockQueries.filter((query) => query.table === 'categories');
    expect(categoryQueries.length).toBeGreaterThan(0);
    expect(
      categoryQueries.some((query) =>
        query.orders.some(
          ([column, options]) => column === 'sort_order' && options?.ascending !== false,
        ),
      ),
    ).toBe(true);
  });

  it('selects explicit columns, never *', async () => {
    await renderWithQueryClient(<HomeScreen />);
    await screen.findByText(categories[0].name);

    expect(mockQueries.length).toBeGreaterThan(0);
    for (const query of mockQueries) {
      expect(query.select).toEqual(expect.stringMatching(/\w/));
      expect(query.select).not.toContain('*');
    }
  });
});
