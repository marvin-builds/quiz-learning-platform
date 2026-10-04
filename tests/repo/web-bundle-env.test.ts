/**
 * @jest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The web bundle is public: Expo inlines every `EXPO_PUBLIC_*` variable the
// code reads into it, and the deploy builds with the values CI assigns. So the
// only such variables may be the Supabase URL and the publishable key, `.env`
// (committed, read by every build) must hold no server key, and CI must feed
// no other secret into an `EXPO_PUBLIC_` variable. eas.json's own rules (no
// key at all, the hosted URL) are in android-build-config.test.ts.
//
// The checks are plain functions over text; the last block runs them on
// made-up violations, so they can't pass by matching nothing.

const ROOT = process.cwd();
const ALLOWED = ['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_SUPABASE_URL'];
const ALLOWED_SECRET = 'SUPABASE_PUBLISHABLE_KEY';

// `EXPO_PUBLIC_` followed by a name; a bare `EXPO_PUBLIC_*` in a comment is
// not a variable.
function expoPublicNames(text: string): string[] {
  return [...text.matchAll(/\bEXPO_PUBLIC_[A-Z0-9_]+/g)].map((match) => match[0]);
}

// The secrets a workflow assigns to an EXPO_PUBLIC_ variable, as YAML
// (`EXPO_PUBLIC_X: ${{ secrets.Y }}`) or in a shell line (`EXPO_PUBLIC_X=...`).
function secretsAssignedToExpoPublic(workflow: string): string[] {
  return [...workflow.matchAll(/\bEXPO_PUBLIC_[A-Z0-9_]+\s*[:=]\s*([^\n]*)/g)].flatMap(
    (assignment) => [...assignment[1].matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  );
}

// The `role` claims of the JWTs in a text (Supabase's legacy anon and
// service_role keys are JWTs).
function jwtRoles(text: string): unknown[] {
  return [...text.matchAll(/\beyJ[\w-]+\.([\w-]+)\.[\w-]*/g)].map((match) => {
    try {
      return (JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as { role?: unknown })
        .role;
    } catch {
      return undefined;
    }
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : filesUnder(full);
    return /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [] : [full];
  });
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function workflows(): string[] {
  const dir = path.join(ROOT, '.github', 'workflows');
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => path.join(dir, name));
}

// Everything that can name an EXPO_PUBLIC_ variable for a build: the app code
// (tests excluded), the app config, `.env`, the CI workflows and eas.json.
function buildInputs(): string[] {
  const appConfigs = readdirSync(ROOT)
    .filter((name) => /^app\.(json|config\.[cm]?[jt]s)$/.test(name))
    .map((name) => path.join(ROOT, name));
  return [
    ...filesUnder(path.join(ROOT, 'src')),
    ...appConfigs,
    path.join(ROOT, '.env'),
    ...workflows(),
    path.join(ROOT, 'eas.json'),
  ].filter((file) => existsSync(file));
}

describe('the web bundle environment', () => {
  it('names no EXPO_PUBLIC_ variable other than the Supabase URL and publishable key', () => {
    const names = new Set(buildInputs().flatMap((file) => expoPublicNames(read(file))));

    expect([...names].sort()).toEqual(ALLOWED);
  });

  it('reads both allowed variables in the app code', () => {
    const names = new Set(
      filesUnder(path.join(ROOT, 'src')).flatMap((file) => expoPublicNames(read(file))),
    );

    expect([...names].sort()).toEqual(ALLOWED);
  });

  it('keeps no secret key in .env', () => {
    const env = read(path.join(ROOT, '.env'));

    expect(env).not.toContain('sb_secret_');
    expect(jwtRoles(env)).not.toContain('service_role');
  });

  it('assigns no secret other than the publishable key to an EXPO_PUBLIC_ variable in CI', () => {
    const secrets = workflows().flatMap((file) => secretsAssignedToExpoPublic(read(file)));

    // Sanity: the deploy does assign the key, so the parser sees assignments.
    expect(secrets).toContain(ALLOWED_SECRET);
    expect(new Set(secrets)).toEqual(new Set([ALLOWED_SECRET]));
  });
});

describe('the checks catch violations', () => {
  const jwt = (payload: object) =>
    [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'signature',
    ].join('.');

  it('finds an extra EXPO_PUBLIC_ variable in code, but not the bare prefix of a comment', () => {
    expect(
      expoPublicNames(
        '// Expo inlines EXPO_PUBLIC_* at build time\nconst key = process.env.EXPO_PUBLIC_SUPABASE_SECRET_KEY;',
      ),
    ).toEqual(['EXPO_PUBLIC_SUPABASE_SECRET_KEY']);
  });

  it('finds a service_role JWT, and not the anon one', () => {
    expect(
      jwtRoles(`KEY=${jwt({ role: 'anon' })}\nOTHER=${jwt({ role: 'service_role' })}`),
    ).toEqual(['anon', 'service_role']);
  });

  it('finds another secret assigned to an EXPO_PUBLIC_ variable, in YAML and in shell', () => {
    const workflow = [
      '    env:',
      '      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ secrets.SUPABASE_PUBLISHABLE_KEY }}',
      '      EXPO_PUBLIC_SUPABASE_KEY: ${{ secrets.SUPABASE_SECRET_KEY }}',
      '      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}',
      '      run: EXPO_PUBLIC_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }} npx expo export',
    ].join('\n');

    expect(secretsAssignedToExpoPublic(workflow)).toEqual([
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_SECRET_KEY',
      'CLOUDFLARE_API_TOKEN',
    ]);
  });
});
