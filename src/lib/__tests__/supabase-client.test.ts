import path from 'path';

// The options src/lib/supabase.ts gives createClient. The session must
// survive a reload (persistSession) so a second Start reuses the anonymous
// user instead of signing up again. On native, the session lives in
// expo-sqlite's localStorage (Supabase's Expo guide); on web, supabase-js
// keeps its default (window.localStorage) and expo-sqlite is never loaded.
//
// jest.setup.ts mocks '@/lib/supabase' for every test; this file needs the
// real module. Boundaries: createClient (the network client) and expo-sqlite's
// install module (a native module). jest-expo resolves for iOS, so
// '@/lib/auth-storage' is the .native file; the web file is loaded by path.

jest.unmock('@/lib/supabase');

type ClientOptions = { auth?: Record<string, unknown> };

const mockCreateClient = jest.fn((_url: string, _key: string, _options?: ClientOptions) => ({}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options?: ClientOptions) =>
    mockCreateClient(url, key, options),
}));

// What expo-sqlite/localStorage/install does on native: put a
// SQLite-backed localStorage on the global object.
const mockSqliteStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
const mockSqliteInstall = { loads: 0 };

jest.mock('expo-sqlite/localStorage/install', () => {
  mockSqliteInstall.loads += 1;
  (globalThis as { localStorage?: unknown }).localStorage = mockSqliteStorage;
  return {};
});

const WEB_AUTH_STORAGE = path.join(__dirname, '..', 'auth-storage.ts');

function authOptions(): Record<string, unknown> {
  expect(mockCreateClient).toHaveBeenCalledTimes(1);
  const options = mockCreateClient.mock.calls[0][2];
  expect(options?.auth).toBeDefined();
  return options!.auth!;
}

describe('the Supabase client options', () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    mockSqliteInstall.loads = 0;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  describe('on native', () => {
    beforeEach(() => {
      jest.isolateModules(() => {
        jest.requireActual('@/lib/supabase');
      });
    });

    it('keeps the session persisted and refreshes its token', () => {
      expect(authOptions()).toMatchObject({ persistSession: true, autoRefreshToken: true });
    });

    it("stores the session in expo-sqlite's localStorage", () => {
      expect(mockSqliteInstall.loads).toBeGreaterThan(0);
      expect(authOptions().storage).toBe(mockSqliteStorage);
    });

    it('does not look for a session in the URL', () => {
      expect(authOptions().detectSessionInUrl).toBe(false);
    });
  });

  describe('on web', () => {
    beforeEach(() => {
      jest.isolateModules(() => {
        jest.doMock('@/lib/auth-storage', () => jest.requireActual(WEB_AUTH_STORAGE));
        jest.requireActual('@/lib/supabase');
      });
    });

    afterEach(() => {
      jest.dontMock('@/lib/auth-storage');
    });

    it('keeps the session persisted and refreshes its token', () => {
      expect(authOptions()).toMatchObject({ persistSession: true, autoRefreshToken: true });
    });

    it("leaves the storage to supabase-js' default and never loads expo-sqlite", () => {
      expect(authOptions().storage).toBeUndefined();
      expect(mockSqliteInstall.loads).toBe(0);
    });
  });
});
