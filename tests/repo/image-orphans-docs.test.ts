/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Image upload (#83): the app removes the object of a replaced or removed
// image after the save, and an uploaded one again when the save fails. Some
// objects still outlive their rows: deleting a question, quiz or category
// cascades through foreign keys without touching Storage, and a removal can
// fail after the save went through. The plan's decisions table documents
// that (the Images row): that such orphans exist, why they're acceptable and
// how they're found (objects no image_path names) and cleaned up. Only
// keywords are checked here; the reviewer reads the row itself. It and supabase/config.toml no longer
// say that nobody can write to the bucket.

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

// The row of the plan's decisions table whose first cell is `Images`.
function imagesRow(): string {
  const row = read('docs/plan/mvp-implementation-plan.md')
    .split(/\r?\n/)
    .find((line) => /^\|\s*Images\s*\|/.test(line));
  if (!row) throw new Error('the plan has no Images row in its decisions table');
  return row;
}

describe('image docs', () => {
  it('the plan’s Images row says admins upload, replace and remove images', () => {
    const row = imagesRow();
    expect(row).not.toMatch(/no storage policies yet/i);
    expect(row).not.toMatch(/nobody can write/i);
    expect(row).not.toMatch(/uploads come with phase 2/i);
    expect(row).toMatch(/admin/i);
  });

  it('the plan’s Images row documents orphaned objects: from cascading deletes and failed removals, why they are acceptable, and how they are cleaned up', () => {
    const row = imagesRow();
    expect(row).toMatch(/orphan/i);
    expect(row).toMatch(/cascad/i);
    expect(row).toMatch(/fail/i);
    expect(row).toMatch(/clean/i);
    // How they are found: the objects that no questions.image_path or
    // answers.image_path names.
    expect(row).toMatch(/image_path/);
  });

  it('supabase/config.toml no longer says nobody can write the bucket', () => {
    expect(read('supabase/config.toml')).not.toMatch(/nobody can write/i);
  });
});
