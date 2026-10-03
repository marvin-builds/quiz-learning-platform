/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The quiz-images bucket is declared twice: in supabase/config.toml for the
// local stack (with the seed images) and in a migration that creates it on
// the hosted project, where `supabase config push` doesn't. Both must agree:
// public, 5 MiB, png/jpeg/webp. The migration may run on a project that
// already has the bucket, so its insert must be idempotent.

const ROOT = process.cwd();
const BUCKET = 'quiz-images';
const FIVE_MIB = 5 * 1024 * 1024;
const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

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

// "5MiB", "512KB", ... in bytes, the way the Supabase CLI reads sizes.
function bytes(size: unknown): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB)?$/i.exec(String(size));
  if (!match) throw new Error(`can't read the size "${String(size)}"`);
  const unit = (match[2] ?? 'B').toLowerCase();
  const factor: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
  };
  return Number(match[1]) * factor[unit];
}

// Items separated by commas outside parentheses, brackets and quotes.
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

// The text of the parenthesised group starting at `open` (an index of "(").
function group(text: string, open: number): string {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced parentheses');
}

const stripComments = (sql: string) => sql.replace(/--.*$/gm, '');

type BucketInsert = { file: string; statement: string; values: Record<string, string> };

// The migration statements that insert the quiz-images bucket, with the
// inserted value of each column as SQL text.
function bucketInserts(): BucketInsert[] {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const inserts: BucketInsert[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
    const sql = stripComments(readFileSync(path.join(dir, file), 'utf8'));
    for (const match of sql.matchAll(/insert\s+into\s+storage\.buckets\s*\(/gi)) {
      const columnsOpen = match.index + match[0].length - 1;
      const columns = splitTopLevel(group(sql, columnsOpen)).map((c) => c.toLowerCase());
      const rest = sql.slice(columnsOpen);
      const valuesMatch = /\)\s*values\s*\(/i.exec(rest);
      if (!valuesMatch) continue;
      const valuesOpen = columnsOpen + valuesMatch.index + valuesMatch[0].length - 1;
      const values = splitTopLevel(group(sql, valuesOpen));
      const end = sql.indexOf(';', valuesOpen);
      const statement = sql.slice(match.index, end === -1 ? undefined : end);
      const row = Object.fromEntries(columns.map((column, i) => [column, values[i] ?? '']));
      if (row.id?.replace(/'/g, '') === BUCKET) inserts.push({ file, statement, values: row });
    }
  }
  return inserts;
}

const sqlString = (value: string) => /^'(.*)'(::\w+)?$/s.exec(value.trim())?.[1];

function sqlStringArray(value: string): string[] {
  const array = /^array\s*\[([\s\S]*)\](::\w+(\[\])?)?$/i.exec(value.trim());
  if (array) return splitTopLevel(array[1]).map((item) => sqlString(item) ?? item);
  const literal = /^'\{(.*)\}'(::\w+(\[\])?)?$/s.exec(value.trim());
  if (literal) return literal[1].split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
  throw new Error(`can't read the array ${value}`);
}

describe('the quiz-images bucket', () => {
  describe('in supabase/config.toml', () => {
    const table = () =>
      tomlTable(
        readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8'),
        `storage.buckets.${BUCKET}`,
      );

    it('is public', () => {
      expect(table().public).toBe(true);
    });

    it('accepts files up to 5 MiB', () => {
      expect(bytes(table().file_size_limit)).toBe(FIVE_MIB);
    });

    it('accepts exactly png, jpeg and webp', () => {
      expect([...(table().allowed_mime_types as string[])].sort()).toEqual(MIME_TYPES);
    });

    it('takes its seed images from supabase/seed-images', () => {
      expect(table().objects_path).toBe('./seed-images');
    });
  });

  describe('in a migration', () => {
    const insert = () => {
      const inserts = bucketInserts();
      expect(inserts.map((found) => found.file)).toHaveLength(1);
      return inserts[0];
    };

    it('is created public', () => {
      expect(insert().values.public?.toLowerCase()).toBe('true');
    });

    it('is created with a limit of 5 MiB', () => {
      expect(Number(insert().values.file_size_limit?.replace(/::\w+$/, ''))).toBe(FIVE_MIB);
    });

    it('is created for exactly png, jpeg and webp', () => {
      expect(sqlStringArray(insert().values.allowed_mime_types ?? '').sort()).toEqual(MIME_TYPES);
    });

    it('is created idempotently, so the migration also runs where the bucket exists', () => {
      expect(insert().statement).toMatch(/\bon\s+conflict\b/i);
    });
  });
});
