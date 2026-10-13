/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Auth hardening from the phase 2 security review (#37, findings S2 and S3).
// supabase/config.toml is the local stack's config, and CI pushes it to the
// hosted project with `supabase config push`, merging [remotes.production.*]
// over the local values.
//
// - secure_password_change: a password change needs a recent sign-in, for
//   the local stack and the hosted project alike ([auth.email]).
// - Password rules: the hosted project requires at least 12 characters with
//   lower- and upper-case letters and digits ([remotes.production.auth]).
//   The local stack keeps the weak defaults, so the e2e passwords (e.g.
//   'learner-password') and the seed admin keep working.

const CONFIG = path.join(process.cwd(), 'supabase', 'config.toml');

// The key/value lines of one `[table]` of a TOML file, up to the next table.
// Values are the few literal kinds config.toml uses: strings, booleans,
// numbers and arrays of strings.
function tomlTable(text: string, table: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) throw new Error(`config.toml has no [${table}] table`);
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

describe('auth hardening in supabase/config.toml', () => {
  it('requires a recent sign-in to change a password ([auth.email] secure_password_change)', () => {
    expect(tomlTable(config, 'auth.email').secure_password_change).toBe(true);
  });

  it('does not turn secure_password_change off again for the hosted project', () => {
    expect(tomlTable(config, 'remotes.production.auth.email')).not.toHaveProperty(
      'secure_password_change',
      false,
    );
  });

  it('requires at least 12 characters for hosted passwords', () => {
    const minimum = tomlTable(config, 'remotes.production.auth').minimum_password_length;
    expect(typeof minimum).toBe('number');
    expect(minimum as number).toBeGreaterThanOrEqual(12);
  });

  it('requires lower- and upper-case letters and digits in hosted passwords', () => {
    expect(tomlTable(config, 'remotes.production.auth').password_requirements).toBe(
      'lower_upper_letters_digits',
    );
  });

  it('keeps the local password rules weak, so the e2e and seed passwords keep working', () => {
    const local = tomlTable(config, 'auth');
    expect(local.minimum_password_length).toBe(6);
    expect(local.password_requirements).toBe('');
  });
});
