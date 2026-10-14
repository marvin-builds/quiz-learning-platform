/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #124: the docs said only that a migration creates quiz-images on the
// hosted project and that config.toml and the migration must agree. They now
// also say that a later migration enforces the limits on an existing bucket
// and that CI compares the hosted bucket with the expected values after
// every migration. The comment of the migration that inserts the bucket
// (`on conflict (id) do nothing`, so it never changes an existing bucket)
// points to that later migration too. Only keywords are checked; the
// reviewer reads the text.

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

function imagesRow(): string {
  const row = read('docs/plan/mvp-implementation-plan.md')
    .split(/\r?\n/)
    .find((line) => /^\|\s*Images\s*\|/.test(line));
  if (!row) throw new Error('the plan has no Images row in its decisions table');
  return row;
}

// The comment lines right above `[storage.buckets.quiz-images]`.
function configComment(): string {
  const lines = read('supabase/config.toml').split(/\r?\n/);
  const table = lines.findIndex((line) => line.trim() === '[storage.buckets.quiz-images]');
  if (table === -1) throw new Error('config.toml has no [storage.buckets.quiz-images] table');
  const comment: string[] = [];
  for (let i = table - 1; i >= 0 && lines[i].trim().startsWith('#'); i -= 1) {
    comment.unshift(lines[i]);
  }
  return comment.join('\n');
}

// The leading comment of the migration that inserts the bucket. Editing only
// a comment of an applied migration is harmless for `supabase db push`.
function insertMigrationComment(): string {
  const lines = read('supabase/migrations/20261003215819_create_quiz_images_bucket.sql').split(
    /\r?\n/,
  );
  const comment: string[] = [];
  for (const line of lines) {
    if (!line.trim().startsWith('--')) break;
    comment.push(line);
  }
  return comment.join('\n');
}

describe('quiz-images limit docs', () => {
  it('the plan’s Images row says a later migration enforces the limits on an existing bucket', () => {
    const row = imagesRow();
    expect(row).toMatch(/(enforc|updat)\w*[^|]*\blimits?\b|\blimits?\b[^|]*(enforc|updat)/i);
    expect(row).toMatch(/exist/i);
  });

  it('the plan’s Images row says CI compares the hosted bucket after every migration', () => {
    const row = imagesRow();
    expect(row).toMatch(/\bCI\b/);
    expect(row).toMatch(/hosted/i);
    expect(row).toMatch(/compar|check/i);
  });

  it('the config.toml comment says a later migration enforces the limits and CI compares the hosted bucket', () => {
    const comment = configComment();
    expect(comment).toMatch(
      /(enforc|updat)\w*[\s\S]*\blimits?\b|\blimits?\b[\s\S]*(enforc|updat)/i,
    );
    expect(comment).toMatch(/\bCI\b/);
    expect(comment).toMatch(/compar|check/i);
  });

  it('the insert migration’s comment says a later migration enforces the limits on an existing bucket', () => {
    const comment = insertMigrationComment();
    expect(comment).toMatch(
      /(enforc|updat)\w*[\s\S]*\blimits?\b|\blimits?\b[\s\S]*(enforc|updat)/i,
    );
    expect(comment).toMatch(/\blater\b|\bnewer\b|\bnext\b|\b\d{14}_\w+\.sql\b/i);
    expect(comment).toMatch(/exist/i);
  });
});
