// Tests never reach a database: the Supabase client is a stub whose requests
// stay pending. Tests that need answers mock '@/lib/supabase' themselves.
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: jest.fn(() => new Promise(() => {})) },
}));
