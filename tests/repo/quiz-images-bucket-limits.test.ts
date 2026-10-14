/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// #124 (S6): the migration that creates quiz-images inserts it with
// `on conflict do nothing`, so a bucket that already existed on the hosted
// project kept its own limits. A later migration updates the existing row to
// the values of supabase/config.toml: public, 5 MiB, png/jpeg/webp. That
// migration is new; the insert migration has been applied on the hosted
// project and `db push` never runs it again. Locally, `supabase start` and
// `db reset` set the limits from config.toml anyway, so only this test and
// the hosted CI check (ci-bucket-check.test.ts) see whether the update is
// there.

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const INSERT_MIGRATION = '20261003215819_create_quiz_images_bucket.sql';

// The key/value lines of one `[table]` of config.toml (strings, booleans,
// numbers and arrays of strings).
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

function bytes(size: unknown): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB)?$/i.exec(String(size));
  if (!match) throw new Error(`can't read the size "${String(size)}"`);
  const factor: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
  };
  return Number(match[1]) * factor[(match[2] ?? 'B').toLowerCase()];
}

// Items separated by commas outside brackets, parentheses and quotes.
function splitTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    if (!quoted && (char === '(' || char === '[')) depth += 1;
    if (!quoted && (char === ')' || char === ']')) depth -= 1;
    if (char === ',' && depth === 0 && !quoted) {
      items.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current.trim());
  return items.filter((item) => item !== '');
}

const stripComments = (sql: string) => sql.replace(/--.*$/gm, '');
const unquote = (value: string) => /^'(.*)'(::\w+)?$/s.exec(value.trim())?.[1] ?? value.trim();

function sqlStringArray(value: string): string[] {
  const array = /^array\s*\[([\s\S]*)\](::\w+(\[\])?)?$/i.exec(value.trim());
  if (array) return splitTopLevel(array[1]).map(unquote);
  const literal = /^'\{(.*)\}'(::\w+(\[\])?)?$/s.exec(value.trim());
  if (literal) return literal[1].split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
  throw new Error(`can't read the array ${value}`);
}

type BucketUpdate = { file: string; set: Record<string, string> };

// `update storage.buckets set ... where id = 'quiz-images'` statements, in
// migration order, with the SQL text of each assigned value.
function bucketUpdates(): BucketUpdate[] {
  const updates: BucketUpdate[] = [];
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = stripComments(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    const pattern = /update\s+storage\.buckets\s+set\s+([\s\S]*?)\s+where\s+([\s\S]*?);/gi;
    for (const match of sql.matchAll(pattern)) {
      if (!/\bid\s*=\s*'quiz-images'/i.test(match[2])) continue;
      const set: Record<string, string> = {};
      for (const assignment of splitTopLevel(match[1])) {
        const parts = /^(\w+)\s*=\s*([\s\S]+)$/.exec(assignment);
        if (parts) set[parts[1].toLowerCase()] = parts[2].trim();
      }
      updates.push({ file, set });
    }
  }
  return updates;
}

function expected() {
  const table = tomlTable(
    readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8'),
    'storage.buckets.quiz-images',
  );
  return {
    public: table.public as boolean,
    fileSizeLimit: bytes(table.file_size_limit),
    mimeTypes: [...(table.allowed_mime_types as string[])].sort(),
  };
}

// The newest migration that updates quiz-images, which must come after the
// insert, so it also runs on the hosted project.
function latestUpdate(): BucketUpdate {
  const updates = bucketUpdates().filter((update) => update.file > INSERT_MIGRATION);
  expect(updates.map((update) => update.file)).not.toEqual([]);
  return updates[updates.length - 1];
}

describe('a migration after the insert enforces the quiz-images limits on an existing bucket', () => {
  it('sets it public, like config.toml', () => {
    expect(latestUpdate().set.public?.toLowerCase()).toBe(String(expected().public));
  });

  it('sets the size limit of config.toml', () => {
    const value = latestUpdate().set.file_size_limit?.replace(/::\w+$/, '');
    expect(Number(value)).toBe(expected().fileSizeLimit);
  });

  it('sets exactly the file types of config.toml', () => {
    const value = latestUpdate().set.allowed_mime_types ?? '';
    expect(sqlStringArray(value).sort()).toEqual(expected().mimeTypes);
  });

  it('is a new migration, not an edit of the applied insert migration', () => {
    expect(latestUpdate().file).not.toBe(INSERT_MIGRATION);
    expect(stripComments(readFileSync(path.join(MIGRATIONS, INSERT_MIGRATION), 'utf8'))).toMatch(
      /on\s+conflict\s*\(id\)\s*do\s+nothing/i,
    );
  });
});
