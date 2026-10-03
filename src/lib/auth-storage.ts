// On web, supabase-js keeps the session in window.localStorage by default.
// expo-sqlite stays out of the web bundle (see auth-storage.native.ts).
export const authStorage = undefined;
