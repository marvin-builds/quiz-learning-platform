import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type APIRequestContext, expect, test } from '@playwright/test';

// The quiz-images limits against running Storage (#124, S6/S7): the bucket
// takes png, jpeg and webp up to 5 MiB, and Storage must refuse anything
// else from an admin, who may otherwise write the bucket. Until now the
// limits were only checked as rows in pgTAP.
//
// Every upload is the seed admin's (admin@example.com / admin-password), under
// a name the Storage policies accept (`<lowercase uuid>.png` at the bucket
// root), so a refusal can only come from the limits; each refusal is pinned
// to Storage's own error (InvalidMimeType, 415; EntityTooLarge, 413), never
// just "some error", which a policy refusal (AccessDenied) would also give.
// A small png is the positive control, and a file of exactly 5 MiB is the
// upper boundary; 5 MiB + 1 byte catches any looser limit, the global one
// included. Storage checks the declared Content-Type, not the bytes, so the
// disallowed types are declared ones under a .png name: this spec makes no
// claim about content sniffing.
//
// Both ways in are covered: the REST upload the app uses, and the S3
// protocol endpoint (enabled in supabase/config.toml), signed with the
// admin's session token.
//
// Runs against the stack from `.env.local`/`.env` after
// `npx supabase db reset`, without a page, in one project. Hygiene: every
// name is a fresh random UUID, and every object the spec may have created is
// removed afterwards, also when a test failed half-way, since the bucket is
// shared with the seed images and other specs.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password';
const BUCKET = 'quiz-images';
const FIVE_MIB = 5 * 1024 * 1024;

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

test.skip(() => test.info().project.name !== 'desktop', 'HTTP only; runs in the desktop project');

const png = (size: number) => {
  // A png signature followed by padding: Storage checks the declared type
  // and the size, not the bytes.
  const body = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  return body;
};

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

let adminToken: string;
const created: string[] = [];

function freshName(): string {
  const name = `${randomUUID()}.png`;
  created.push(name);
  return name;
}

async function signInAsAdmin(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: KEY },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { access_token: string }).access_token;
}

const adminHeaders = () => ({ apikey: KEY, Authorization: `Bearer ${adminToken}` });

// The names of the bucket's root objects among `names`, as the admin lists them.
async function existing(request: APIRequestContext, names: string[]): Promise<string[]> {
  const response = await request.post(`${API_URL}/storage/v1/object/list/${BUCKET}`, {
    headers: adminHeaders(),
    data: { prefix: '', limit: 1000, offset: 0 },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const objects = (await response.json()) as { name: string }[];
  return objects.map((object) => object.name).filter((name) => names.includes(name));
}

test.beforeAll(async ({ request }) => {
  adminToken = await signInAsAdmin(request);
});

test.afterAll(async ({ request }) => {
  if (created.length === 0) return;
  const response = await request.delete(`${API_URL}/storage/v1/object/${BUCKET}`, {
    headers: adminHeaders(),
    data: { prefixes: created },
  });
  expect(response.ok(), await response.text()).toBe(true);
  expect(await existing(request, created)).toEqual([]);
});

test.describe('REST upload as admin', () => {
  type Outcome = { status: number; body: Record<string, unknown> };

  async function upload(
    request: APIRequestContext,
    name: string,
    contentType: string,
    body: Buffer,
  ): Promise<Outcome> {
    const response = await request.post(`${API_URL}/storage/v1/object/${BUCKET}/${name}`, {
      headers: { ...adminHeaders(), 'Content-Type': contentType },
      data: body,
    });
    return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
  }

  // Storage answers a refused upload with HTTP 400 or the status itself and
  // carries the specific one in its error object.
  function expectRefusedWith(outcome: Outcome, statusCode: string, code: string) {
    expect([400, Number(statusCode)]).toContain(outcome.status);
    expect(outcome.body).toMatchObject({ statusCode, code });
  }

  test('accepts a small png (positive control)', async ({ request }) => {
    const name = freshName();
    const outcome = await upload(request, name, 'image/png', png(1024));

    expect(outcome.status).toBe(200);
    expect(await existing(request, [name])).toEqual([name]);
  });

  test('accepts a png of exactly 5 MiB', async ({ request }) => {
    const name = freshName();
    const outcome = await upload(request, name, 'image/png', png(FIVE_MIB));

    expect(outcome.status).toBe(200);
    expect(await existing(request, [name])).toEqual([name]);
  });

  for (const [type, body] of [
    ['image/svg+xml', SVG],
    ['text/html', HTML],
  ] as const) {
    test(`refuses ${type} under a .png name as an invalid file type`, async ({ request }) => {
      const name = freshName();
      const outcome = await upload(request, name, type, body);

      expectRefusedWith(outcome, '415', 'InvalidMimeType');
      expect(await existing(request, [name])).toEqual([]);
    });
  }

  test('refuses a png of 5 MiB + 1 byte as too large', async ({ request }) => {
    const name = freshName();
    const outcome = await upload(request, name, 'image/png', png(FIVE_MIB + 1));

    expectRefusedWith(outcome, '413', 'EntityTooLarge');
    expect(await existing(request, [name])).toEqual([]);
  });
});

test.describe('S3 protocol upload as admin', () => {
  // Session-token access (Supabase's "S3 authentication with a user JWT"):
  // the access key is the project ref, the secret the project's anon JWT
  // key and the session token the user's access token, so the Storage
  // policies apply as for the REST upload. The local stack's tenant is
  // `stub`; its legacy anon key comes from `supabase status`, since .env
  // has only the publishable key, which S3 signing doesn't accept.
  const ACCESS_KEY = 'stub';
  const REGION = 'local';
  let secret: string;

  test.beforeAll(() => {
    const status = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const json = /\{[\s\S]*\}/.exec(status)?.[0];
    if (!json) throw new Error(`supabase status printed no JSON: ${status}`);
    secret = (JSON.parse(json) as { ANON_KEY: string }).ANON_KEY;
  });

  const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const hmac = (key: Buffer | string, data: string) =>
    createHmac('sha256', key).update(data).digest();

  // A PutObject request signed with AWS Signature Version 4.
  async function put(
    request: APIRequestContext,
    name: string,
    contentType: string,
    body: Buffer,
  ): Promise<{ status: number; text: string }> {
    const url = new URL(`${API_URL}/storage/v1/s3/${BUCKET}/${name}`);
    const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const date = now.slice(0, 8);
    const payloadHash = sha256(body);
    const signed: Record<string, string> = {
      'content-type': contentType,
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': now,
      'x-amz-security-token': adminToken,
    };
    const names = Object.keys(signed).sort();
    const canonical = [
      'PUT',
      url.pathname,
      '',
      ...names.map((header) => `${header}:${signed[header]}`),
      '',
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${date}/${REGION}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
    let key = hmac(`AWS4${secret}`, date);
    for (const part of [REGION, 's3', 'aws4_request']) key = hmac(key, part);
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    const { host: _host, ...headers } = signed;
    const response = await request.put(url.toString(), {
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
      },
      data: body,
    });
    return { status: response.status(), text: await response.text() };
  }

  test('accepts a small png (positive control)', async ({ request }) => {
    const name = freshName();
    const outcome = await put(request, name, 'image/png', png(1024));

    expect(outcome.status, outcome.text).toBe(200);
    expect(await existing(request, [name])).toEqual([name]);
  });

  test('accepts a png of exactly 5 MiB', async ({ request }) => {
    const name = freshName();
    const outcome = await put(request, name, 'image/png', png(FIVE_MIB));

    expect(outcome.status, outcome.text).toBe(200);
    expect(await existing(request, [name])).toEqual([name]);
  });

  for (const [type, body] of [
    ['image/svg+xml', SVG],
    ['text/html', HTML],
  ] as const) {
    test(`refuses ${type} under a .png name as an invalid file type`, async ({ request }) => {
      const name = freshName();
      const outcome = await put(request, name, type, body);

      expect(outcome.status, outcome.text).toBe(415);
      expect(outcome.text).toContain('<Code>InvalidMimeType</Code>');
      expect(await existing(request, [name])).toEqual([]);
    });
  }

  test('refuses a png of 5 MiB + 1 byte as too large', async ({ request }) => {
    const name = freshName();
    const outcome = await put(request, name, 'image/png', png(FIVE_MIB + 1));

    expect(outcome.status, outcome.text).toBe(413);
    expect(outcome.text).toContain('<Code>EntityTooLarge</Code>');
    expect(await existing(request, [name])).toEqual([]);
  });
});
