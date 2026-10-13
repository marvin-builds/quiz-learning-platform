// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import { ensureSession } from '@/lib/session';

// The admin area, rendered through the real route tree in src/app with
// expo-router's renderRouter, so it doesn't matter whether the guard sits in
// a layout or in the screen:
// - `/admin/sign-in`: email + password, `signInWithPassword`, with loading,
//   wrong-credentials and network-error states. Not guarded.
// - `/admin`: guarded. A visitor without a session, an anonymous user or a
//   learner is sent to `/admin/sign-in` or sees a "no access" state; only a
//   user whose `profiles.role` is 'admin' gets in.
//
// Re-spec (#116): the dashboard is gone. `/admin` and a successful sign-in
// land on the category list at `/admin/categories` (the admin start), and
// signing out moves into the admin header ("Abmelden", `nav.signOut`). The
// tests that looked for the dashboard's heading now look for the category
// list (its empty state, since this fake has no categories) at
// `/admin/categories`; the guard's checks are unchanged.
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack would:
// - `auth.signInWithPassword` accepts the seed admin (admin@example.com /
//   admin-password) and a learner with an email account; anything else fails
//   with the AuthApiError GoTrue returns (400, invalid_credentials).
//   `mockAuth.network = true` makes it fail like supabase-js does without a
//   connection (AuthRetryableFetchError, status 0); `mockAuth.hold` keeps it
//   pending until released.
// - `auth.getSession`/`getUser` return the stored session; `signOut` clears
//   it; `signInAnonymously` stores a new anonymous user;
//   `onAuthStateChange` reports INITIAL_SESSION and every change.
// - `from('profiles')` applies RLS: anon has no grant (42501), an
//   authenticated user reads only their own row. `mockProfileRead` holds the
//   read pending or fails it. Every other table answers with no rows.
// The JWT metadata of the users below deliberately claims the opposite of
// their profile, so a guard that trusts client-side metadata fails.

// Reads a text from de.json or en.json by path, so keys that don't exist yet
// fail at run time with their name instead of breaking the typecheck.
function text(key: string, lng: 'de' | 'en' = 'de'): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      lng === 'de' ? de : en,
    );
  if (typeof value !== 'string') throw new Error(`${lng}.json has no text for ${key}`);
  return value;
}

type Role = 'learner' | 'admin';
type User = {
  id: string;
  email?: string;
  is_anonymous: boolean;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
};
type Session = { access_token: string; refresh_token: string; user: User };
type PostgrestError = { message: string; code: string; details?: string; hint?: string };
type Query = { table: string; select?: string; filters: [string, unknown][] };
type Listener = (event: string, session: Session | null) => void;

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password';
const LEARNER_EMAIL = 'learner@example.com';
const LEARNER_PASSWORD = 'learner-password';

const ADMIN: User = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: ADMIN_EMAIL,
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};
const LEARNER: User = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  email: LEARNER_EMAIL,
  is_anonymous: false,
  // What a learner could put there themselves (signUp options.data,
  // auth.updateUser): it must not make them an admin.
  user_metadata: { role: 'admin' },
  app_metadata: { provider: 'email', role: 'admin' },
};
const ANONYMOUS: User = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  is_anonymous: true,
  user_metadata: { role: 'admin' },
  app_metadata: { provider: 'anonymous', role: 'admin' },
};

const ACCOUNTS: Record<string, { password: string; user: User }> = {
  [ADMIN_EMAIL]: { password: ADMIN_PASSWORD, user: ADMIN },
  [LEARNER_EMAIL]: { password: LEARNER_PASSWORD, user: LEARNER },
};

function sessionOf(user: User): Session {
  return { access_token: `token-${user.id}`, refresh_token: `refresh-${user.id}`, user };
}

const mockAuth = {
  session: null as Session | null,
  network: false,
  hold: null as Promise<void> | null,
  passwordSignIns: [] as { email: string; password: string }[],
  signOuts: 0,
  anonymousSignIns: 0,
  listeners: new Set<Listener>(),
};
const mockProfiles: Record<string, Role> = {};
const mockProfileRead: { state: 'ok' | 'pending' | { error: PostgrestError } } = { state: 'ok' };
const mockQueries: Query[] = [];

function mockEmit(event: string) {
  for (const listener of mockAuth.listeners) listener(event, mockAuth.session);
}

function mockRead(query: Query, mode: 'many' | 'maybeSingle' | 'single') {
  if (query.table !== 'profiles') {
    return Promise.resolve({ data: mode === 'many' ? [] : null, error: null });
  }
  const state = mockProfileRead.state;
  if (state === 'pending') return new Promise(() => {});
  if (state !== 'ok') return Promise.resolve({ data: null, error: state.error });
  const user = mockAuth.session?.user;
  if (!user) {
    return Promise.resolve({
      data: null,
      error: { message: 'permission denied for table profiles', code: '42501' },
    });
  }
  const rows = Object.entries(mockProfiles)
    .filter(([id]) => id === user.id)
    .map(([id, role]) => ({ id, role, display_name: null }))
    .filter((row) =>
      query.filters.every(([column, value]) => row[column as keyof typeof row] === value),
    )
    .map((row) => {
      const columns = (query.select ?? '*').split(',').map((column) => column.trim());
      if (columns.includes('*')) return row;
      return Object.fromEntries(columns.map((column) => [column, row[column as keyof typeof row]]));
    });
  if (mode === 'many') return Promise.resolve({ data: rows, error: null });
  if (rows.length === 1) return Promise.resolve({ data: rows[0], error: null });
  if (mode === 'maybeSingle') return Promise.resolve({ data: null, error: null });
  return Promise.resolve({
    data: null,
    error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
  });
}

function mockQueryBuilder(table: string) {
  const query: Query = { table, filters: [] };
  mockQueries.push(query);
  const builder = {
    select(columns?: string) {
      query.select = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    abortSignal() {
      return builder;
    },
    maybeSingle() {
      return mockRead(query, 'maybeSingle');
    },
    single() {
      return mockRead(query, 'single');
    },
    then<T>(onFulfilled: (value: unknown) => T, onRejected?: (reason: unknown) => T) {
      return mockRead(query, 'many').then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const mockSupabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: mockAuth.session }, error: null }),
    getUser: () =>
      Promise.resolve(
        mockAuth.session
          ? { data: { user: mockAuth.session.user }, error: null }
          : {
              data: { user: null },
              error: new AuthApiError('Auth session missing!', 400, 'session_not_found'),
            },
      ),
    onAuthStateChange: (listener: Listener) => {
      mockAuth.listeners.add(listener);
      // supabase-js reports the current session right after subscribing.
      void Promise.resolve().then(() => listener('INITIAL_SESSION', mockAuth.session));
      return {
        data: { subscription: { unsubscribe: () => mockAuth.listeners.delete(listener) } },
      };
    },
    signInWithPassword: async (credentials: { email: string; password: string }) => {
      mockAuth.passwordSignIns.push(credentials);
      if (mockAuth.hold) await mockAuth.hold;
      if (mockAuth.network) {
        return {
          data: { user: null, session: null },
          error: new AuthRetryableFetchError('Failed to fetch', 0),
        };
      }
      const account = ACCOUNTS[credentials.email];
      if (!account || account.password !== credentials.password) {
        return {
          data: { user: null, session: null },
          error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
        };
      }
      mockAuth.session = sessionOf(account.user);
      mockEmit('SIGNED_IN');
      return { data: { user: account.user, session: mockAuth.session }, error: null };
    },
    signOut: () => {
      mockAuth.signOuts += 1;
      mockAuth.session = null;
      mockEmit('SIGNED_OUT');
      return Promise.resolve({ error: null });
    },
    signInAnonymously: () => {
      mockAuth.anonymousSignIns += 1;
      const user: User = {
        id: `dddddddd-0000-4000-8000-${String(mockAuth.anonymousSignIns).padStart(12, '0')}`,
        is_anonymous: true,
        user_metadata: {},
        app_metadata: { provider: 'anonymous' },
      };
      mockAuth.session = sessionOf(user);
      mockProfiles[user.id] = 'learner';
      mockEmit('SIGNED_IN');
      return Promise.resolve({ data: { user, session: mockAuth.session }, error: null });
    },
  },
  from: (table: string) => mockQueryBuilder(table),
  rpc: () => new Promise(() => {}),
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    get auth() {
      return mockSupabase.auth;
    },
    from: (table: string) => mockSupabase.from(table),
    rpc: () => mockSupabase.rpc(),
  },
}));

// The root layout imports the NativeWind stylesheet, which Jest can't load.
jest.mock('../../global.css', () => ({}));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Lets pending promises, timers and the re-renders they cause settle.
// renderRouter switches Jest to fake timers, so they are run, not waited for.
const flush = () =>
  act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });

// React Native Testing Library 14 renders asynchronously, so renderRouter's
// result is a thenable; only its pathname is handed on, since returning the
// thenable itself from an async function would unwrap it.
async function renderAt(url: string): Promise<{ getPathname(): string }> {
  const result = renderRouter('src/app', { initialUrl: url });
  await result;
  return { getPathname: () => result.getPathname() };
}

// Re-spec (#116): the admin start is the category list, not the dashboard.
// This fake has no categories, so the list shows its empty state.
const adminStart = () => text('admin.categories.empty');

// The issue allows either: a redirect to the sign-in screen or a "no
// access" state on /admin. Either way the admin start stays hidden.
async function expectKeptOut(result: { getPathname(): string }) {
  await waitFor(() => {
    const redirected = result.getPathname() === '/admin/sign-in';
    const noAccess =
      i18n.exists('admin.guard.noAccess') &&
      screen.queryByText(text('admin.guard.noAccess')) !== null;
    expect(redirected || noAccess).toBe(true);
  });
  expect(screen.queryByText(adminStart())).toBeNull();
}

// Re-spec (#116): "Abmelden" sits in the admin header (role banner), not on
// the dashboard. The last banner is the current screen's.
function headerSignOut(): TestInstance {
  const banners = screen.container.queryAll(
    (node) =>
      typeof node.type === 'string' &&
      String(node.props.role ?? node.props.accessibilityRole ?? '') === 'banner',
  );
  const header = banners[banners.length - 1];
  if (!header) throw new Error('No element with role banner (the admin header)');
  const [signOut] = within(header).queryAllByText(text('nav.signOut'));
  if (!signOut) throw new Error('The admin header has no "Abmelden"');
  return signOut;
}

async function fillIn(email: string, password: string) {
  await fireEvent.changeText(screen.getByLabelText(text('admin.signIn.email')), email);
  await fireEvent.changeText(screen.getByLabelText(text('admin.signIn.password')), password);
}

const submitButton = () => screen.getByRole('button', { name: text('admin.signIn.submit') });

async function signIn(email: string, password: string) {
  await fillIn(email, password);
  await fireEvent.press(submitButton());
}

beforeEach(async () => {
  mockAuth.session = null;
  mockAuth.network = false;
  mockAuth.hold = null;
  mockAuth.passwordSignIns = [];
  mockAuth.signOuts = 0;
  mockAuth.anonymousSignIns = 0;
  mockAuth.listeners.clear();
  for (const id of Object.keys(mockProfiles)) delete mockProfiles[id];
  mockProfiles[ADMIN.id] = 'admin';
  mockProfiles[LEARNER.id] = 'learner';
  mockProfiles[ANONYMOUS.id] = 'learner';
  mockProfileRead.state = 'ok';
  mockQueries.length = 0;
  await i18n.changeLanguage('de');
});

describe('admin texts', () => {
  const keys = [
    'admin.signIn.title',
    'admin.signIn.email',
    'admin.signIn.password',
    'admin.signIn.submit',
    'admin.signIn.submitting',
    'admin.signIn.errors.invalidCredentials',
    'admin.signIn.errors.network',
    'admin.guard.loading',
    'admin.guard.error',
    // Kept (#116): the guard's page title still uses this key.
    'admin.dashboard.title',
    // Re-spec (#116): the dashboard's link and sign-out keys went with the
    // dashboard; sign-out is the header's `nav.signOut`.
    'nav.signOut',
  ];

  it.each(keys)('%s has a German and an English text', (key) => {
    expect(text(key, 'de')).toMatch(/\S/);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('tells wrong credentials and a network error apart', () => {
    expect(text('admin.signIn.errors.invalidCredentials')).not.toBe(
      text('admin.signIn.errors.network'),
    );
  });
});

describe('admin sign-in screen (/admin/sign-in)', () => {
  it('is open to a visitor without a session, with a heading and labelled email and password fields', async () => {
    await renderAt('/admin/sign-in');

    expect(await screen.findByText(text('admin.signIn.title'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.signIn.email'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.signIn.password'))).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: text('admin.signIn.submit') })).toBeOnTheScreen();
  });

  it('hides the password as it is typed', async () => {
    await renderAt('/admin/sign-in');

    const password = await screen.findByLabelText(text('admin.signIn.password'));
    expect(password.props.secureTextEntry).toBe(true);
  });

  it('shows its texts in English when the language is English', async () => {
    await i18n.changeLanguage('en');

    await renderAt('/admin/sign-in');

    expect(await screen.findByText(text('admin.signIn.title', 'en'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.signIn.email', 'en'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.signIn.password', 'en'))).toBeOnTheScreen();
  });

  it('signs in when the password field is submitted (Enter), like a login form', async () => {
    await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));

    await fillIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    await fireEvent(screen.getByLabelText(text('admin.signIn.password')), 'submitEditing');

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(mockAuth.passwordSignIns).toEqual([{ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }]);
  });

  it('ignores Enter in the password field while a sign-in is pending', async () => {
    const pending = deferred();
    mockAuth.hold = pending.promise;
    await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));
    await fillIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const password = screen.getByLabelText(text('admin.signIn.password'));

    await fireEvent(password, 'submitEditing');
    await screen.findByText(text('admin.signIn.submitting'));
    await fireEvent(password, 'submitEditing');
    await flush();

    expect(mockAuth.passwordSignIns).toHaveLength(1);
    pending.release();
    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
  });

  it('signs in with the typed email and password and opens the category list', async () => {
    const result = await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));

    await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(result.getPathname()).toBe('/admin/categories');
    expect(mockAuth.passwordSignIns).toEqual([{ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }]);
  });

  // Like the quiz screen's Start test: the press starts the sign-in (as a
  // mutation does) and settles while the request is still pending.
  it('shows a loading state and ignores further presses while signing in', async () => {
    const pending = deferred();
    mockAuth.hold = pending.promise;
    await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));

    await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    await waitFor(() => expect(mockAuth.passwordSignIns).toHaveLength(1));

    expect(await screen.findByText(text('admin.signIn.submitting'))).toBeOnTheScreen();
    const button =
      screen.queryByRole('button', { name: text('admin.signIn.submit') }) ??
      screen.getByRole('button', { name: text('admin.signIn.submitting') });
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    await flush();
    expect(mockAuth.passwordSignIns).toHaveLength(1);

    pending.release();
    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(mockAuth.passwordSignIns).toHaveLength(1);
  });

  it('shows the wrong-credentials message and stays on the sign-in screen', async () => {
    const result = await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));

    await signIn(ADMIN_EMAIL, 'wrong-password');

    expect(
      await screen.findByText(text('admin.signIn.errors.invalidCredentials')),
    ).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.signIn.errors.network'))).toBeNull();
    expect(result.getPathname()).toBe('/admin/sign-in');
    expect(screen.getByRole('button', { name: text('admin.signIn.submit') })).toBeEnabled();
  });

  it('shows the network-error message, not the wrong-credentials one, when the request fails', async () => {
    mockAuth.network = true;
    const result = await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));

    await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    expect(await screen.findByText(text('admin.signIn.errors.network'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.signIn.errors.invalidCredentials'))).toBeNull();
    expect(result.getPathname()).toBe('/admin/sign-in');
  });

  it('clears the error and signs in on the next attempt', async () => {
    await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));
    await signIn(ADMIN_EMAIL, 'wrong-password');
    await screen.findByText(text('admin.signIn.errors.invalidCredentials'));

    await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.signIn.errors.invalidCredentials'))).toBeNull();
  });

  it('keeps a learner who signs in with valid credentials out of the admin area', async () => {
    const result = await renderAt('/admin/sign-in');
    await screen.findByLabelText(text('admin.signIn.email'));

    await signIn(LEARNER_EMAIL, LEARNER_PASSWORD);

    await waitFor(() => expect(mockAuth.session?.user.id).toBe(LEARNER.id));
    await act(async () => router.navigate('/admin'));
    await expectKeptOut(result);
  });
});

describe('admin route guard (/admin)', () => {
  it('keeps a visitor without a session out', async () => {
    const result = await renderAt('/admin');

    await expectKeptOut(result);
  });

  it('keeps an anonymous user out, whatever their metadata says', async () => {
    mockAuth.session = sessionOf(ANONYMOUS);

    const result = await renderAt('/admin');

    await expectKeptOut(result);
  });

  it('keeps a learner out even when their JWT metadata claims admin', async () => {
    mockAuth.session = sessionOf(LEARNER);

    const result = await renderAt('/admin');

    await expectKeptOut(result);
  });

  it('lets an admin in, read from profiles.role and not from metadata', async () => {
    mockAuth.session = sessionOf(ADMIN);

    const result = await renderAt('/admin');

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(result.getPathname()).toBe('/admin/categories');
    const profileReads = mockQueries.filter((query) => query.table === 'profiles');
    expect(profileReads.length).toBeGreaterThan(0);
    expect(profileReads.some((query) => /\brole\b/.test(query.select ?? ''))).toBe(true);
  });

  it('shows a loading state, not the admin start, while the role is being read', async () => {
    mockAuth.session = sessionOf(ADMIN);
    mockProfileRead.state = 'pending';

    await renderAt('/admin');

    expect(await screen.findByText(text('admin.guard.loading'))).toBeOnTheScreen();
    expect(screen.queryByText(adminStart())).toBeNull();
  });

  it('shows an error, not the admin start, when the role cannot be read', async () => {
    mockAuth.session = sessionOf(ADMIN);
    mockProfileRead.state = { error: { message: 'TypeError: Failed to fetch', code: '' } };

    await renderAt('/admin');

    // Generous: a query client may retry with backoff before it gives up.
    expect(
      await screen.findByText(text('admin.guard.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(adminStart())).toBeNull();
  });

  it('keeps out a former admin whose profile now says learner', async () => {
    mockProfiles[ADMIN.id] = 'learner';
    mockAuth.session = sessionOf(ADMIN);

    const result = await renderAt('/admin');

    await expectKeptOut(result);
  });
});

// Re-spec (#116): was "admin dashboard (/admin)". The dashboard is gone:
// /admin lands on the category list, and sign-out is in the admin header.
describe('admin start (/admin)', () => {
  it('shows the category list in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    mockAuth.session = sessionOf(ADMIN);

    await renderAt('/admin');

    expect(await screen.findByText(text('admin.categories.empty', 'en'))).toBeOnTheScreen();
  });

  it('redirects /admin to the category list at /admin/categories', async () => {
    mockAuth.session = sessionOf(ADMIN);

    const result = await renderAt('/admin');

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
  });

  it('signs out to the learner area, where the next session is a fresh anonymous one', async () => {
    mockAuth.session = sessionOf(ADMIN);
    const result = await renderAt('/admin');
    await screen.findByText(adminStart());

    await fireEvent.press(await waitFor(() => headerSignOut()));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(await screen.findByText(de.home.title)).toBeOnTheScreen();
    expect(mockAuth.signOuts).toBe(1);
    expect(mockAuth.session?.user.id).not.toBe(ADMIN.id);

    const next = await ensureSession();
    expect(next.user.is_anonymous).toBe(true);
    expect(next.user.id).not.toBe(ADMIN.id);
  });

  it('keeps the visitor out of /admin again after signing out', async () => {
    mockAuth.session = sessionOf(ADMIN);
    const result = await renderAt('/admin');
    await screen.findByText(adminStart());
    await fireEvent.press(await waitFor(() => headerSignOut()));
    await waitFor(() => expect(result.getPathname()).toBe('/'));

    await act(async () => router.navigate('/admin'));

    await expectKeptOut(result);
  });
});
