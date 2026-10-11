import { isAuthApiError, type Session } from '@supabase/supabase-js';
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

/**
 * Which message a failed sign-in shows. Only GoTrue's invalid_credentials is
 * the visitor's typing; anything else (no connection, a server error, a rate
 * limit) gets the try-again message.
 */
export function signInErrorOf(error: unknown): 'invalidCredentials' | 'network' {
  return isAuthApiError(error) && error.code === 'invalid_credentials'
    ? 'invalidCredentials'
    : 'network';
}
