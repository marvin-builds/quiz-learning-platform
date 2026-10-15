// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Issue #122: admin rights need a second factor. After the password the
// admin area asks for a TOTP code and shows the admin screens only once the
// session is aal2. Rendered through the real route tree in src/app with
// expo-router's renderRouter, so it doesn't matter whether the steps sit in
// the guard layout or on screens of their own:
// - An admin without a verified factor (aal1) gets the enrollment: a QR code
//   with a translated alt text, the secret as selectable text (for typing it
//   into an authenticator app), a code field and a verify button. A verified
//   code makes the session aal2 and opens the admin screens.
// - An admin with a verified factor but an aal1 session gets the code
//   challenge: a code field and a verify button, no QR code, no secret.
// - An admin in an aal2 session goes straight to the admin screens.
// - A learner keeps the "no access" state and is never offered enrollment.
// - A wrong code shows a message of its own (GoTrue's
//   mfa_verification_failed); a network error, a rate limit and an expired
//   challenge show the try-again message. A failed enrollment shows the
//   try-again pattern with a retry button. Sign-out (admin header) stays
//   available on both steps.
// - Content cached before the step-up is dropped after it, as after the
//   password sign-in.
// - A second enrollment after an abandoned one works (GoTrue keeps the
//   unverified factor and refuses a second factor with the same friendly
//   name).
// - From an aal1 session the app never enrolls an extra factor next to a
//   verified one and never removes a verified factor.
//
// Boundary: the Supabase client (network). The fake answers like GoTrue and
// supabase-js do; the app reads the level through
// `auth.mfa.getAuthenticatorAssuranceLevel()` and the factors through
// `auth.mfa.listFactors()` (the loading and error tests of the guard hold
// back or fail exactly these two calls):
// - `signInWithPassword` gives an aal1 session; `mfa.enroll` creates an
//   unverified TOTP factor and returns its QR code (an SVG data URL) and
//   secret, refusing a friendly name the user already has
//   (mfa_factor_name_conflict) and, next to a verified factor in an aal1
//   session, any enrollment (insufficient_aal); `mfa.challenge`,
//   `mfa.verify` and `mfa.challengeAndVerify` accept CODE for the factor and
//   challenge they name, refuse any other code (mfa_verification_failed) and
//   an expired challenge (mfa_challenge_expired); a successful verify makes
//   the factor verified and the session aal2 and reports
//   MFA_CHALLENGE_VERIFIED; `mfa.unenroll` refuses a verified factor from an
//   aal1 session (insufficient_aal).
// - `mockMfa.next[<operation>]` queues what the next calls do instead:
//   'pending' (never answers), a promise (answers once it resolves) or an
//   error to return.
// - `from('profiles')` applies RLS (own row only); `from('categories')`
//   returns `mockContent.categories`; every other table answers with no
//   rows.

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
type Aal = 'aal1' | 'aal2';
type Factor = {
  id: string;
  factor_type: 'totp';
  status: 'verified' | 'unverified';
  friendly_name: string;
  created_at: string;
  updated_at: string;
};
type User = {
  id: string;
  email?: string;
  is_anonymous: boolean;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  factors?: Factor[];
};
type Session = {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  user: User;
};
type PostgrestError = { message: string; code: string };
type Query = { table: string; select?: string; filters: [string, unknown][] };
type Listener = (event: string, session: Session | null) => void;
type Operation =
  'aal' | 'listFactors' | 'enroll' | 'challenge' | 'verify' | 'unenroll' | 'signInWithPassword';
type Step = 'pending' | Promise<void> | Error;

const PASSWORD = 'admin-password';
const CODE = '246810';
const WRONG_CODE = '135791';
const SECRETS = ['KRSXG5CTMVRXEZLUKN2XAZLSONSWG4TF', 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U'];

const ADMIN: User = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};
// An admin who hasn't enrolled a factor yet (e.g. right after the deploy).
const NEW_ADMIN: User = {
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  email: 'new-admin@example.com',
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};
const LEARNER: User = {
  id: 'bbbbbbbb-0000-4000-8000-000000000003',
  email: 'learner@example.com',
  is_anonymous: false,
  user_metadata: { role: 'admin' },
  app_metadata: { provider: 'email', role: 'admin' },
};
const ANONYMOUS: User = {
  id: 'cccccccc-0000-4000-8000-000000000004',
  is_anonymous: true,
  user_metadata: {},
  app_metadata: { provider: 'anonymous' },
};

const ACCOUNTS: Record<string, User> = {
  [ADMIN.email!]: ADMIN,
  [NEW_ADMIN.email!]: NEW_ADMIN,
  [LEARNER.email!]: LEARNER,
};

const mockAuth = {
  session: null as Session | null,
  aal: null as Aal | null,
  issued: 0,
  signOuts: 0,
  listeners: new Set<Listener>(),
};
const mockProfiles: Record<string, Role> = {};
const mockContent: { categories: Record<string, unknown>[] } = { categories: [] };
const mockQueries: Query[] = [];
const mockMfa = {
  factors: {} as Record<string, Factor[]>,
  challenges: new Map<string, { factorId: string; expired: boolean }>(),
  enrollments: 0,
  // The next verify call finds its challenge expired (time passed).
  expireOnVerify: 0,
  next: {} as Partial<Record<Operation, Step[]>>,
  calls: [] as { op: Operation | 'challengeAndVerify'; args?: Record<string, unknown> }[],
};

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// A JWT-shaped access token with the claims GoTrue puts in, unsigned: the
// fake is the server, and the client never checks the signature.
function mockSessionOf(user: User, aal: Aal): Session {
  mockAuth.issued += 1;
  const claims = {
    sub: user.id,
    role: 'authenticated',
    aal,
    amr: aal === 'aal2' ? [{ method: 'totp' }, { method: 'password' }] : [{ method: 'password' }],
    is_anonymous: user.is_anonymous,
  };
  return {
    access_token: `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(claims)}.sig${mockAuth.issued}`,
    refresh_token: `refresh-${user.id}-${mockAuth.issued}`,
    token_type: 'bearer',
    expires_in: 3600,
    user: { ...user, factors: (mockMfa.factors[user.id] ?? []).map((f) => ({ ...f })) },
  };
}

function mockSetSession(user: User | null, aal: Aal = 'aal1') {
  mockAuth.session = user ? mockSessionOf(user, aal) : null;
  mockAuth.aal = user ? aal : null;
}

function mockEmit(event: string) {
  for (const listener of mockAuth.listeners) listener(event, mockAuth.session);
}

async function mockGate(op: Operation): Promise<Error | null> {
  const step = mockMfa.next[op]?.shift();
  if (!step) return null;
  if (step === 'pending') return new Promise<never>(() => {});
  if (step instanceof Error) return step;
  await step;
  return null;
}

const networkError = () => new AuthRetryableFetchError('Failed to fetch', 0);
const rateLimitError = () =>
  new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit');

function mockFactorsOfCaller(): Factor[] {
  const user = mockAuth.session?.user;
  return user ? (mockMfa.factors[user.id] ??= []) : [];
}

function mockFactorList() {
  const all = mockFactorsOfCaller().map((factor) => ({ ...factor }));
  const totp = all.filter((factor) => factor.status === 'verified');
  return { all, totp, phone: [], webauthn: [] };
}

function mockRead(query: Query, mode: 'many' | 'maybeSingle' | 'single') {
  if (query.table === 'categories') {
    const rows = mockContent.categories.filter((row) =>
      query.filters.every(([column, value]) => row[column] === value),
    );
    return Promise.resolve({ data: mode === 'many' ? rows : (rows[0] ?? null), error: null });
  }
  if (query.table !== 'profiles') {
    return Promise.resolve({ data: mode === 'many' ? [] : null, error: null });
  }
  const user = mockAuth.session?.user;
  if (!user) {
    const error: PostgrestError = {
      message: 'permission denied for table profiles',
      code: '42501',
    };
    return Promise.resolve({ data: null, error });
  }
  const rows = Object.entries(mockProfiles)
    .filter(([id]) => id === user.id)
    .map(([id, role]) => ({ id, role, display_name: null }))
    .filter((row) =>
      query.filters.every(([column, value]) => row[column as keyof typeof row] === value),
    );
  if (mode === 'many') return Promise.resolve({ data: rows, error: null });
  return Promise.resolve({ data: rows[0] ?? null, error: null });
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

const noSession = () => new AuthApiError('Auth session missing!', 400, 'session_not_found');

async function mockChallenge(params: { factorId: string }) {
  mockMfa.calls.push({ op: 'challenge', args: params });
  const failure = await mockGate('challenge');
  if (failure) return { data: null, error: failure };
  if (!mockAuth.session) return { data: null, error: noSession() };
  if (!mockFactorsOfCaller().some((factor) => factor.id === params.factorId)) {
    return {
      data: null,
      error: new AuthApiError('Factor not found', 404, 'mfa_factor_not_found'),
    };
  }
  const id = `c0000000-0000-4000-8000-${String(mockMfa.challenges.size + 1).padStart(12, '0')}`;
  mockMfa.challenges.set(id, { factorId: params.factorId, expired: false });
  return {
    data: { id, type: 'totp', expires_at: Math.round(Date.now() / 1000) + 300 },
    error: null,
  };
}

async function mockVerify(params: { factorId: string; challengeId: string; code: string }) {
  mockMfa.calls.push({ op: 'verify', args: params });
  const failure = await mockGate('verify');
  if (failure) return { data: null, error: failure };
  const session = mockAuth.session;
  if (!session) return { data: null, error: noSession() };
  const factor = mockFactorsOfCaller().find((candidate) => candidate.id === params.factorId);
  const challenge = mockMfa.challenges.get(params.challengeId);
  if (!factor || !challenge || challenge.factorId !== factor.id) {
    return {
      data: null,
      error: new AuthApiError('Factor not found', 404, 'mfa_factor_not_found'),
    };
  }
  if (mockMfa.expireOnVerify > 0) {
    mockMfa.expireOnVerify -= 1;
    challenge.expired = true;
  }
  if (challenge.expired) {
    return {
      data: null,
      error: new AuthApiError(
        `MFA challenge ${params.challengeId} has expired, verify against another challenge or create a new challenge.`,
        422,
        'mfa_challenge_expired',
      ),
    };
  }
  // A wrong code leaves the challenge open; a verified one is used up.
  if (params.code !== CODE) {
    return {
      data: null,
      error: new AuthApiError('Invalid TOTP code entered', 422, 'mfa_verification_failed'),
    };
  }
  mockMfa.challenges.delete(params.challengeId);
  factor.status = 'verified';
  mockSetSession(session.user, 'aal2');
  mockEmit('MFA_CHALLENGE_VERIFIED');
  return { data: { ...mockAuth.session! }, error: null };
}

const mockSupabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: mockAuth.session }, error: null }),
    getUser: () =>
      Promise.resolve(
        mockAuth.session
          ? {
              data: {
                user: { ...mockAuth.session.user, factors: mockFactorList().all },
              },
              error: null,
            }
          : { data: { user: null }, error: noSession() },
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
      const failure = await mockGate('signInWithPassword');
      if (failure) return { data: { user: null, session: null }, error: failure };
      const user = ACCOUNTS[credentials.email];
      if (!user || credentials.password !== PASSWORD) {
        return {
          data: { user: null, session: null },
          error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
        };
      }
      mockSetSession(user, 'aal1');
      mockEmit('SIGNED_IN');
      return { data: { user: mockAuth.session!.user, session: mockAuth.session }, error: null };
    },
    signOut: () => {
      mockAuth.signOuts += 1;
      mockSetSession(null);
      mockEmit('SIGNED_OUT');
      return Promise.resolve({ error: null });
    },
    signInAnonymously: () => {
      const user: User = {
        id: `dddddddd-0000-4000-8000-${String(mockAuth.issued + 1).padStart(12, '0')}`,
        is_anonymous: true,
        user_metadata: {},
        app_metadata: { provider: 'anonymous' },
      };
      mockProfiles[user.id] = 'learner';
      mockSetSession(user, 'aal1');
      mockEmit('SIGNED_IN');
      return Promise.resolve({ data: { user, session: mockAuth.session }, error: null });
    },
    mfa: {
      getAuthenticatorAssuranceLevel: async () => {
        mockMfa.calls.push({ op: 'aal' });
        const failure = await mockGate('aal');
        if (failure) return { data: null, error: failure };
        if (!mockAuth.session) {
          return {
            data: { currentLevel: null, nextLevel: null, currentAuthenticationMethods: [] },
            error: null,
          };
        }
        const current = mockAuth.aal;
        const next = mockFactorList().totp.length > 0 ? 'aal2' : current;
        return {
          data: { currentLevel: current, nextLevel: next, currentAuthenticationMethods: [] },
          error: null,
        };
      },
      listFactors: async () => {
        mockMfa.calls.push({ op: 'listFactors' });
        const failure = await mockGate('listFactors');
        if (failure) return { data: null, error: failure };
        if (!mockAuth.session) return { data: null, error: noSession() };
        return { data: mockFactorList(), error: null };
      },
      enroll: async (params: { factorType: string; friendlyName?: string; issuer?: string }) => {
        mockMfa.calls.push({ op: 'enroll', args: params });
        const failure = await mockGate('enroll');
        if (failure) return { data: null, error: failure };
        if (!mockAuth.session) return { data: null, error: noSession() };
        const factors = mockFactorsOfCaller();
        if (params.factorType !== 'totp') {
          return {
            data: null,
            error: new AuthApiError('MFA enroll is disabled', 422, 'mfa_phone_enroll_not_enabled'),
          };
        }
        if (mockAuth.aal !== 'aal2' && factors.some((factor) => factor.status === 'verified')) {
          return {
            data: null,
            error: new AuthApiError(
              'AAL2 required to enroll a new factor',
              422,
              'insufficient_aal',
            ),
          };
        }
        const name = params.friendlyName?.trim() ?? '';
        if (name !== '' && factors.some((factor) => factor.friendly_name === name)) {
          return {
            data: null,
            error: new AuthApiError(
              `A factor with the friendly name "${name}" for this user already exists`,
              422,
              'mfa_factor_name_conflict',
            ),
          };
        }
        if (factors.length >= 10) {
          return {
            data: null,
            error: new AuthApiError(
              'Maximum number of verified factors reached, unenroll to continue',
              422,
              'too_many_enrolled_mfa_factors',
            ),
          };
        }
        const secret = SECRETS[mockMfa.enrollments % SECRETS.length]!;
        mockMfa.enrollments += 1;
        const id = `f0000000-0000-4000-8000-${String(mockMfa.enrollments).padStart(12, '0')}`;
        factors.push({
          id,
          factor_type: 'totp',
          status: 'unverified',
          friendly_name: name,
          created_at: '2026-10-14T00:00:00Z',
          updated_at: '2026-10-14T00:00:00Z',
        });
        return {
          data: {
            id,
            type: 'totp',
            friendly_name: name,
            totp: {
              qr_code: `data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg" data-secret="${secret}"></svg>`,
              secret,
              uri: `otpauth://totp/localhost:${mockAuth.session.user.email}?secret=${secret}&issuer=localhost`,
            },
          },
          error: null,
        };
      },
      challenge: mockChallenge,
      verify: mockVerify,
      challengeAndVerify: async (params: { factorId: string; code: string }) => {
        mockMfa.calls.push({ op: 'challengeAndVerify', args: params });
        const challenge = await mockChallenge({ factorId: params.factorId });
        if (challenge.error) return challenge;
        return mockVerify({ ...params, challengeId: challenge.data!.id });
      },
      unenroll: async (params: { factorId: string }) => {
        mockMfa.calls.push({ op: 'unenroll', args: params });
        const failure = await mockGate('unenroll');
        if (failure) return { data: null, error: failure };
        if (!mockAuth.session) return { data: null, error: noSession() };
        const factors = mockFactorsOfCaller();
        const index = factors.findIndex((factor) => factor.id === params.factorId);
        if (index < 0) {
          return {
            data: null,
            error: new AuthApiError('Factor not found', 404, 'mfa_factor_not_found'),
          };
        }
        if (factors[index]!.status === 'verified' && mockAuth.aal !== 'aal2') {
          return {
            data: null,
            error: new AuthApiError(
              'AAL2 required to unenroll verified factor',
              422,
              'insufficient_aal',
            ),
          };
        }
        factors.splice(index, 1);
        return { data: { id: params.factorId }, error: null };
      },
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

async function renderAt(url: string): Promise<{ getPathname(): string }> {
  const result = renderRouter('src/app', { initialUrl: url });
  await result;
  return { getPathname: () => result.getPathname() };
}

// The admin start, the category list; this fake has no categories unless a
// test adds some, so the list shows its empty state.
const adminStart = () => text('admin.categories.empty');

const enrollTitle = () => text('admin.mfa.enroll.title');
const challengeTitle = () => text('admin.mfa.challenge.title');
const codeField = () => screen.getByLabelText(text('admin.mfa.code'));
const verifyButton = () => screen.getByRole('button', { name: text('admin.mfa.submit') });

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

async function signIn(email: string) {
  await fireEvent.changeText(await screen.findByLabelText(text('admin.signIn.email')), email);
  await fireEvent.changeText(screen.getByLabelText(text('admin.signIn.password')), PASSWORD);
  await fireEvent.press(screen.getByRole('button', { name: text('admin.signIn.submit') }));
}

async function enterCode(code: string) {
  await fireEvent.changeText(await waitFor(() => codeField()), code);
  await fireEvent.press(verifyButton());
}

const callsOf = (op: string) => mockMfa.calls.filter((call) => call.op === op);
const verifiedFactorIds = (userId: string) =>
  (mockMfa.factors[userId] ?? [])
    .filter((factor) => factor.status === 'verified')
    .map((factor) => factor.id);
// Which factor each verify call was for, however the app verifies.
const verifiedWith = () =>
  mockMfa.calls
    .filter((call) => call.op === 'verify')
    .map((call) => (call.args as { factorId: string }).factorId);

// The verified factor of ADMIN, like the seed admin's.
const SEED_FACTOR: Factor = {
  id: 'f0000000-0000-4000-8000-0000000000aa',
  factor_type: 'totp',
  status: 'verified',
  friendly_name: '',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

beforeEach(async () => {
  mockSetSession(null);
  mockAuth.issued = 0;
  mockAuth.signOuts = 0;
  mockAuth.listeners.clear();
  for (const id of Object.keys(mockProfiles)) delete mockProfiles[id];
  mockProfiles[ADMIN.id] = 'admin';
  mockProfiles[NEW_ADMIN.id] = 'admin';
  mockProfiles[LEARNER.id] = 'learner';
  mockProfiles[ANONYMOUS.id] = 'learner';
  mockContent.categories = [];
  mockQueries.length = 0;
  mockMfa.factors = { [ADMIN.id]: [{ ...SEED_FACTOR }], [NEW_ADMIN.id]: [] };
  mockMfa.challenges.clear();
  mockMfa.enrollments = 0;
  mockMfa.expireOnVerify = 0;
  mockMfa.next = {};
  mockMfa.calls = [];
  await i18n.changeLanguage('de');
});

describe('second-factor texts', () => {
  const keys = [
    'admin.mfa.enroll.title',
    'admin.mfa.enroll.intro',
    'admin.mfa.enroll.qrAlt',
    'admin.mfa.enroll.secret',
    'admin.mfa.enroll.loading',
    'admin.mfa.enroll.error',
    'admin.mfa.challenge.title',
    'admin.mfa.challenge.intro',
    'admin.mfa.code',
    'admin.mfa.submit',
    'admin.mfa.submitting',
    'admin.mfa.errors.invalidCode',
    'admin.mfa.errors.network',
  ];

  it.each(keys)('%s has a German and an English text', (key) => {
    expect(text(key, 'de')).toMatch(/\S/);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('tells a wrong code and a network error apart', () => {
    expect(text('admin.mfa.errors.invalidCode')).not.toBe(text('admin.mfa.errors.network'));
  });

  it('tells the enrollment and the code challenge apart', () => {
    expect(text('admin.mfa.enroll.title')).not.toBe(text('admin.mfa.challenge.title'));
  });
});

describe('enrollment (an admin without a verified factor)', () => {
  it('asks for enrollment after the password, with the QR code, the secret, a code field and verify', async () => {
    await renderAt('/admin/sign-in');

    await signIn(NEW_ADMIN.email!);

    expect(await screen.findByText(enrollTitle())).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.mfa.code'))).toBeOnTheScreen();
    expect(verifyButton()).toBeEnabled();
    expect(screen.queryByText(adminStart())).toBeNull();
    expect(screen.queryByText(challengeTitle())).toBeNull();
    expect(callsOf('enroll')).toHaveLength(1);
    expect(callsOf('enroll')[0]!.args).toMatchObject({ factorType: 'totp' });
  });

  it('shows the secret as selectable text, for typing it into an authenticator app', async () => {
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');

    // As one string or in groups (`KRSX G5CT …`), as authenticator apps show it.
    const grouped = new RegExp(SECRETS[0]!.split('').join('\\s*'));
    const shown = await screen.findAllByText(grouped);

    expect(shown.some((secret) => secret.props.selectable === true)).toBe(true);
  });

  it('shows the enrollment in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    mockSetSession(NEW_ADMIN, 'aal1');

    await renderAt('/admin');

    expect(await screen.findByText(text('admin.mfa.enroll.title', 'en'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.mfa.enroll.qrAlt', 'en'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.mfa.code', 'en'))).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: text('admin.mfa.submit', 'en') })).toBeOnTheScreen();
  });

  it('verifies the code for the enrolled factor and then opens the admin screens', async () => {
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(enrollTitle());

    await enterCode(CODE);

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(screen.queryByText(enrollTitle())).toBeNull();
    expect(mockAuth.aal).toBe('aal2');
    expect(verifiedWith()).toEqual(['f0000000-0000-4000-8000-000000000001']);
    expect(verifiedFactorIds(NEW_ADMIN.id)).toEqual(['f0000000-0000-4000-8000-000000000001']);
  });

  it('shows a loading state, not the admin screens, while the enrollment is prepared', async () => {
    mockMfa.next.enroll = ['pending'];
    mockSetSession(NEW_ADMIN, 'aal1');

    await renderAt('/admin');

    expect(await screen.findByText(text('admin.mfa.enroll.loading'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeNull();
    expect(screen.queryByText(adminStart())).toBeNull();
  });

  it('shows the try-again state when the enrollment fails, and enrolls on retry', async () => {
    mockMfa.next.enroll = [networkError()];
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');

    expect(
      await screen.findByText(text('admin.mfa.enroll.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeNull();
    expect(screen.queryByText(adminStart())).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: text('admin.guard.retry') }));

    expect(await screen.findByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.enroll.error'))).toBeNull();
  });

  it('shows the wrong-code message for a wrong code and stays on the enrollment', async () => {
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(enrollTitle());

    await enterCode(WRONG_CODE);

    expect(await screen.findByText(text('admin.mfa.errors.invalidCode'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.errors.network'))).toBeNull();
    expect(screen.getByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeOnTheScreen();
    expect(screen.queryByText(adminStart())).toBeNull();
    expect(verifyButton()).toBeEnabled();
    expect(mockAuth.aal).toBe('aal1');
  });

  it('accepts the right code after a wrong one', async () => {
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(enrollTitle());
    await enterCode(WRONG_CODE);
    await screen.findByText(text('admin.mfa.errors.invalidCode'));

    await enterCode(CODE);

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.errors.invalidCode'))).toBeNull();
  });

  it('shows a loading state and ignores further presses while the code is verified', async () => {
    const pending = deferred();
    mockMfa.next.verify = [pending.promise];
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(enrollTitle());

    await enterCode(CODE);
    await waitFor(() => expect(callsOf('verify')).toHaveLength(1));

    expect(await screen.findByText(text('admin.mfa.submitting'))).toBeOnTheScreen();
    const button =
      screen.queryByRole('button', { name: text('admin.mfa.submit') }) ??
      screen.getByRole('button', { name: text('admin.mfa.submitting') });
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    await flush();
    expect(callsOf('verify')).toHaveLength(1);

    pending.release();
    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
  });

  it('shows the try-again message, not the wrong-code one, when the verify request fails', async () => {
    mockMfa.next.verify = [networkError()];
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(enrollTitle());

    await enterCode(CODE);

    expect(await screen.findByText(text('admin.mfa.errors.network'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.errors.invalidCode'))).toBeNull();
    expect(screen.queryByText(adminStart())).toBeNull();
  });

  it('shows the try-again message when the challenge has expired, and verifies on the next attempt', async () => {
    mockMfa.expireOnVerify = 1;
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(enrollTitle());

    await enterCode(CODE);

    expect(await screen.findByText(text('admin.mfa.errors.network'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.errors.invalidCode'))).toBeNull();

    await enterCode(CODE);

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
  });

  it('enrolls again after an abandoned enrollment and verifies the new factor', async () => {
    const result = await renderAt('/admin/sign-in');
    await signIn(NEW_ADMIN.email!);
    await screen.findByLabelText(text('admin.mfa.enroll.qrAlt'));
    // Abandoned: the admin signs out without entering a code.
    await fireEvent.press(await waitFor(() => headerSignOut()));
    await waitFor(() => expect(result.getPathname()).toBe('/'));

    await act(async () => router.navigate('/admin/sign-in'));
    await signIn(NEW_ADMIN.email!);

    expect(await screen.findByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.enroll.error'))).toBeNull();
    await enterCode(CODE);
    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(verifiedFactorIds(NEW_ADMIN.id)).toEqual(['f0000000-0000-4000-8000-000000000002']);
  });

  it('treats an admin whose only factor is unverified as not enrolled', async () => {
    mockMfa.factors[NEW_ADMIN.id] = [
      { ...SEED_FACTOR, id: 'f0000000-0000-4000-8000-0000000000bb', status: 'unverified' },
    ];
    mockSetSession(NEW_ADMIN, 'aal1');

    await renderAt('/admin');

    expect(await screen.findByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeOnTheScreen();
    expect(screen.queryByText(challengeTitle())).toBeNull();
  });

  it('keeps sign-out in the admin header on the enrollment', async () => {
    mockSetSession(NEW_ADMIN, 'aal1');
    const result = await renderAt('/admin');
    await screen.findByText(enrollTitle());

    await fireEvent.press(await waitFor(() => headerSignOut()));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(mockAuth.signOuts).toBe(1);
    expect(mockAuth.session?.user.id).not.toBe(NEW_ADMIN.id);
  });
});

describe('code challenge (an admin with a verified factor in an aal1 session)', () => {
  it('asks for the code after the password, without a QR code or a secret', async () => {
    await renderAt('/admin/sign-in');

    await signIn(ADMIN.email!);

    expect(await screen.findByText(challengeTitle())).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.mfa.code'))).toBeOnTheScreen();
    expect(verifyButton()).toBeEnabled();
    expect(screen.queryByText(enrollTitle())).toBeNull();
    expect(screen.queryByLabelText(text('admin.mfa.enroll.qrAlt'))).toBeNull();
    expect(screen.queryByText(adminStart())).toBeNull();
  });

  it('shows the challenge in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    mockSetSession(ADMIN, 'aal1');

    await renderAt('/admin');

    expect(await screen.findByText(text('admin.mfa.challenge.title', 'en'))).toBeOnTheScreen();
    expect(screen.getByLabelText(text('admin.mfa.code', 'en'))).toBeOnTheScreen();
  });

  it('verifies the code for the verified factor and then opens the admin screens', async () => {
    const result = await renderAt('/admin/sign-in');
    await signIn(ADMIN.email!);
    await screen.findByText(challengeTitle());

    await enterCode(CODE);

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(result.getPathname()).toBe('/admin/categories');
    expect(mockAuth.aal).toBe('aal2');
    expect(verifiedWith()).toEqual([SEED_FACTOR.id]);
  });

  it('asks an admin whose stored session is aal1 for the code when they open /admin', async () => {
    mockSetSession(ADMIN, 'aal1');

    await renderAt('/admin');

    expect(await screen.findByText(challengeTitle())).toBeOnTheScreen();
    expect(screen.queryByText(adminStart())).toBeNull();
  });

  it('shows the wrong-code message for a wrong code and stays on the challenge', async () => {
    mockSetSession(ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(challengeTitle());

    await enterCode(WRONG_CODE);

    expect(await screen.findByText(text('admin.mfa.errors.invalidCode'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.errors.network'))).toBeNull();
    expect(screen.getByText(challengeTitle())).toBeOnTheScreen();
    expect(screen.queryByText(adminStart())).toBeNull();
    expect(verifyButton()).toBeEnabled();
  });

  it('shows the try-again message when the verify request fails', async () => {
    mockMfa.next.verify = [networkError()];
    mockSetSession(ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(challengeTitle());

    await enterCode(CODE);

    expect(await screen.findByText(text('admin.mfa.errors.network'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.errors.invalidCode'))).toBeNull();
  });

  it('shows the try-again message when the rate limit is hit', async () => {
    mockMfa.next.verify = [rateLimitError()];
    mockSetSession(ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(challengeTitle());

    await enterCode(CODE);

    expect(await screen.findByText(text('admin.mfa.errors.network'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.errors.invalidCode'))).toBeNull();
  });

  it.each([
    ['fails', networkError],
    ['hits the rate limit', rateLimitError],
  ])(
    'shows the try-again message when creating the challenge %s, and verifies on the next attempt',
    async (_case, error) => {
      mockSetSession(ADMIN, 'aal1');
      await renderAt('/admin');
      await screen.findByText(challengeTitle());
      mockMfa.next.challenge = [error()];

      await enterCode(CODE);

      expect(await screen.findByText(text('admin.mfa.errors.network'))).toBeOnTheScreen();
      expect(callsOf('challenge').length).toBeGreaterThan(0);
      expect(screen.queryByText(text('admin.mfa.errors.invalidCode'))).toBeNull();
      expect(screen.queryByText(text('admin.mfa.submitting'))).toBeNull();
      expect(verifyButton()).toBeEnabled();
      expect(screen.queryByText(adminStart())).toBeNull();

      await enterCode(CODE);

      expect(await screen.findByText(adminStart())).toBeOnTheScreen();
      expect(verifiedWith()).toContain(SEED_FACTOR.id);
    },
  );

  it('shows the try-again message when the challenge has expired, and verifies on the next attempt', async () => {
    mockMfa.expireOnVerify = 1;
    mockSetSession(ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(challengeTitle());

    await enterCode(CODE);

    expect(await screen.findByText(text('admin.mfa.errors.network'))).toBeOnTheScreen();

    await enterCode(CODE);

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
  });

  it('never enrolls another factor or removes the verified one from the aal1 session', async () => {
    mockSetSession(ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(challengeTitle());
    await enterCode(WRONG_CODE);
    await screen.findByText(text('admin.mfa.errors.invalidCode'));
    await enterCode(CODE);
    await screen.findByText(adminStart());

    expect(callsOf('enroll')).toEqual([]);
    expect(callsOf('unenroll')).toEqual([]);
    expect(mockMfa.factors[ADMIN.id]).toEqual([{ ...SEED_FACTOR }]);
  });

  it('keeps sign-out in the admin header on the challenge', async () => {
    mockSetSession(ADMIN, 'aal1');
    const result = await renderAt('/admin');
    await screen.findByText(challengeTitle());

    await fireEvent.press(await waitFor(() => headerSignOut()));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(mockAuth.signOuts).toBe(1);
    expect(mockAuth.session?.user.id).not.toBe(ADMIN.id);
  });

  it('drops content cached before the step-up', async () => {
    mockContent.categories = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Altes Thema',
        description: null,
        published: true,
        sort_order: 1,
      },
    ];
    mockSetSession(ADMIN, 'aal1');
    const result = await renderAt('/');
    expect(await screen.findByText('Altes Thema')).toBeOnTheScreen();
    // What the next read returns, e.g. because the content changed meanwhile.
    mockContent.categories = [
      {
        id: '10000000-0000-4000-8000-000000000002',
        name: 'Neues Thema',
        description: null,
        published: true,
        sort_order: 1,
      },
    ];

    await act(async () => router.navigate('/admin'));
    await screen.findByText(challengeTitle());
    await enterCode(CODE);
    await waitFor(() => expect(mockAuth.aal).toBe('aal2'));
    await waitFor(() => expect(screen.queryByText(challengeTitle())).toBeNull());
    await act(async () => router.navigate('/'));
    await waitFor(() => expect(result.getPathname()).toBe('/'));

    expect(await screen.findByText('Neues Thema')).toBeOnTheScreen();
    expect(screen.queryByText('Altes Thema')).toBeNull();
  });
});

describe('the guard with the assurance level', () => {
  it('lets an admin in an aal2 session straight in, without a challenge', async () => {
    mockSetSession(ADMIN, 'aal2');

    const result = await renderAt('/admin');

    expect(await screen.findByText(adminStart())).toBeOnTheScreen();
    expect(result.getPathname()).toBe('/admin/categories');
    expect(screen.queryByText(challengeTitle())).toBeNull();
    expect(callsOf('verify')).toEqual([]);
    expect(callsOf('enroll')).toEqual([]);
  });

  it('shows the loading state, not the admin screens, while the level is read', async () => {
    mockMfa.next.aal = ['pending'];
    mockMfa.next.listFactors = ['pending'];
    mockSetSession(ADMIN, 'aal2');

    await renderAt('/admin');

    expect(await screen.findByText(text('admin.guard.loading'))).toBeOnTheScreen();
    expect(screen.queryByText(adminStart())).toBeNull();
    expect(screen.queryByText(challengeTitle())).toBeNull();
  });

  it('shows the guard error, not the admin screens, when the level cannot be read, and reads it again on retry', async () => {
    mockMfa.next.aal = [networkError(), networkError(), networkError(), networkError()];
    mockMfa.next.listFactors = [networkError(), networkError(), networkError(), networkError()];
    mockSetSession(ADMIN, 'aal1');
    await renderAt('/admin');

    expect(
      await screen.findByText(text('admin.guard.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(adminStart())).toBeNull();
    expect(screen.queryByText(challengeTitle())).toBeNull();

    mockMfa.next.aal = [];
    mockMfa.next.listFactors = [];
    await fireEvent.press(screen.getByRole('button', { name: text('admin.guard.retry') }));

    expect(await screen.findByText(challengeTitle())).toBeOnTheScreen();
  });

  it('keeps a learner on the no-access state and never offers the enrollment', async () => {
    const result = await renderAt('/admin/sign-in');
    await signIn(LEARNER.email!);
    await waitFor(() => expect(mockAuth.session?.user.id).toBe(LEARNER.id));

    await act(async () => router.navigate('/admin'));

    await waitFor(() => {
      const redirected = result.getPathname() === '/admin/sign-in';
      const noAccess = screen.queryByText(text('admin.guard.noAccess')) !== null;
      expect(redirected || noAccess).toBe(true);
    });
    expect(screen.queryByText(enrollTitle())).toBeNull();
    expect(screen.queryByText(challengeTitle())).toBeNull();
    expect(screen.queryByText(adminStart())).toBeNull();
    expect(callsOf('enroll')).toEqual([]);
  });

  it('never offers an anonymous session the enrollment or the code challenge', async () => {
    mockSetSession(ANONYMOUS, 'aal1');

    const result = await renderAt('/admin');

    await waitFor(() => {
      const redirected = result.getPathname() === '/admin/sign-in';
      const noAccess = screen.queryByText(text('admin.guard.noAccess')) !== null;
      expect(redirected || noAccess).toBe(true);
    });
    expect(screen.queryByText(enrollTitle())).toBeNull();
    expect(screen.queryByText(challengeTitle())).toBeNull();
    expect(screen.queryByText(adminStart())).toBeNull();
    expect(callsOf('enroll')).toEqual([]);
    expect(callsOf('verify')).toEqual([]);
  });
});

// Offline, the browser fails every request at once. React Query would pause
// a request it sees offline until the connection is back, so the code step
// would hang on its loading state instead of showing the try-again message
// (found by the ui-verifier).
describe('the second factor offline', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('shows the try-again message when the code is verified offline', async () => {
    mockSetSession(ADMIN, 'aal1');
    await renderAt('/admin');
    await screen.findByText(challengeTitle());
    onlineManager.setOnline(false);
    mockMfa.next.challenge = [networkError()];

    await enterCode(CODE);

    expect(await screen.findByText(text('admin.mfa.errors.network'))).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.submitting'))).toBeNull();
    expect(verifyButton()).toBeEnabled();
  });

  it('shows the try-again state when the enrollment is prepared offline', async () => {
    const level = deferred();
    mockMfa.next.aal = [level.promise];
    mockSetSession(NEW_ADMIN, 'aal1');
    await renderAt('/admin');
    await waitFor(() => expect(callsOf('aal').length).toBeGreaterThan(0));
    // Offline once the guard has asked for the level, before the enrollment.
    onlineManager.setOnline(false);
    mockMfa.next.listFactors = [networkError()];
    level.release();

    expect(
      await screen.findByText(text('admin.mfa.enroll.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.mfa.enroll.loading'))).toBeNull();
  });
});
