import { isAuthApiError, isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

/**
 * The current session as Supabase reports it, following every sign-in and
 * sign-out. `ready` is false until the first report.
 */
export function useAuthSession(): { ready: boolean; session: Session | null } {
  const [state, setState] = useState<{ ready: boolean; session: Session | null }>({
    ready: false,
    session: null,
  });

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ ready: true, session });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return state;
}

/**
 * Whether the signed-in user is an admin. The role is read from `profiles`
 * (RLS: only their own row), never from the JWT's metadata, which the user
 * can set themselves.
 */
export async function fetchIsAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.role === 'admin';
}

export type SignInError = 'invalidCredentials' | 'network';

/** Signs in with email and password; the error says which message to show. */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export function signInErrorOf(error: unknown): SignInError {
  if (isAuthRetryableFetchError(error)) return 'network';
  if (isAuthApiError(error) && error.code === 'invalid_credentials') return 'invalidCredentials';
  // Anything else (a server error, a rate limit) isn't the visitor's typing.
  return 'network';
}
