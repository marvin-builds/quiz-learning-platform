import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

// Expo inlines EXPO_PUBLIC_* at build time: `.env` holds the local stack's
// values, CI sets the hosted project's for the deployed build.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set');
}

export const supabase = createClient<Database>(url, key);
