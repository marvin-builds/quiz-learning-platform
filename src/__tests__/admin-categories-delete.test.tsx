import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import AdminCategoriesScreen from '@/app/(admin)/admin/(guarded)/categories';
import i18n from '@/i18n';

// Deleting on the admin category list (#80) while the delete is still
// running: the row's delete and publish actions stay disabled, so a second
// delete of the same row can't run into "nothing deleted" and show an error
// for a category that is gone. Boundary: @/lib/admin-categories; expo-router's
// Link and Stack are replaced by plain views.

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
  updateCategory: () => Promise.resolve(),
  deleteCategory: () => new Promise<void>((resolve) => mockPending.push(resolve)),
}));

type ActionKey = 'admin.categories.actions.delete' | 'admin.categories.actions.publish';

const action = (key: ActionKey, name: string) =>
  screen.getByRole('button', { name: i18n.t(key, { name }) });

const isDisabled = (element: ReturnType<typeof action>) =>
  Boolean(element.props['aria-disabled'] ?? element.props.accessibilityState?.disabled);

it('keeps a row disabled while its delete is running', async () => {
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

  await fireEvent.press(action('admin.categories.actions.delete', 'Geografie'));
  await fireEvent.press(
    screen.getByRole('button', { name: i18n.t('admin.categories.deleteDialog.confirm') }),
  );

  await waitFor(() => {
    expect(isDisabled(action('admin.categories.actions.delete', 'Geografie'))).toBe(true);
    expect(isDisabled(action('admin.categories.actions.publish', 'Geografie'))).toBe(true);
  });
  expect(isDisabled(action('admin.categories.actions.delete', 'Musik'))).toBe(false);

  await act(async () => {
    for (const resolve of mockPending.splice(0)) resolve();
  });
  // The fake list still has the row: once the delete is done, it is active again.
  await waitFor(() =>
    expect(isDisabled(action('admin.categories.actions.delete', 'Geografie'))).toBe(false),
  );
  client.clear();
});
