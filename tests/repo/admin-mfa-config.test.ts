/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Admin rights need a second factor (#122). TOTP must work on the local
// stack too, so the local stack, CI and the e2e tests take the same MFA path
// as the hosted project: [auth.mfa.totp] turns enroll and verify on, and
// [remotes.production.auth.mfa.totp] must not turn them off again. Phone and
// WebAuthn MFA stay off; the app offers only TOTP.

const CONFIG = path.join(process.cwd(), 'supabase', 'config.toml');

// The key/value lines of one `[table]` of a TOML file, up to the next table,
// or null when the table isn't there. Values are the literal kinds
// config.toml uses: strings, booleans, numbers and arrays of strings.
function tomlTable(text: string, table: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) return null;
  const entries: Record<string, unknown> = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([\w-]+)\s*=\s*(.+?)\s*(#.*)?$/.exec(trimmed);
    if (!match) throw new Error(`can't parse the config.toml line "${trimmed}"`);
    entries[match[1]] = JSON.parse(match[2]);
  }
  return entries;
}

const config = readFileSync(CONFIG, 'utf8');

describe('TOTP for admins in supabase/config.toml', () => {
  // One behavior: the local stack offers TOTP, and only TOTP, like the hosted
  // project; the hosted overrides don't turn TOTP off or another factor on.
  it('turns TOTP enrollment and verification on for the local stack, and no other factor', () => {
    expect(tomlTable(config, 'auth.mfa.totp')).toMatchObject({
      enroll_enabled: true,
      verify_enabled: true,
    });
    const hostedTotp = tomlTable(config, 'remotes.production.auth.mfa.totp') ?? {};
    expect(hostedTotp).not.toHaveProperty('enroll_enabled', false);
    expect(hostedTotp).not.toHaveProperty('verify_enabled', false);

    expect(tomlTable(config, 'auth.mfa.phone')).toMatchObject({
      enroll_enabled: false,
      verify_enabled: false,
    });
    for (const table of [
      'remotes.production.auth.mfa.phone',
      'auth.mfa.web_authn',
      'remotes.production.auth.mfa.web_authn',
    ]) {
      const other = tomlTable(config, table) ?? {};
      expect(other).not.toHaveProperty('enroll_enabled', true);
      expect(other).not.toHaveProperty('verify_enabled', true);
    }
  });
});

// The seed admin's TOTP factor (supabase/seed.sql) and the e2e helper that
// computes its codes (e2e/admin-auth.ts) must use the same secret.
// Re-spec: the same holds for the dedicated e2e admins (TEST_ADMINS and
// API_ADMIN in the helper), each with its own secret, which seed.sql seeds
// for that admin's email.
describe("the seed admin's TOTP secret", () => {
  const helper = readFileSync(path.join(process.cwd(), 'e2e', 'admin-auth.ts'), 'utf8');
  const seed = readFileSync(path.join(process.cwd(), 'supabase', 'seed.sql'), 'utf8');

  it('seed.sql seeds the secret the e2e helper computes the codes from', () => {
    const secret = /totpSecret:\s*'([A-Z2-7]+)'/.exec(helper)?.[1];
    expect(secret).toBeDefined();
    expect(seed).toContain(secret!);
  });

  it("seed.sql seeds every dedicated e2e admin's secret, each its own", () => {
    const admins = [
      ...helper.matchAll(/testAdmin\(\s*'([a-z0-9-]+)',\s*'([A-Z2-7]{32})',?\s*\)/g),
    ].map((match) => ({ email: `${match[1]}@example.com`, secret: match[2]! }));
    expect(admins.map(({ email }) => email).sort()).toEqual(
      [
        'admin-mfa-phone@example.com',
        'admin-mfa-desktop@example.com',
        'admin-sign-in-phone@example.com',
        'admin-sign-in-desktop@example.com',
        'admin-nav-phone@example.com',
        'admin-nav-desktop@example.com',
        'admin-api-aal1@example.com',
      ].sort(),
    );
    const seedAdminSecret = /totpSecret:\s*'([A-Z2-7]+)'/.exec(helper)?.[1];
    const secrets = admins.map(({ secret }) => secret);
    expect(new Set([...secrets, seedAdminSecret]).size).toBe(secrets.length + 1);
    for (const { email, secret } of admins) {
      expect(seed).toContain(email);
      expect(seed).toContain(secret);
    }
  });
});
