/**
 * @jest-environment node
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// The scheduled image cleanup (#125) against the local stack. A GitHub
// Actions schedule runs `node scripts/clean-up-images.mjs` with SUPABASE_URL
// and SUPABASE_SECRET_KEY (a secret only the workflow holds). It asks
// public.orphaned_quiz_images(now - grace period) which objects of the
// quiz-images bucket no question or answer names, and removes them through
// the Storage API, so the public file itself is gone, not only its
// storage.objects row (Storage refuses a direct SQL delete anyway). The
// grace period lets an upload whose save is still running survive; it is
// well over an upload plus a save, about a day: an object 12 hours old stays,
// one 48 hours old goes. The exact boundary is in
// supabase/tests/database/orphaned_quiz_images.test.sql.
//
// `--now <ISO time>` stands in for the clock (a real boundary): uploads can't
// be backdated through the API, so the script is run "later" instead.
//
// Needs the worktree's stack: `npx supabase start && npx supabase db reset`,
// then `npm run test:stack`. `npm test` leaves this file out; CI runs it in
// the database job. The test talks to the stack over node:http, since Jest's
// Expo preset replaces the global fetch (and so supabase-js) with a stub.

jest.setTimeout(120_000);

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'clean-up-images.mjs');
const BUCKET = 'quiz-images';
const OTHER_BUCKET = 'clean-up-test-other';
const HOUR = 60 * 60 * 1000;

// A tiny but valid PNG (1x1, transparent).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

type Stack = { url: string; secretKey: string; publishableKey: string };

function readStack(): Stack {
  const result = spawnSync('npx', ['supabase', 'status', '-o', 'env'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`the local stack is not running (npx supabase start):\n${result.stderr}`);
  }
  const env = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) env.set(match[1], match[2]);
  }
  const url = env.get('API_URL');
  const secretKey = env.get('SECRET_KEY') ?? env.get('SERVICE_ROLE_KEY');
  const publishableKey = env.get('PUBLISHABLE_KEY') ?? env.get('ANON_KEY');
  if (!url || !secretKey || !publishableKey) {
    throw new Error('supabase status gave no API_URL, secret key or publishable key');
  }
  return { url, secretKey, publishableKey };
}

let stack: Stack;
const created: { bucket: string; name: string }[] = [];

type Reply = { status: number; body: string };

/** One HTTP request to the local stack with the secret key (or `key`). */
function request(
  method: string,
  route: string,
  options: { body?: Buffer | string; type?: string; key?: string; prefer?: string } = {},
): Promise<Reply> {
  const key = options.key ?? stack.secretKey;
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}` };
  if (options.type) headers['Content-Type'] = options.type;
  if (options.prefer) headers.Prefer = options.prefer;
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, stack.url), { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const json = (value: unknown) => ({ body: JSON.stringify(value), type: 'application/json' });

beforeAll(() => {
  stack = readStack();
});

afterAll(async () => {
  for (const bucket of [BUCKET, OTHER_BUCKET]) {
    const prefixes = created.filter((object) => object.bucket === bucket).map((o) => o.name);
    if (prefixes.length > 0) {
      await request('DELETE', `/storage/v1/object/${bucket}`, json({ prefixes }));
    }
  }
  await request('POST', `/storage/v1/bucket/${OTHER_BUCKET}/empty`);
  await request('DELETE', `/storage/v1/bucket/${OTHER_BUCKET}`);
});

async function upload(bucket = BUCKET): Promise<string> {
  const name = `${randomUUID()}.png`;
  const reply = await request('POST', `/storage/v1/object/${bucket}/${name}`, {
    body: PNG,
    type: 'image/png',
  });
  if (reply.status !== 200) {
    throw new Error(`upload of ${name} to ${bucket} failed: ${reply.status} ${reply.body}`);
  }
  created.push({ bucket, name });
  return name;
}

/** The HTTP status of the object's public URL: 200 while the file is served. */
async function publicStatus(name: string): Promise<number> {
  return (await request('GET', `/storage/v1/object/public/${BUCKET}/${name}`)).status;
}

/** Whether the object can still be downloaded with the secret key. */
async function downloadable(bucket: string, name: string): Promise<boolean> {
  return (
    (await request('GET', `/storage/v1/object/authenticated/${bucket}/${name}`)).status === 200
  );
}

/** Sets a question's image through the REST API, as the service role. */
async function setQuestionImage(id: string, image_path: string | null, image_alt: string | null) {
  const reply = await request('PATCH', `/rest/v1/questions?id=eq.${id}`, {
    ...json({ image_path, image_alt }),
    prefer: 'return=minimal',
  });
  if (reply.status >= 300) throw new Error(`could not set the question's image: ${reply.body}`);
}

/** The image_path of every question and answer that has one. */
async function namedPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const table of ['questions', 'answers']) {
    const reply = await request(
      'GET',
      `/rest/v1/${table}?select=image_path&image_path=not.is.null`,
    );
    if (reply.status !== 200) throw new Error(`could not read ${table}: ${reply.body}`);
    paths.push(
      ...(JSON.parse(reply.body) as { image_path: string }[]).map((row) => row.image_path),
    );
  }
  return paths;
}

function scriptRun(later: number, env: Record<string, string | undefined>) {
  expect(existsSync(SCRIPT)).toBe(true);
  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SUPABASE_URL: stack.url,
    SUPABASE_SECRET_KEY: stack.secretKey,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  return {
    args: [SCRIPT, '--now', new Date(Date.now() + later).toISOString()],
    options: { cwd: ROOT, env: childEnv as NodeJS.ProcessEnv },
  };
}

/** Runs the cleanup as the schedule does, `later` ms from now. */
function cleanUp(later: number, env: Record<string, string | undefined> = {}) {
  const { args, options } = scriptRun(later, env);
  const result = spawnSync(process.execPath, args, { ...options, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** Like cleanUp, without blocking this process (for a proxy it serves). */
function cleanUpAsync(
  later: number,
  env: Record<string, string | undefined> = {},
): Promise<{ status: number | null; output: string }> {
  const { args, options } = scriptRun(later, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

const okRun = (run: { status: number | null; output: string }) => {
  if (run.status !== 0) throw new Error(`the cleanup failed:\n${run.output}`);
};

describe('scheduled image cleanup (local stack)', () => {
  it('keeps an unreferenced object younger than the grace period (12 hours)', async () => {
    const fresh = await upload();
    expect(await publicStatus(fresh)).toBe(200);

    okRun(cleanUp(12 * HOUR));

    expect(await publicStatus(fresh)).toBe(200);
  });

  it('removes an unreferenced object older than the grace period (48 hours), so its public URL no longer serves the file', async () => {
    const orphan = await upload();
    expect(await publicStatus(orphan)).toBe(200);

    okRun(cleanUp(48 * HOUR));

    const status = await publicStatus(orphan);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(await downloadable(BUCKET, orphan)).toBe(false);
  });

  it('keeps an old object a question of an unpublished quiz names', async () => {
    // Flüsse in Deutschland is the seed's unpublished draft.
    const question = '30000000-0000-4000-8000-000000000006';
    const named = await upload();
    await setQuestionImage(question, named, 'Ein Fluss');
    try {
      okRun(cleanUp(48 * HOUR));

      expect(await publicStatus(named)).toBe(200);
    } finally {
      await setQuestionImage(question, null, null);
    }
  });

  it('keeps every image a question or answer names, at any age, so the seed images survive a cleanup after db reset', async () => {
    const paths = await namedPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const named of paths) expect(await publicStatus(named)).toBe(200);

    okRun(cleanUp(10 * 365 * 24 * HOUR));

    for (const named of paths) expect(await publicStatus(named)).toBe(200);
  });

  it('never touches another bucket', async () => {
    const reply = await request(
      'POST',
      '/storage/v1/bucket',
      json({ id: OTHER_BUCKET, name: OTHER_BUCKET, public: false }),
    );
    if (reply.status !== 200 && !/exists/i.test(reply.body)) {
      throw new Error(`could not create ${OTHER_BUCKET}: ${reply.body}`);
    }
    const other = await upload(OTHER_BUCKET);

    okRun(cleanUp(48 * HOUR));

    expect(await downloadable(OTHER_BUCKET, other)).toBe(true);
  });

  it('succeeds and removes nothing when no unreferenced object is past the grace period', async () => {
    // Clears whatever orphans earlier runs left, so the bucket has none old
    // enough to go; then only an object inside the grace period is unreferenced.
    okRun(cleanUp(48 * HOUR));
    const fresh = await upload();

    okRun(cleanUp(12 * HOUR));
    okRun(cleanUp(0));

    expect(await publicStatus(fresh)).toBe(200);
  });

  // A Storage removal that fails must fail the run, or the scheduled job looks
  // green while the orphans stay public. A proxy in front of the stack (the
  // network boundary) passes everything through except the script's Storage
  // deletes, which it answers with an error, drops, or acknowledges for no
  // object at all.
  type Fault = 'error' | 'dropped' | 'nothing removed';

  async function withFaultyStorage<T>(fault: Fault, run: (url: string) => Promise<T>) {
    const target = new URL(stack.url);
    const proxy = http.createServer((incoming, outgoing) => {
      const isDelete =
        incoming.method === 'DELETE' && (incoming.url ?? '').startsWith('/storage/v1/object/');
      if (isDelete) {
        incoming.resume();
        if (fault === 'dropped') {
          incoming.socket.destroy();
          return;
        }
        if (fault === 'error') {
          outgoing.writeHead(500, { 'Content-Type': 'application/json' });
          outgoing.end(
            JSON.stringify({ statusCode: '500', error: 'internal', message: 'storage is down' }),
          );
          return;
        }
        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.end('[]');
        return;
      }
      const forwarded = http.request(
        {
          host: target.hostname,
          port: target.port,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, host: target.host },
        },
        (reply) => {
          outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(outgoing);
        },
      );
      forwarded.on('error', () => outgoing.destroy());
      incoming.pipe(forwarded);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('proxy has no port');
    try {
      return await run(`http://127.0.0.1:${address.port}`);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }

  it.each<Fault>(['error', 'dropped', 'nothing removed'])(
    'fails when the Storage removal goes wrong (%s), so the scheduled job does not look green',
    async (fault) => {
      const orphan = await upload();

      const run = await withFaultyStorage(fault, (url) =>
        cleanUpAsync(48 * HOUR, { SUPABASE_URL: url }),
      );

      expect(run.status).not.toBe(0);
      expect(await publicStatus(orphan)).toBe(200);
    },
  );

  it('refuses to run with the publishable key and removes nothing', async () => {
    const orphan = await upload();

    const run = cleanUp(48 * HOUR, { SUPABASE_SECRET_KEY: stack.publishableKey });

    expect(run.status).not.toBe(0);
    expect(await publicStatus(orphan)).toBe(200);
  });

  it.each(['SUPABASE_URL', 'SUPABASE_SECRET_KEY'])(
    'fails and removes nothing without %s',
    async (missing) => {
      const orphan = await upload();

      const run = cleanUp(48 * HOUR, { [missing]: undefined });

      expect(run.status).not.toBe(0);
      expect(run.output).toContain(missing);
      expect(await publicStatus(orphan)).toBe(200);
    },
  );
});
