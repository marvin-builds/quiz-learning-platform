import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { authStorage, detectSessionInUrl } from '@/lib/auth-storage';
import type { Database } from '@/types/database';

// Expo inlines EXPO_PUBLIC_* at build time: `.env` holds the local stack's
// values, CI sets the hosted project's for the deployed build.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set');
}

// The session survives a reload, so a returning visitor keeps their
// anonymous user instead of signing up again.
export const supabase = createClient<Database>(url, key, {
  auth: {
    storage: authStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl,
  },
});

// Native apps refresh the token only while in the foreground (Supabase's
// Expo guide); the browser handles this on its own.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
