import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import AdminCategoriesScreen from '@/app/(admin)/admin/(guarded)/categories';
import i18n from '@/i18n';

// The publish toggle on the admin category list (#80) while several toggles
// are in flight: every row whose toggle hasn't finished stays disabled, not
// only the row toggled last, so a second click can't send the stale value
// again. Boundary: the category reads and writes in @/lib/admin-categories;
// expo-router's Link and Stack are replaced by plain views.

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  Stack: { Screen: () => null },
}));

const mockCategories = [
  { id: 'a', name: 'Geografie', description: null, sort_order: 1, published: false },
  { id: 'b', name: 'Musik', description: null, sort_order: 2, published: false },
];
const mockPending: (() => void)[] = [];

jest.mock('@/lib/admin-categories', () => ({
  adminCategoriesKey: ['admin', 'categories'],
  fetchAdminCategories: () => Promise.resolve(mockCategories),
  updateCategory: () => new Promise<void>((resolve) => mockPending.push(resolve)),
  deleteCategory: () => Promise.resolve(),
}));

const publish = (name: string) =>
  screen.getByRole('button', { name: i18n.t('admin.categories.actions.publish', { name }) });

const isDisabled = (element: ReturnType<typeof publish>) =>
  Boolean(element.props['aria-disabled'] ?? element.props.accessibilityState?.disabled);

it('keeps every row disabled whose toggle is still running', async () => {
  // gcTime Infinity: no garbage-collection timers left behind to keep Jest running.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  await render(
    <QueryClientProvider client={client}>
      <AdminCategoriesScreen />
    </QueryClientProvider>,
  );
  await screen.findByText('Musik');

  await fireEvent.press(publish('Geografie'));
  await fireEvent.press(publish('Musik'));

  // The mutation cache notifies asynchronously, so wait for both rows.
  await waitFor(() => {
    expect(isDisabled(publish('Musik'))).toBe(true);
    expect(isDisabled(publish('Geografie'))).toBe(true);
  });

  await act(async () => {
    for (const resolve of mockPending.splice(0)) resolve();
  });
  client.clear();
});
