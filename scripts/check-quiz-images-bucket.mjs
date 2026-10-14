// Compares the quiz-images bucket with `[storage.buckets.quiz-images]` in
// supabase/config.toml (#124, S7). CI runs it after the hosted migration:
//
//   node scripts/check-quiz-images-bucket.mjs [rows.json]
//
// reads the storage.buckets rows as a JSON array from the file or stdin and
// exits 0 only when quiz-images is there and its public flag, size limit and
// set of file types match. A missing or null field never matches: null means
// "no limit". No dependencies, so CI can run it without `npm ci`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUCKET = 'quiz-images';
const CONFIG = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'supabase',
  'config.toml',
);

const SIZE_FACTORS = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
};

class CheckError extends Error {}

// The key/value lines of one `[table]` of config.toml (strings, booleans,
// numbers and arrays of strings, each on one line).
function tomlTable(text, table) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) throw new CheckError(`${CONFIG} has no [${table}] table`);
  const entries = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([\w-]+)\s*=\s*(.+?)\s*(#.*)?$/.exec(trimmed);
    if (!match) throw new CheckError(`can't parse the config.toml line "${trimmed}"`);
    entries[match[1]] = JSON.parse(match[2]);
  }
  return entries;
}

function bytes(size) {
  const match = /^(\d+)\s*(B|KB|KiB|MB|MiB|GB|GiB)?$/i.exec(String(size));
  if (!match) throw new CheckError(`can't read the size "${String(size)}"`);
  return Number(match[1]) * SIZE_FACTORS[(match[2] ?? 'B').toLowerCase()];
}

function expected() {
  const table = tomlTable(readFileSync(CONFIG, 'utf8'), `storage.buckets.${BUCKET}`);
  return {
    public: table.public,
    file_size_limit: bytes(table.file_size_limit),
    allowed_mime_types: [...table.allowed_mime_types].sort(),
  };
}

function readRows(input) {
  let rows;
  try {
    rows = JSON.parse(input);
  } catch {
    throw new CheckError(`the input is not JSON: ${input.slice(0, 200)}`);
  }
  if (!Array.isArray(rows)) {
    throw new CheckError(`the input is not a list of bucket rows: ${input.slice(0, 200)}`);
  }
  return rows;
}

// The differences between the bucket row and the expected values.
function differences(row, want) {
  const found = [];
  if (row.public !== want.public) {
    found.push(`public is ${JSON.stringify(row.public)}, expected ${want.public}`);
  }
  const size = row.file_size_limit;
  const sizeMatches =
    (typeof size === 'number' || (typeof size === 'string' && /^\d+$/.test(size))) &&
    Number(size) === want.file_size_limit;
  if (!sizeMatches) {
    found.push(`file_size_limit is ${JSON.stringify(size)}, expected ${want.file_size_limit}`);
  }
  const types = row.allowed_mime_types;
  const typesMatch =
    Array.isArray(types) &&
    JSON.stringify([...types].sort()) === JSON.stringify(want.allowed_mime_types);
  if (!typesMatch) {
    found.push(
      `allowed_mime_types is ${JSON.stringify(types)}, expected ${JSON.stringify(want.allowed_mime_types)}`,
    );
  }
  return found;
}

function main() {
  const file = process.argv[2];
  const input = readFileSync(file ?? 0, 'utf8');
  const want = expected();
  const row = readRows(input).find((candidate) => candidate?.id === BUCKET);
  if (!row) throw new CheckError(`there is no ${BUCKET} bucket`);
  const found = differences(row, want);
  if (found.length > 0) {
    throw new CheckError(
      `the ${BUCKET} bucket differs from supabase/config.toml:\n  ${found.join('\n  ')}`,
    );
  }
  console.log(`The ${BUCKET} bucket matches supabase/config.toml.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
