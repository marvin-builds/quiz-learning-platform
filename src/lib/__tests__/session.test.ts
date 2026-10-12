import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

import { ensureSession } from '@/lib/session';

// ensureSession() returns the stored session, or signs the visitor in
// anonymously when there is none. Boundary: the Supabase auth client
// (network and local storage), faked like supabase-js answers.

type Session = { access_token: string; user: { id: string; is_anonymous: boolean } };
type AuthResult = { data: { session: Session | null }; error: Error | null };

// supabase-js's getSession() after a failed refresh of an expired stored
// session: no session, and the refresh error.
const failedRefresh = (error: Error) => (): Promise<AuthResult> =>
  Promise.resolve({ data: { session: null }, error });

const mockAuth = {
  getSession: jest.fn<Promise<AuthResult>, []>(),
  getUser: jest.fn(),
  signInAnonymously: jest.fn<Promise<AuthResult>, []>(),
};

// A getter, because the module under test is imported (and this factory run)
// before mockAuth is initialized.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    get auth() {
      return mockAuth;
    },
  },
}));

const stored: Session = { access_token: 'stored', user: { id: 'user-1', is_anonymous: true } };
const created: Session = { access_token: 'created', user: { id: 'user-2', is_anonymous: true } };

const noSession = (): Promise<AuthResult> =>
  Promise.resolve({ data: { session: null }, error: null });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ensureSession', () => {
  beforeEach(() => {
    mockAuth.getSession.mockReset();
    mockAuth.getUser.mockReset();
    mockAuth.signInAnonymously.mockReset();
  });

  it('returns the stored session without signing in', async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: stored }, error: null });

    await expect(ensureSession()).resolves.toBe(stored);

    expect(mockAuth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('reads the session locally, never through getUser', async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: stored }, error: null });

    await ensureSession();

    expect(mockAuth.getSession).toHaveBeenCalled();
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('signs in anonymously when there is no session and returns the new one', async () => {
    mockAuth.getSession.mockImplementation(noSession);
    mockAuth.signInAnonymously.mockResolvedValue({ data: { session: created }, error: null });

    await expect(ensureSession()).resolves.toBe(created);

    expect(mockAuth.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('signs in only once for two concurrent calls without a session', async () => {
    mockAuth.getSession.mockImplementation(noSession);
    const signIn = deferred<AuthResult>();
    mockAuth.signInAnonymously.mockReturnValue(signIn.promise);

    const first = ensureSession();
    const second = ensureSession();
    signIn.resolve({ data: { session: created }, error: null });

    await expect(Promise.all([first, second])).resolves.toEqual([created, created]);
    expect(mockAuth.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('rejects when the anonymous sign-in fails', async () => {
    mockAuth.getSession.mockImplementation(noSession);
    const failure = new Error('Anonymous sign-ins are disabled');
    mockAuth.signInAnonymously.mockResolvedValue({ data: { session: null }, error: failure });

    await expect(ensureSession()).rejects.toBe(failure);
  });

  it('tries to sign in again on the next call after a failed sign-in', async () => {
    mockAuth.getSession.mockImplementation(noSession);
    mockAuth.signInAnonymously
      .mockResolvedValueOnce({ data: { session: null }, error: new Error('network') })
      .mockResolvedValueOnce({ data: { session: created }, error: null });

    await expect(ensureSession()).rejects.toThrow('network');
    await expect(ensureSession()).resolves.toBe(created);

    expect(mockAuth.signInAnonymously).toHaveBeenCalledTimes(2);
  });

  // A stale anonymous user is deleted by the database's cleanup job (#75).
  // When that visitor returns, the stored refresh token no longer exists:
  // GoTrue answers 400 refresh_token_not_found (checked on the local stack),
  // supabase-js drops the stored session and getSession() reports the error.
  // The visitor starts over with a new anonymous user instead of a dead end.
  it('signs in anonymously again when the server rejects the stored refresh token', async () => {
    mockAuth.getSession.mockImplementation(
      failedRefresh(
        new AuthApiError(
          'Invalid Refresh Token: Refresh Token Not Found',
          400,
          'refresh_token_not_found',
        ),
      ),
    );
    mockAuth.signInAnonymously.mockResolvedValue({ data: { session: created }, error: null });

    await expect(ensureSession()).resolves.toBe(created);

    expect(mockAuth.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  // A refresh that fails on the network says nothing about the user: signing
  // in again would replace a live user and orphan their progress. Guard for
  // the case above; it passes before #75 too.
  it('rejects without signing in again when the refresh fails on the network', async () => {
    const failure = new AuthRetryableFetchError('Failed to fetch', 0);
    mockAuth.getSession.mockImplementation(failedRefresh(failure));

    await expect(ensureSession()).rejects.toBe(failure);

    expect(mockAuth.signInAnonymously).not.toHaveBeenCalled();
  });
});
