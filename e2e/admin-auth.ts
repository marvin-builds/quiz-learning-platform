import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type APIRequestContext, expect, type Page } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { totp, untilNextStep } from './totp';

// The admin's sign-in for the e2e tests (#122): password, then a TOTP code.
//
// The seed admin (supabase/seed.sql) has a verified TOTP factor with the
// secret below. It is for the local stack only: seed.sql runs on
// `supabase db reset`, never on the hosted project, and this file is the
// only other place the secret appears. The codes come from ./totp, a small
// RFC 6238 implementation, so no dependency is needed.
export const SEED_ADMIN = {
  email: 'admin@example.com',
  password: 'admin-password',
  totpSecret: 'LOCALONLYADMINTOTPSECRETDONTUSE2',
} as const;

function text(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
  if (typeof value !== 'string') throw new Error(`de.json has no text for ${key}`);
  return value;
}

/**
 * Enters the current code on the enrollment or challenge screen and waits
 * until the admin screens show. Several tests sign in as the seed admin at
 * once, and a code may be refused when it is about to expire or was just
 * used; then it waits for the next step and tries once more with its code.
 * The outcome of each try comes from GoTrue's verify response, not from the
 * screen: a message from an earlier try may still be showing.
 */
export async function enterTotpCode(page: Page, secret: string): Promise<void> {
  const field = page.getByLabel(text('admin.mfa.code'), { exact: true });
  const submit = page.getByRole('button', { name: text('admin.mfa.submit'), exact: true });
  const done = page.getByRole('heading', { name: text('admin.categories.title'), exact: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await done.isVisible()) return;
    // Too close to the end of a step, the code may expire on the way.
    if (untilNextStep() < 3000) await page.waitForTimeout(untilNextStep() + 250);
    await field.fill(totp(secret));
    const verified = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/auth\/v1\/factors\/[^/]+\/verify/.test(response.url()),
    );
    await submit.click();
    if ((await verified).ok()) break;
    await page.waitForTimeout(untilNextStep() + 250);
  }
  await expect(done).toBeVisible();
}

/** Signs in with a password at /admin/sign-in, before any second factor. */
export async function signInWithPassword(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin/sign-in');
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(email);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
}

/**
 * Signs the seed admin in with password and TOTP code and waits for the
 * category list (/admin/categories), the admin start.
 */
export async function signInAsSeedAdmin(page: Page): Promise<void> {
  await signInWithPassword(page, SEED_ADMIN.email, SEED_ADMIN.password);
  await expect(
    page.getByRole('heading', { name: text('admin.mfa.challenge.title'), exact: true }),
  ).toBeVisible();
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
}

// The stack the web export talks to: .env.local in a worktree, else .env.
export function setting(name: string): string {
  for (const file of ['.env.local', '.env']) {
    const full = path.join(process.cwd(), file);
    if (!existsSync(full)) continue;
    const line = readFileSync(full, 'utf8')
      .split('\n')
      .find((candidate) => candidate.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  }
  throw new Error(`Neither .env.local nor .env sets ${name}`);
}

let serviceRoleKey: string | null = null;

// The local stack's service role key, which the CLI prints and which is the
// same on every machine; only for setting up fixtures, never in the app.
function localServiceRoleKey(): string {
  if (serviceRoleKey) return serviceRoleKey;
  const output = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const match = /^SERVICE_ROLE_KEY="?([^"\n]+)"?$/m.exec(output);
  if (!match) throw new Error('`supabase status -o env` printed no SERVICE_ROLE_KEY');
  serviceRoleKey = match[1]!;
  return serviceRoleKey;
}

export type TemporaryAdmin = { id: string; email: string; password: string };

/**
 * A fresh admin without a second factor, as the hosted admin is right after
 * the deploy: created through the local stack's admin API and promoted in
 * profiles (the owner's way, never the app's). Remove it with removeAdmin.
 */
export async function createAdminWithoutFactor(
  request: APIRequestContext,
): Promise<TemporaryAdmin> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const key = localServiceRoleKey();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const email = `e2e-admin-${randomUUID()}@example.com`;
  const password = `pw-${randomUUID()}`;

  const created = await request.post(`${apiUrl}/auth/v1/admin/users`, {
    headers,
    data: { email, password, email_confirm: true },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };

  const promoted = await request.patch(`${apiUrl}/rest/v1/profiles?id=eq.${id}`, {
    headers: { ...headers, Prefer: 'return=representation' },
    data: { role: 'admin' },
  });
  expect(promoted.ok(), await promoted.text()).toBe(true);
  expect(await promoted.json()).toEqual([expect.objectContaining({ id, role: 'admin' })]);

  return { id, email, password };
}

export async function removeAdmin(request: APIRequestContext, admin: TemporaryAdmin) {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const key = localServiceRoleKey();
  await request.delete(`${apiUrl}/auth/v1/admin/users/${admin.id}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
}

type TokenResponse = {
  access_token: string;
  user: { factors?: { id: string; factor_type: string; status: string }[] };
};

/** A password sign-in over HTTP, as supabase-js does it: an aal1 session. */
export async function passwordSession(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<TokenResponse> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const key = setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const signIn = await request.post(`${apiUrl}/auth/v1/token?grant_type=password`, {
    headers: { apikey: key },
    data: { email, password },
  });
  expect(signIn.ok(), await signIn.text()).toBe(true);
  return (await signIn.json()) as TokenResponse;
}

/**
 * Steps an aal1 session up to aal2 over HTTP, as supabase-js's
 * mfa.challengeAndVerify does: a challenge for the verified TOTP factor,
 * then the code. A refused code (about to expire, or just used by a
 * parallel test) is tried again with the next step's code. Returns the
 * aal2 access token.
 */
export async function stepUp(
  request: APIRequestContext,
  session: TokenResponse,
  secret: string,
): Promise<string> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const key = setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const headers = { apikey: key, Authorization: `Bearer ${session.access_token}` };
  const factor = session.user.factors?.find(
    (candidate) => candidate.factor_type === 'totp' && candidate.status === 'verified',
  );
  if (!factor) throw new Error('The user has no verified TOTP factor');

  let last = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (untilNextStep() < 3000) await new Promise((r) => setTimeout(r, untilNextStep() + 250));
    const challenge = await request.post(`${apiUrl}/auth/v1/factors/${factor.id}/challenge`, {
      headers,
      data: {},
    });
    expect(challenge.ok(), await challenge.text()).toBe(true);
    const { id: challengeId } = (await challenge.json()) as { id: string };
    const verify = await request.post(`${apiUrl}/auth/v1/factors/${factor.id}/verify`, {
      headers,
      data: { challenge_id: challengeId, code: totp(secret) },
    });
    if (verify.ok()) return ((await verify.json()) as { access_token: string }).access_token;
    last = await verify.text();
    await new Promise((r) => setTimeout(r, untilNextStep() + 250));
  }
  throw new Error(`The TOTP verify kept failing: ${last}`);
}

let seedAdminSession: Promise<TokenResponse> | undefined;
let seedAdminToken: Promise<string> | undefined;

/**
 * The seed admin's password-only (aal1) session, one sign-in per worker
 * (each worker loads this module once): the local stack limits sign-ins and
 * verifications per IP ([auth.rate_limit] in supabase/config.toml). Its
 * access token stays aal1 after the step-up below, which issues new tokens.
 */
export function seedAdminPasswordSession(request: APIRequestContext): Promise<TokenResponse> {
  seedAdminSession ??= passwordSession(request, SEED_ADMIN.email, SEED_ADMIN.password);
  return seedAdminSession;
}

/**
 * The seed admin's aal2 access token for API calls, one step-up per worker,
 * from the cached password session.
 */
export function seedAdminAccessToken(request: APIRequestContext): Promise<string> {
  seedAdminToken ??= seedAdminPasswordSession(request).then((session) =>
    stepUp(request, session, SEED_ADMIN.totpSecret),
  );
  return seedAdminToken;
}
