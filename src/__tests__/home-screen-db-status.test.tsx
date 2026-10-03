import { fireEvent, screen } from '@testing-library/react-native';

import HomeScreen from '@/app/(learn)/index';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import { renderWithQueryClient } from '@/test-utils/render-with-query-client';

// The loading, empty and error states of the category list on `/`.
// Boundaries: the Supabase client (network) and the router (navigation).
// Every `supabase.from(...)` query answers with `mockResponse`, or never
// answers while it is 'pending'.

type PostgrestError = { message: string; code: string };
type Response = { data: unknown; error: PostgrestError | null } | 'pending';

const mockResponse: { current: Response } = { current: 'pending' };

function mockQueryBuilder() {
  const builder = {
    select: () => builder,
    order: () => builder,
    abortSignal: () => builder,
    then<T>(
      onFulfilled: (value: { data: unknown; error: PostgrestError | null }) => T,
      onRejected?: (reason: unknown) => T,
    ) {
      const response = mockResponse.current;
      const result: Promise<{ data: unknown; error: PostgrestError | null }> =
        response === 'pending' ? new Promise(() => {}) : Promise.resolve(response);
      return result.then(onFulfilled, onRejected);
    },
  };
  return builder;
}

jest.mock('@/lib/supabase', () => ({
  supabase: { from: () => mockQueryBuilder() },
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
    Head: () => null,
  };
});

const category = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Geografie',
  description: 'Länder, Städte und Flüsse',
  sort_order: 1,
};
const failure = { code: 'PGRST000', message: 'connection refused' };

const keys = ['title', 'loading', 'empty', 'error', 'retry'] as const;
const statuses = ['loading', 'empty', 'error'] as const;
type Status = (typeof statuses)[number];

const expectOnlyStatus = (shown: Status | null) => {
  for (const status of statuses.filter((other) => other !== shown)) {
    expect(screen.queryByText(i18n.t(`categories.${status}`))).not.toBeOnTheScreen();
  }
};

describe('<HomeScreen /> category list states', () => {
  beforeEach(async () => {
    mockResponse.current = 'pending';
    await i18n.changeLanguage('de');
  });

  it('has a non-empty German and English text for each state, different per language', () => {
    for (const key of keys) {
      expect(de).toHaveProperty(['categories', key], expect.stringMatching(/\S/));
      expect(en).toHaveProperty(['categories', key], expect.stringMatching(/\S/));
      expect(i18n.t(`categories.${key}`, { lng: 'en' })).not.toBe(
        i18n.t(`categories.${key}`, { lng: 'de' }),
      );
    }
    const germanStates = statuses.map((status) => i18n.t(`categories.${status}`, { lng: 'de' }));
    expect(new Set(germanStates).size).toBe(statuses.length);
  });

  it('shows a loading state, and the heading, while the categories are pending', async () => {
    await renderWithQueryClient(<HomeScreen />);

    expect(screen.getByText(i18n.t('categories.loading'))).toBeOnTheScreen();
    expect(screen.getByText(i18n.t('home.title'))).toBeOnTheScreen();
    expectOnlyStatus('loading');
  });

  it('shows an empty state when there are no categories', async () => {
    mockResponse.current = { data: [], error: null };

    await renderWithQueryClient(<HomeScreen />);

    expect(await screen.findByText(i18n.t('categories.empty'))).toBeOnTheScreen();
    expectOnlyStatus('empty');
  });

  it('shows no state message once categories are listed', async () => {
    mockResponse.current = { data: [category], error: null };

    await renderWithQueryClient(<HomeScreen />);

    expect(await screen.findByText(category.name)).toBeOnTheScreen();
    expectOnlyStatus(null);
  });

  it('shows an error state with a retry button when the request fails', async () => {
    mockResponse.current = { data: null, error: failure };

    await renderWithQueryClient(<HomeScreen />);

    expect(await screen.findByText(i18n.t('categories.error'))).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: i18n.t('categories.retry') })).toBeOnTheScreen();
    expectOnlyStatus('error');
  });

  it('loads the categories again when retry is pressed after an error', async () => {
    mockResponse.current = { data: null, error: failure };

    await renderWithQueryClient(<HomeScreen />);
    const retry = await screen.findByRole('button', { name: i18n.t('categories.retry') });

    mockResponse.current = { data: [category], error: null };
    await fireEvent.press(retry);

    expect(await screen.findByText(category.name)).toBeOnTheScreen();
    expect(screen.queryByText(i18n.t('categories.error'))).not.toBeOnTheScreen();
  });

  it('shows the states in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    mockResponse.current = { data: [], error: null };

    await renderWithQueryClient(<HomeScreen />);

    expect(await screen.findByText(i18n.t('categories.empty', { lng: 'en' }))).toBeOnTheScreen();
  });
});
