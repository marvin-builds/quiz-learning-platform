import { isAuthApiError, type Session } from '@supabase/supabase-js';

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
  // A server-rejected refresh token means the user is gone (e.g. deleted as
  // a stale anonymous user, #75): start over. Any other error, such as a
  // network failure, says nothing about the user, so signing in again would
  // replace a live one.
  if (stored.error && !isRefreshTokenGone(stored.error)) throw stored.error;
  if (stored.data.session) return stored.data.session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.session) throw new Error('The anonymous sign-in returned no session');
  return data.session;
}

function isRefreshTokenGone(error: Error): boolean {
  return isAuthApiError(error) && error.code === 'refresh_token_not_found';
}
