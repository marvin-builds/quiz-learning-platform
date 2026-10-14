/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCsp, parseHeadersFile, parsePermissionsPolicy } from '../../e2e/pages-headers';

// The security headers of the web app (#123). Cloudflare Pages reads them from
// `_headers` in the deployed directory. The Supabase host differs between the
// local stack and the hosted project, so `scripts/security-headers.mjs` writes
// `<dir>/_headers` (default `dist`) after the export, from the same
// EXPO_PUBLIC_SUPABASE_URL the bundle was built with: the process environment
// first, then the env files in the order Expo reads them for `expo export`
// (NODE_ENV=production): `.env.production.local`, `.env.local`,
// `.env.production`, `.env`. Every case runs the script in a sandbox of its
// own with its own env files.

jest.setTimeout(60_000);

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'security-headers.mjs');
const LOCAL = 'http://127.0.0.1:54321';
const HOSTED = 'https://kiywcqhicsesgknlwjyy.supabase.co';

type Env = Record<string, string | undefined>;
type Run = { status: number | null; stdout: string; stderr: string };

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'security-headers-')));
  readonly dist = path.join(this.root, 'dist');

  constructor(files: Record<string, string> = {}) {
    fs.mkdirSync(this.dist);
    fs.writeFileSync(path.join(this.dist, 'index.html'), '<!DOCTYPE html><html></html>\n');
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(this.root, name), content);
    }
  }

  // Runs the generator the way the export step does: NODE_ENV=production (the
  // mode `expo export` uses, not Jest's `test`), no EXPO_PUBLIC_ variable from
  // the test's own environment, plus `env`. A variable set to undefined in
  // `env` is removed from the child's environment.
  run(env: Env = {}, args: string[] = []): Run {
    const merged: Env = { ...process.env, NODE_ENV: 'production', ...env };
    const childEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(merged)) {
      if (value !== undefined && !(name.startsWith('EXPO_PUBLIC_') && !(name in env))) {
        childEnv[name] = value;
      }
    }
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: this.root,
      env: childEnv as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  get headersFile(): string {
    return path.join(this.dist, '_headers');
  }

  // The headers of the rule for every path, after a successful run.
  headers(env: Env = {}): Map<string, string> {
    const run = this.run(env);
    if (run.status !== 0) {
      throw new Error(`security-headers.mjs exited with ${run.status}: ${run.stderr}`);
    }
    if (!fs.existsSync(this.headersFile)) throw new Error('dist/_headers was not written');
    const rule = parseHeadersFile(fs.readFileSync(this.headersFile, 'utf8')).get('/*');
    if (!rule) throw new Error('dist/_headers has no rule for /*');
    return rule;
  }

  csp(env: Env = {}): Map<string, string[]> {
    const policy = this.headers(env).get('content-security-policy');
    if (!policy) throw new Error('the /* rule has no Content-Security-Policy');
    return parseCsp(policy);
  }

  remove() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const sorted = (tokens: readonly string[] | undefined) => [...(tokens ?? [])].sort();

let sandboxes: Sandbox[] = [];
function sandbox(files: Record<string, string> = {}): Sandbox {
  const created = new Sandbox(files);
  sandboxes.push(created);
  return created;
}

afterEach(() => {
  for (const created of sandboxes) created.remove();
  sandboxes = [];
});

describe('scripts/security-headers.mjs writes dist/_headers', () => {
  it('writes the headers into dist/ under a rule for every path (/*)', () => {
    const box = sandbox({ '.env': `EXPO_PUBLIC_SUPABASE_URL=${LOCAL}\n` });

    expect(box.run().status).toBe(0);
    expect(fs.existsSync(box.headersFile)).toBe(true);
    const rules = parseHeadersFile(fs.readFileSync(box.headersFile, 'utf8'));
    expect(rules.has('/*')).toBe(true);
  });

  it('writes into the directory given as its argument', () => {
    const box = sandbox();
    const other = path.join(box.root, 'web-build');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'index.html'), '<!DOCTYPE html><html></html>\n');

    expect(box.run({ EXPO_PUBLIC_SUPABASE_URL: LOCAL }, ['web-build']).status).toBe(0);
    expect(fs.existsSync(path.join(other, '_headers'))).toBe(true);
  });
});

describe('the Content-Security-Policy', () => {
  it("allows only the app's own origin by default: default-src 'self'", () => {
    const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: LOCAL });

    expect(csp.get('default-src')).toEqual(["'self'"]);
  });

  it.each([
    ['the local stack', LOCAL, 'ws://127.0.0.1:54321'],
    ['the hosted project', HOSTED, 'wss://kiywcqhicsesgknlwjyy.supabase.co'],
  ])(
    'lets the app connect to %s, its Realtime websocket and blob: URLs, nothing else (connect-src)',
    (_label, url, websocket) => {
      const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: url });
      const tokens = csp.get('connect-src') ?? [];

      // blob: because the image upload reads the picked file with
      // fetch(file.uri) (src/lib/images.ts), and on the web that uri is a
      // blob: URL (src/lib/pick-image.web.ts).
      expect(tokens).toEqual(expect.arrayContaining([url, websocket, 'blob:']));
      // 'self' may stay; any other source would widen the policy.
      expect(
        tokens.filter((token) => ![url, websocket, 'blob:', "'self'"].includes(token)),
      ).toEqual([]);
    },
  );

  it('names only the origin of a Supabase URL with a path or a trailing slash', () => {
    const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: `${HOSTED}/` });

    expect(sorted(csp.get('connect-src')).filter((token) => token !== "'self'")).toEqual(
      sorted([HOSTED, 'wss://kiywcqhicsesgknlwjyy.supabase.co', 'blob:']),
    );
  });

  it.each([
    ['the local stack', LOCAL],
    ['the hosted project', HOSTED],
  ])(
    "allows images from 'self', data:, blob: and the Storage host of %s, nothing else (img-src)",
    (_label, url) => {
      const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: url });

      expect(sorted(csp.get('img-src'))).toEqual(sorted(["'self'", 'data:', 'blob:', url]));
    },
  );

  it("forbids framing the app: frame-ancestors 'none'", () => {
    expect(sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: LOCAL }).get('frame-ancestors')).toEqual([
      "'none'",
    ]);
  });

  it("forbids plugins: object-src 'none'", () => {
    expect(sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: LOCAL }).get('object-src')).toEqual([
      "'none'",
    ]);
  });

  it("pins the base URL to the app: base-uri 'self'", () => {
    expect(sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: LOCAL }).get('base-uri')).toEqual(["'self'"]);
  });

  // Without a script-src, default-src 'self' applies. Inline scripts of the
  // export may only be allowed by their hash.
  it("runs only the app's own scripts: no inline or eval, at most hashes of inline scripts", () => {
    const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: LOCAL });
    const scripts = csp.get('script-src') ?? csp.get('default-src') ?? [];

    expect(scripts).toContain("'self'");
    expect(
      scripts.filter(
        (token) => token !== "'self'" && !/^'sha(256|384|512)-[A-Za-z0-9+/=]+'$/.test(token),
      ),
    ).toEqual([]);
  });

  // react-native-web inserts <style> elements at run time.
  it("allows the app's own and inline styles, no other host (style-src)", () => {
    const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: LOCAL });
    const styles = csp.get('style-src') ?? csp.get('default-src') ?? [];

    expect(styles).toContain("'self'");
    expect(styles.filter((token) => !["'self'", "'unsafe-inline'"].includes(token))).toEqual([]);
  });

  it("widens no directive with a wildcard, 'unsafe-eval', or 'unsafe-inline' outside style-src", () => {
    const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: HOSTED });

    const widening = [...csp].flatMap(([directive, tokens]) =>
      tokens
        .filter(
          (token) =>
            token.includes('*') ||
            token === "'unsafe-eval'" ||
            (token === "'unsafe-inline'" && directive !== 'style-src'),
        )
        .map((token) => `${directive} ${token}`),
    );

    expect(csp.size).toBeGreaterThan(0);
    expect(widening).toEqual([]);
  });

  it('names no host other than the Supabase one', () => {
    const csp = sandbox().csp({ EXPO_PUBLIC_SUPABASE_URL: HOSTED });
    const hosts = [...csp.values()]
      .flat()
      .filter((token) => /^[a-z][a-z0-9+.-]*:\/\//i.test(token))
      .map((token) => new URL(token).host);

    expect(new Set(hosts)).toEqual(new Set(['kiywcqhicsesgknlwjyy.supabase.co']));
  });
});

describe('the other security headers', () => {
  it('turns off MIME sniffing: X-Content-Type-Options nosniff', () => {
    const headers = sandbox().headers({ EXPO_PUBLIC_SUPABASE_URL: LOCAL });

    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sends the referrer origin only to other sites: strict-origin-when-cross-origin', () => {
    const headers = sandbox().headers({ EXPO_PUBLIC_SUPABASE_URL: LOCAL });

    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('forbids framing in browsers without frame-ancestors too: X-Frame-Options DENY', () => {
    const headers = sandbox().headers({ EXPO_PUBLIC_SUPABASE_URL: LOCAL });

    expect(headers.get('x-frame-options')).toBe('DENY');
  });

  // The web image picker is a plain file input, so the app needs none of them.
  it.each([
    'camera',
    'microphone',
    'geolocation',
    'payment',
    'usb',
    'serial',
    'hid',
    'midi',
    'accelerometer',
    'gyroscope',
    'magnetometer',
  ])('turns off %s in the Permissions-Policy', (feature) => {
    const policy = sandbox().headers({ EXPO_PUBLIC_SUPABASE_URL: LOCAL }).get('permissions-policy');

    expect(policy).toEqual(expect.any(String));
    expect(parsePermissionsPolicy(policy ?? '').get(feature)).toBe('()');
  });

  it('turns every feature it names off, none on', () => {
    const policy = sandbox().headers({ EXPO_PUBLIC_SUPABASE_URL: LOCAL }).get('permissions-policy');
    const features = parsePermissionsPolicy(policy ?? '');

    expect(features.size).toBeGreaterThan(0);
    expect([...features].filter(([, allowlist]) => allowlist !== '()')).toEqual([]);
  });
});

describe('where the Supabase URL comes from', () => {
  const urlIn = (csp: Map<string, string[]>) =>
    (csp.get('connect-src') ?? []).filter((token) => /^https?:/.test(token));

  it('reads .env when nothing else sets it', () => {
    const box = sandbox({ '.env': `EXPO_PUBLIC_SUPABASE_URL=${LOCAL}\n` });

    expect(urlIn(box.csp())).toEqual([LOCAL]);
  });

  it('prefers .env.local (a worktree’s own stack) over .env', () => {
    const box = sandbox({
      '.env': `EXPO_PUBLIC_SUPABASE_URL=${LOCAL}\n`,
      '.env.local': 'QUIZ_E2E_PORT=4373\nEXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54521\n',
    });

    expect(urlIn(box.csp())).toEqual(['http://127.0.0.1:54521']);
  });

  it('prefers .env.production (the mode expo export builds in) over .env', () => {
    const box = sandbox({
      '.env': `EXPO_PUBLIC_SUPABASE_URL=${LOCAL}\n`,
      '.env.production': `EXPO_PUBLIC_SUPABASE_URL=${HOSTED}\n`,
    });

    expect(urlIn(box.csp())).toEqual([HOSTED]);
  });

  // `npm run export:web` runs the generator with NODE_ENV unset; it must still
  // read the files of the production mode, as expo export does.
  it('prefers .env.production over .env without NODE_ENV too', () => {
    const box = sandbox({
      '.env': `EXPO_PUBLIC_SUPABASE_URL=${LOCAL}\n`,
      '.env.production': `EXPO_PUBLIC_SUPABASE_URL=${HOSTED}\n`,
    });

    expect(urlIn(box.csp({ NODE_ENV: undefined }))).toEqual([HOSTED]);
  });

  it('prefers the process environment (the deploy job) over both files', () => {
    const box = sandbox({
      '.env': `EXPO_PUBLIC_SUPABASE_URL=${LOCAL}\n`,
      '.env.local': 'EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54521\n',
    });

    expect(urlIn(box.csp({ EXPO_PUBLIC_SUPABASE_URL: HOSTED }))).toEqual([HOSTED]);
  });

  it.each([
    ['is set nowhere', {}, {}],
    ['is empty', { '.env': 'EXPO_PUBLIC_SUPABASE_URL=\n' }, {}],
    ['is no URL', {}, { EXPO_PUBLIC_SUPABASE_URL: 'not a url' }],
    ['is not http(s)', {}, { EXPO_PUBLIC_SUPABASE_URL: 'ftp://example.com' }],
  ])(
    'fails naming EXPO_PUBLIC_SUPABASE_URL, and writes no _headers, when the URL %s',
    (_label, files: Record<string, string>, env: Record<string, string>) => {
      const box = sandbox(files);
      const run = box.run(env);

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('EXPO_PUBLIC_SUPABASE_URL');
      expect(fs.existsSync(box.headersFile)).toBe(false);
    },
  );
});
