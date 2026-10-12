import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import EditCategoryScreen from '@/app/(admin)/admin/(guarded)/categories/[categoryId]/edit';
import i18n from '@/i18n';

// The edit form of a category (#80) when the category changed while the form
// was closed: reopening it within the cache's lifetime shows the server's
// values, not the cached ones, so saving can't undo a publish made on the
// list. The app keeps one QueryClient across screens (src/app/_layout.tsx),
// so this test does too. Boundary: the category reads and writes in
// @/lib/admin-categories; expo-router is replaced by plain stand-ins.

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  Stack: { Screen: () => null },
  router: { replace: jest.fn() },
  useLocalSearchParams: () => ({ categoryId: 'a' }),
}));

const mockRow = { id: 'a', name: 'Geografie', description: null, published: false };
const mockFetch = jest.fn(() => Promise.resolve({ ...mockRow }));

jest.mock('@/lib/admin-categories', () => ({
  adminCategoriesKey: ['admin', 'categories'],
  adminCategoryKey: (id: string) => ['admin', 'categories', id],
  fetchAdminCategory: () => mockFetch(),
  updateCategory: () => Promise.resolve(),
}));

const published = () =>
  screen.findByRole('switch', { name: i18n.t('admin.categories.form.published') });

const isChecked = (element: Awaited<ReturnType<typeof published>>) =>
  Boolean(element.props['aria-checked'] ?? element.props.accessibilityState?.checked);

// The app's settings: data stays fresh for a minute and cached for five.
const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: false } },
});
// Drops the cache and its garbage-collection timers, so Jest can exit.
afterEach(() => client.clear());

it('shows a publish made on the list when the edit form opens again', async () => {
  const app = () => (
    <QueryClientProvider client={client}>
      <EditCategoryScreen />
    </QueryClientProvider>
  );

  const first = await render(app());
  expect(isChecked(await published())).toBe(false);
  await first.unmount();
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));

  // The list publishes the category and invalidates the shared prefix.
  mockRow.published = true;
  await act(() => client.invalidateQueries({ queryKey: ['admin', 'categories'] }));

  await render(app());
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      isChecked(screen.getByRole('switch', { name: i18n.t('admin.categories.form.published') })),
    ).toBe(true),
  );
});
