import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type APIRequestContext, expect, test } from '@playwright/test';

import { API_ADMIN, passwordSession, seedAdminAccessToken, stepUp } from './admin-auth';

// The solutions and the scores over plain HTTP, the way any client can call
// the local Supabase API with the public key the app ships. The pgTAP tests
// check the grants role by role; this spec checks what PostgREST makes of
// them, including embedding (`?select=*,answers(is_correct)`), filters and
// orderings, which read a column without selecting it. Every request a
// learner must not make is answered with a 4xx error object and no rows; a
// plain column is the positive control, so a broken setup can't make the
// rejections pass vacuously. The exact status codes and the GET/POST
// difference of /rpc/ are PostgREST's business and not pinned here.
//
// Runs against the stack from `.env` after `npx supabase db reset`; the
// attempts it starts belong to its own fresh anonymous users.

const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';
const FRANCE = '30000000-0000-4000-8000-000000000001';
const PARIS = '40000000-0000-4000-8000-000000000001';

// The stack the web export talks to: .env.local in a worktree, else .env.
function setting(name: string): string {
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

const API_URL = setting('EXPO_PUBLIC_SUPABASE_URL');
const KEY = setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');

// The requests run without a page, so the viewport adds nothing: one project
// is enough, and the other would only double the anonymous users it creates.
test.skip(() => test.info().project.name !== 'desktop', 'HTTP only; runs in the desktop project');

type Caller = {
  name: string;
  headers: (request: APIRequestContext) => Promise<Record<string, string>>;
};

const anon: Caller = {
  name: 'anon',
  headers: async () => ({ apikey: KEY }),
};

// What supabase-js does for an anonymous visitor on Start: sign up without
// credentials and send the session's access token.
async function signInAnonymously(request: APIRequestContext): Promise<Record<string, string>> {
  const response = await request.post(`${API_URL}/auth/v1/signup`, {
    headers: { apikey: KEY },
    data: {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { access_token: token } = (await response.json()) as { access_token: string };
  return { apikey: KEY, Authorization: `Bearer ${token}` };
}

const anonymousUser: Caller = { name: 'an anonymous user', headers: signInAnonymously };

const SOLUTION_READS = [
  '/rest/v1/questions?select=*,answers(is_correct)',
  '/rest/v1/answers?select=is_correct',
  '/rest/v1/questions?select=explanation',
  '/rest/v1/quizzes?select=questions(explanation)',
  '/rest/v1/answers?select=id&is_correct=eq.true',
  '/rest/v1/answers?select=id&order=is_correct',
];

for (const caller of [anon, anonymousUser]) {
  test.describe(`as ${caller.name}`, () => {
    for (const route of SOLUTION_READS) {
      test(`GET ${route} is rejected without row data`, async ({ request }) => {
        const response = await request.get(`${API_URL}${route}`, {
          headers: await caller.headers(request),
        });

        expect(response.status()).toBeGreaterThanOrEqual(400);
        expect(response.status()).toBeLessThan(500);
        const body = (await response.json()) as unknown;
        expect(Array.isArray(body)).toBe(false);
        // Postgres' "permission denied", not a PostgREST parse or relationship
        // error (PGRST1xx/2xx) that a mistyped route would also get.
        expect(body).toHaveProperty('code', '42501');
        const text = JSON.stringify(body);
        expect(text).not.toContain('"is_correct":');
        expect(text).not.toContain('"explanation":');
      });
    }

    test('GET /rest/v1/answers?select=id,text returns rows (positive control)', async ({
      request,
    }) => {
      const response = await request.get(`${API_URL}/rest/v1/answers?select=id,text`, {
        headers: await caller.headers(request),
      });

      expect(response.status()).toBe(200);
      const rows = (await response.json()) as { id: string; text: string }[];
      expect(rows).toContainEqual({ id: PARIS, text: 'Paris' });
    });
  });
}

test('anon cannot start an attempt', async ({ request }) => {
  const response = await request.post(`${API_URL}/rest/v1/rpc/start_attempt`, {
    headers: { apikey: KEY },
    data: { quiz_id: HAUPTSTAEDTE },
  });

  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(response.status()).toBeLessThan(500);
  // No execute grant for anon: refused before the function runs.
  expect(await response.json()).toHaveProperty('code', '42501');
});

test('a user can neither set the score of their own attempt nor insert a scored answer', async ({
  request,
}) => {
  const headers = await signInAnonymously(request);

  const started = await request.post(`${API_URL}/rest/v1/rpc/start_attempt`, {
    headers,
    data: { quiz_id: HAUPTSTAEDTE },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const attemptId = (await started.json()) as string;

  // The attempt is the caller's own and visible to them, so a rejection below
  // is about writing, not about finding the row.
  const own = await request.get(`${API_URL}/rest/v1/attempts?select=id&id=eq.${attemptId}`, {
    headers,
  });
  expect(await own.json()).toEqual([{ id: attemptId }]);

  const patched = await request.patch(`${API_URL}/rest/v1/attempts?id=eq.${attemptId}`, {
    headers,
    data: { score: 99 },
  });
  expect(patched.status()).toBeGreaterThanOrEqual(400);
  expect(patched.status()).toBeLessThan(500);
  expect(await patched.json()).toHaveProperty('code', '42501');

  const inserted = await request.post(`${API_URL}/rest/v1/attempt_answers`, {
    headers,
    data: {
      attempt_id: attemptId,
      question_id: FRANCE,
      selected_answer_ids: [PARIS],
      is_correct: true,
      points: 99,
    },
  });
  expect(inserted.status()).toBeGreaterThanOrEqual(400);
  expect(inserted.status()).toBeLessThan(500);
  expect(await inserted.json()).toHaveProperty('code', '42501');

  const after = await request.get(`${API_URL}/rest/v1/attempts?select=score&id=eq.${attemptId}`, {
    headers,
  });
  expect(await after.json()).toEqual([{ score: 0 }]);

  const answers = await request.get(
    `${API_URL}/rest/v1/attempt_answers?select=question_id&attempt_id=eq.${attemptId}`,
    { headers },
  );
  expect(await answers.json()).toEqual([]);
});

// The admin's read of the explanation (#81): public.admin_question() is a
// public function that `authenticated` may execute, so PostgREST serves it
// as /rest/v1/rpc/admin_question. Everyone but an admin gets the function's
// own refusal (P0001 "not available", which proves the call reached it), the
// same for a question that exists and one that doesn't, and no row data;
// anon has no execute grant at all.

const FRANCE_EXPLANATION = 'Paris ist seit dem Mittelalter die Hauptstadt Frankreichs.';
const UNKNOWN_QUESTION = '30000000-0000-4000-8000-0000000000ff';

// A learner: a user who signed up with an email and a password (not
// anonymous, no admin role), unique per run.
async function signUpLearner(request: APIRequestContext): Promise<Record<string, string>> {
  const email = `learner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const response = await request.post(`${API_URL}/auth/v1/signup`, {
    headers: { apikey: KEY },
    data: { email, password: 'learner-password-1' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { access_token: token } = (await response.json()) as { access_token: string };
  return { apikey: KEY, Authorization: `Bearer ${token}` };
}

const learner: Caller = { name: 'a learner', headers: signUpLearner };

// Admin rights need a second factor (#122): an admin with a verified TOTP
// factor signed in with the password only has an aal1 session, which GoTrue
// marks in the token's aal claim, and gets exactly a learner's refusal.
// Re-spec: was the seed admin; now a dedicated admin (API_ADMIN in
// ./admin-auth, seeded with a verified factor), since a TOTP verify of the
// seed admin elsewhere in the run would end its aal1 session. One sign-in
// per worker (the local stack's rate limits); its tests run one after the
// other, the step-up of the same session last.
let apiAdminSession: ReturnType<typeof passwordSession> | undefined;

function apiAdminPasswordSession(request: APIRequestContext): ReturnType<typeof passwordSession> {
  apiAdminSession ??= passwordSession(request, API_ADMIN.email, API_ADMIN.password);
  return apiAdminSession;
}

const passwordOnlyAdmin: Caller = {
  name: 'an admin with the password only (aal1)',
  headers: async (request) => {
    const session = await apiAdminPasswordSession(request);
    return { apikey: KEY, Authorization: `Bearer ${session.access_token}` };
  },
};

for (const caller of [learner, anonymousUser, passwordOnlyAdmin]) {
  test.describe(`admin_question as ${caller.name}`, () => {
    if (caller === passwordOnlyAdmin) test.describe.configure({ mode: 'serial' });

    for (const [what, questionId] of [
      ['a question with an explanation', FRANCE],
      ['an unknown question', UNKNOWN_QUESTION],
    ] as const) {
      test(`POST /rest/v1/rpc/admin_question for ${what} is refused with "not available" only`, async ({
        request,
      }) => {
        const response = await request.post(`${API_URL}/rest/v1/rpc/admin_question`, {
          headers: await caller.headers(request),
          data: { question_id: questionId },
        });

        expect(response.status()).toBeGreaterThanOrEqual(400);
        expect(response.status()).toBeLessThan(500);
        const body = (await response.json()) as Record<string, unknown>;
        expect(Array.isArray(body)).toBe(false);
        expect(body).toHaveProperty('code', 'P0001');
        expect(body).toHaveProperty('message', 'not available');
        const text = JSON.stringify(body);
        expect(text).not.toContain(questionId);
        expect(text).not.toContain('"explanation":');
        expect(text).not.toContain(FRANCE_EXPLANATION);
      });
    }

    test('GET /rest/v1/rpc/admin_question is refused without row data', async ({ request }) => {
      const response = await request.get(
        `${API_URL}/rest/v1/rpc/admin_question?question_id=${FRANCE}`,
        { headers: await caller.headers(request) },
      );

      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(response.status()).toBeLessThan(500);
      // Whether PostgREST refuses the GET itself or the function does is
      // PostgREST's business (see the header): only the leak is pinned.
      const text = await response.text();
      expect(Array.isArray(JSON.parse(text))).toBe(false);
      expect(text).not.toContain('"explanation":');
      expect(text).not.toContain(FRANCE_EXPLANATION);
    });

    // The positive control for the aal1 refusal above: the same session
    // after the TOTP code (aal2) reads the question with its explanation,
    // so the refusal is about the missing second factor, not the user.
    if (caller === passwordOnlyAdmin) {
      test('the same session after the TOTP code (aal2) reads admin_question', async ({
        request,
      }) => {
        const session = await apiAdminPasswordSession(request);
        const token = await stepUp(request, session, API_ADMIN.totpSecret);

        const response = await request.post(`${API_URL}/rest/v1/rpc/admin_question`, {
          headers: { apikey: KEY, Authorization: `Bearer ${token}` },
          data: { question_id: FRANCE },
        });

        expect(response.ok(), await response.text()).toBe(true);
        expect(await response.json()).toEqual([
          expect.objectContaining({ id: FRANCE, explanation: FRANCE_EXPLANATION }),
        ]);
      });
    }
  });
}

// An admin with password and TOTP code (aal2) reads admin_question: the
// seed admin's aal2 token from the setup project (e2e/seed-admin.setup.ts).
test('the seed admin with password and TOTP code (aal2) reads admin_question', async ({
  request,
}) => {
  const token = await seedAdminAccessToken();

  const response = await request.post(`${API_URL}/rest/v1/rpc/admin_question`, {
    headers: { apikey: KEY, Authorization: `Bearer ${token}` },
    data: { question_id: FRANCE },
  });

  expect(response.ok(), await response.text()).toBe(true);
  expect(await response.json()).toEqual([
    expect.objectContaining({ id: FRANCE, explanation: FRANCE_EXPLANATION }),
  ]);
});

test('anon cannot call admin_question', async ({ request }) => {
  const response = await request.post(`${API_URL}/rest/v1/rpc/admin_question`, {
    headers: { apikey: KEY },
    data: { question_id: FRANCE },
  });

  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(response.status()).toBeLessThan(500);
  // No execute grant for anon: refused before the function runs.
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toHaveProperty('code', '42501');
  expect(JSON.stringify(body)).not.toContain(FRANCE_EXPLANATION);
});
