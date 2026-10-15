import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AdminHeader } from '@/components/admin-header';
import i18n from '@/i18n';

// The admin header's "Abmelden" (#122) ends the session on this device only
// (`scope: 'local'`): a global sign-out would also end the admin's sessions
// on other devices, and GoTrue's MFA endpoints then refuse those mid-step.
// The other devices stay signed in until they sign out themselves (see the
// access rules in docs/plan/overview.md). Boundary: the Supabase client in
// @/lib/supabase; expo-router is replaced by plain stand-ins.

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (path: string) => mockReplace(path), navigate: jest.fn() },
  usePathname: () => '/admin/categories',
}));

const mockSignOut = jest.fn((_options?: { scope?: string }) => Promise.resolve({ error: null }));
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { signOut: (options?: { scope?: string }) => mockSignOut(options) } },
}));

// No garbage-collection timers (gcTime Infinity), so Jest can exit.
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
});
afterEach(() => client.clear());

it('signs out of this device only and returns to the learner area', async () => {
  await render(
    <QueryClientProvider client={client}>
      <AdminHeader signOut />
    </QueryClientProvider>,
  );

  await fireEvent.press(screen.getByText(i18n.t('nav.signOut')));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
});
