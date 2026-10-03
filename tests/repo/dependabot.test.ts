/**
 * @jest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG = path.join(process.cwd(), '.github', 'dependabot.yml');

type UpdateEntry = { ecosystem: string; body: string };

function readConfig(): string {
  if (!existsSync(CONFIG)) {
    throw new Error(`${path.relative(process.cwd(), CONFIG)} does not exist`);
  }
  return readFileSync(CONFIG, 'utf8');
}

function unquote(value: string): string {
  return value
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

// Splits the `updates:` list into its entries with plain text checks, so no
// YAML parser is needed: each entry starts with `- package-ecosystem: <name>`
// and ends at the next entry or the next top-level key.
function updateEntries(config: string): UpdateEntry[] {
  const entries: UpdateEntry[] = [];
  let current: UpdateEntry | undefined;
  for (const line of config.split(/\r?\n/)) {
    const start = /^\s*-\s+package-ecosystem:\s*(.+)$/.exec(line);
    if (start) {
      current = { ecosystem: unquote(start[1]), body: `${line}\n` };
      entries.push(current);
    } else if (current && /^\S/.test(line)) {
      current = undefined;
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return entries;
}

function field(entry: UpdateEntry, key: string): string | undefined {
  const match = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`, 'm').exec(entry.body);
  return match ? unquote(match[1]) : undefined;
}

function rootEntryFor(ecosystem: string): UpdateEntry {
  const matches = updateEntries(readConfig()).filter(
    (entry) => entry.ecosystem === ecosystem && field(entry, 'directory') === '/',
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('Dependabot configuration', () => {
  it('uses version 2 of the config format', () => {
    expect(readConfig()).toMatch(/^version:\s*["']?2["']?\s*$/m);
  });

  it('keeps GitHub Actions up to date on a schedule for the repository root', () => {
    const actions = rootEntryFor('github-actions');

    expect(actions.body).toMatch(/^\s*schedule:\s*$/m);
    expect(field(actions, 'interval')).toMatch(/^(daily|weekly|monthly)$/);
  });

  it('opens no npm version-update PRs, leaving only security updates', () => {
    const npm = rootEntryFor('npm');

    expect(field(npm, 'open-pull-requests-limit')).toBe('0');
  });
});
