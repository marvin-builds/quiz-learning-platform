import 'expo-sqlite/localStorage/install';

// On native, the session lives in expo-sqlite's localStorage, as Supabase's
// Expo guide sets it up; there is no URL to read a session from.
export const authStorage = globalThis.localStorage;
export const detectSessionInUrl = false;
