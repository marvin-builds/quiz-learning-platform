import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type APIRequestContext, expect, type Page, type TestInfo } from '@playwright/test';

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

export type TestAdmin = { email: string; password: string; totpSecret: string };
type Viewport = 'phone' | 'desktop';

function testAdmin(localPart: string, totpSecret: string): TestAdmin {
  return { email: `${localPart}@example.com`, password: `${localPart}-password`, totpSecret };
}

/**
 * Dedicated admins (supabase/seed.sql, local only like the seed admin), each
 * with a verified TOTP factor and its own local-only secret, for the tests
 * that sign in with password and code or sign out themselves: a verify ends
 * the user's other aal1 sessions and a sign-out ends the session, so such a
 * test must not share its user with a test running at the same time. One
 * admin per spec file and project (phone and desktop run at the same time);
 * within a file, the tests run one after another in one worker. The
 * password is the local part of the email followed by `-password`.
 */
export const TEST_ADMINS = {
  // e2e/admin-mfa.spec.ts: the challenge after the password.
  mfa: {
    phone: testAdmin('admin-mfa-phone', 'LOCALONLYMFAPHONETOTPDONTUSEABCD'),
    desktop: testAdmin('admin-mfa-desktop', 'LOCALONLYMFADESKTOPTOTPDONTUSEAB'),
  },
  // e2e/admin.spec.ts: the sign-in and the sign-out.
  signIn: {
    phone: testAdmin('admin-sign-in-phone', 'LOCALONLYSIGNINPHONETOTPDONTUSEA'),
    desktop: testAdmin('admin-sign-in-desktop', 'LOCALONLYSIGNINDESKTOPTOTPDONTUS'),
  },
  // e2e/navigation.spec.ts: "Abmelden" in the header.
  navigation: {
    phone: testAdmin('admin-nav-phone', 'LOCALONLYNAVPHONETOTPDONTUSEABCD'),
    desktop: testAdmin('admin-nav-desktop', 'LOCALONLYNAVDESKTOPTOTPDONTUSEAB'),
  },
} as const satisfies Record<string, Record<Viewport, TestAdmin>>;

/**
 * The admin for e2e/api-solutions.spec.ts (desktop project only): its
 * password-only (aal1) session is refused admin rights, and the same
 * session after the code (aal2) is the positive control.
 */
export const API_ADMIN: TestAdmin = testAdmin('admin-api-aal1', 'LOCALONLYAPIAALONETOTPDONTUSEABC');

/** The test's dedicated admin of one group for the running project. */
export function adminFor(group: Record<Viewport, TestAdmin>, testInfo: TestInfo): TestAdmin {
  const project = testInfo.project.name;
  if (project !== 'phone' && project !== 'desktop') {
    throw new Error(`No dedicated admin for the project ${project}`);
  }
  return group[project];
}

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

// The seed admin's sessions for the whole run (#122). Every successful TOTP
// verify makes GoTrue end all of that user's sessions below aal2, so tests
// that verify the same user at the same time kill each other's session
// between password and code. The setup project (e2e/seed-admin.setup.ts,
// a dependency of the phone and desktop projects in playwright.config.ts)
// therefore signs the seed admin in once, before any test, and saves two
// aal2 sessions: the browser's storage state for the UI and an access token
// for the API. No test verifies the seed admin again, and none signs these
// sessions out; a test that signs in or out itself uses a dedicated admin
// (TEST_ADMINS) or one it creates. Both live in test-results/, which
// Playwright empties at the start of every run and git ignores.
const SESSION_DIR = path.join(process.cwd(), 'test-results', '.auth');
export const SEED_ADMIN_STORAGE_STATE = path.join(SESSION_DIR, 'seed-admin-storage-state.json');
export const SEED_ADMIN_TOKEN_FILE = path.join(SESSION_DIR, 'seed-admin-token.json');

/** Writes the aal2 access token the setup project got for the API. */
export function saveSeedAdminAccessToken(token: string): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SEED_ADMIN_TOKEN_FILE, JSON.stringify({ accessToken: token }));
}

function readSaved(file: string): string {
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing: the setup project (e2e/seed-admin.setup.ts) saves it before the ` +
        'phone and desktop projects run (dependencies in playwright.config.ts)',
    );
  }
  return readFileSync(file, 'utf8');
}

/**
 * The seed admin's aal2 access token for API calls, saved by the setup
 * project (password and TOTP code, once per run).
 */
export async function seedAdminAccessToken(): Promise<string> {
  const { accessToken } = JSON.parse(readSaved(SEED_ADMIN_TOKEN_FILE)) as { accessToken: string };
  return accessToken;
}

type StorageState = {
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
};

/**
 * Opens /admin in this page with the seed admin's aal2 session from the
 * setup project and waits for the admin start, the category list at
 * /admin/categories. The session goes into localStorage (where supabase-js
 * keeps it on the web) before the app's first script on the next load, once
 * per tab, so a session the app changes later isn't overwritten. Only the
 * page's own context gets it: contexts a test opens for a learner stay
 * without a session.
 */
export async function openAdminAsSeedAdmin(page: Page): Promise<void> {
  const state = JSON.parse(readSaved(SEED_ADMIN_STORAGE_STATE)) as StorageState;
  const entries = state.origins.flatMap(({ origin, localStorage }) =>
    localStorage.map(({ name, value }) => ({ origin, name, value })),
  );
  if (entries.length === 0) throw new Error('The saved storage state holds no session');
  await page.addInitScript((items) => {
    const flag = 'e2e-seed-admin-session';
    if (window.sessionStorage.getItem(flag)) return;
    for (const { origin, name, value } of items) {
      if (origin === window.location.origin) window.localStorage.setItem(name, value);
    }
    window.sessionStorage.setItem(flag, '1');
  }, entries);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(
    page.getByRole('heading', { name: text('admin.categories.title'), exact: true }),
  ).toBeVisible();
}
