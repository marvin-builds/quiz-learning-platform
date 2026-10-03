import 'expo-sqlite/localStorage/install';

// On native, the session lives in expo-sqlite's localStorage, as Supabase's
// Expo guide sets it up.
export const authStorage = globalThis.localStorage;
