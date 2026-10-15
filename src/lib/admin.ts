import { isAuthApiError, type Session } from '@supabase/supabase-js';
import { useQuery } from '@tanstack/react-query';
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
 * Whether the current user is an admin. Only a signed-in, non-anonymous user
 * can be one, so nobody else's profile is read. Keyed by user, so a sign-in
 * or sign-out never reuses another user's role.
 */
export function useIsAdmin() {
  const { ready, session } = useAuthSession();
  const userId = session && !session.user.is_anonymous ? session.user.id : null;
  const isAdmin = useQuery({
    queryKey: ['isAdmin', userId],
    queryFn: () => fetchIsAdmin(userId!),
    enabled: userId !== null,
  });
  return { ready, userId, isAdmin };
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

/** Where an admin stands with the second factor (#122). */
export type AdminAssurance =
  | { level: 'aal2' }
  | { level: 'aal1'; verifiedFactorId: string }
  | { level: 'aal1'; verifiedFactorId: null };

export const adminAssuranceKey = (userId: string | null) => ['adminAssurance', userId] as const;

/**
 * The session's assurance level and the admin's verified TOTP factor, as
 * supabase-js reports them; never decoded from the JWT by the app. Admin
 * rights need aal2, which the database checks too (`private.is_admin()`).
 */
export async function fetchAdminAssurance(): Promise<AdminAssurance> {
  const [level, factors] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  if (level.error) throw level.error;
  if (factors.error) throw factors.error;
  if (level.data.currentLevel === 'aal2') return { level: 'aal2' };
  return { level: 'aal1', verifiedFactorId: factors.data.totp[0]?.id ?? null };
}

/**
 * The admin's assurance, read only once the role says admin, so learners
 * and anonymous users are never asked for a second factor.
 */
export function useAdminAssurance(userId: string | null, isAdmin: boolean) {
  return useQuery({
    queryKey: adminAssuranceKey(userId),
    queryFn: fetchAdminAssurance,
    enabled: userId !== null && isAdmin,
  });
}

/**
 * A new TOTP factor to enroll. Unverified TOTP factors left from an
 * abandoned enrollment are removed first, so they never pile up. Verified
 * factors are never touched here.
 */
export async function enrollTotpFactor(): Promise<{
  factorId: string;
  qrCode: string;
  secret: string;
}> {
  const factors = await supabase.auth.mfa.listFactors();
  if (factors.error) throw factors.error;
  for (const factor of factors.data.all) {
    if (factor.factor_type !== 'totp' || factor.status === 'verified') continue;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) throw error;
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error) throw error;
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/**
 * Verifies a code against a fresh challenge of the factor, so an expired
 * challenge never strands the admin.
 */
export async function verifyTotpCode(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
  if (error) throw error;
}

/**
 * Which message a failed code shows: only GoTrue's mfa_verification_failed
 * is the admin's typing; a network error, a rate limit or an expired
 * challenge gets the try-again message.
 */
export function codeErrorOf(error: unknown): 'invalidCode' | 'network' {
  return isAuthApiError(error) && error.code === 'mfa_verification_failed'
    ? 'invalidCode'
    : 'network';
}
