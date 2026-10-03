import type { Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

let pending: Promise<Session> | null = null;

/**
 * The visitor's session, signing them in anonymously when there is none.
 * Concurrent callers share one sign-in, so a visitor never gets two users.
 */
export function ensureSession(): Promise<Session> {
  pending ??= loadOrSignIn().finally(() => {
    pending = null;
  });
  return pending;
}

async function loadOrSignIn(): Promise<Session> {
  // getSession reads the stored session without a network request.
  const stored = await supabase.auth.getSession();
  if (stored.error) throw stored.error;
  if (stored.data.session) return stored.data.session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.session) throw new Error('The anonymous sign-in returned no session');
  return data.session;
}
