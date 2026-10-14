/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #124 (S6, S7): after the hosted migration and config push, CI compares the
// hosted quiz-images bucket with the expected values and fails on any
// difference. The comparison is a script so it runs locally without hosted
// access: `node scripts/check-quiz-images-bucket.mjs [file]` reads the bucket
// rows as JSON (an array of storage.buckets rows, e.g. the result of a
// select through the Management API) from the file or, without one, from
// stdin, and takes the expected values from `[storage.buckets.quiz-images]`
// in supabase/config.toml, the one source tests/repo/quiz-images-bucket
// also checks. It exits 0 only when quiz-images is there and its public
// flag, size limit and set of file types match; a missing or null field
// never counts as a match: null means "no limit", which is the drift S6
// is about.

jest.setTimeout(30_000);

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'check-quiz-images-bucket.mjs');

type Row = Record<string, unknown>;

const MATCHING: Row = {
  id: 'quiz-images',
  name: 'quiz-images',
  public: true,
  file_size_limit: 5242880,
  allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
};

const OTHER_BUCKET: Row = {
  id: 'avatars',
  name: 'avatars',
  public: false,
  file_size_limit: null,
  allowed_mime_types: null,
};

type Result = { status: number | null; output: string };

function check(input: string, options: { cwd?: string; script?: string } = {}): Result {
  const result = spawnSync('node', [options.script ?? SCRIPT], {
    cwd: options.cwd ?? ROOT,
    input,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const checkRows = (rows: Row[]) => check(JSON.stringify(rows));

function expectRefused(result: Result, ...mentions: RegExp[]) {
  expect(result.status).not.toBe(0);
  // Refused with a message, not killed or crashed with a stack trace.
  expect(result.status).not.toBeNull();
  expect(result.output.trim()).not.toBe('');
  expect(result.output).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m);
  for (const mention of mentions) expect(result.output).toMatch(mention);
}

describe('scripts/check-quiz-images-bucket.mjs', () => {
  describe('accepts', () => {
    it('a quiz-images bucket that matches config.toml', () => {
      const result = checkRows([MATCHING]);
      expect(result).toEqual({ status: 0, output: expect.any(String) });
    });

    it('the file types in any order', () => {
      const result = checkRows([
        { ...MATCHING, allowed_mime_types: ['image/webp', 'image/png', 'image/jpeg'] },
      ]);
      expect(result.status).toBe(0);
    });

    it('other buckets next to quiz-images, whatever their limits', () => {
      const result = checkRows([OTHER_BUCKET, MATCHING]);
      expect(result.status).toBe(0);
    });

    it('the size limit as a decimal string, since a bigint may reach JSON as one', () => {
      const result = checkRows([{ ...MATCHING, file_size_limit: '5242880' }]);
      expect(result.status).toBe(0);
    });

    it('the rows from a file named as its argument', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-check-'));
      const file = path.join(dir, 'buckets.json');
      fs.writeFileSync(file, JSON.stringify([MATCHING]));
      try {
        const result = spawnSync('node', [SCRIPT, file], { cwd: ROOT, encoding: 'utf8' });
        expect(result.status).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('refuses', () => {
    it('rows without a quiz-images bucket', () => {
      expectRefused(checkRows([OTHER_BUCKET]), /quiz-images/);
    });

    it('an empty list', () => {
      expectRefused(checkRows([]), /quiz-images/);
    });

    it('a bucket that is not public', () => {
      expectRefused(checkRows([{ ...MATCHING, public: false }]), /public/);
    });

    it('a looser size limit (the global 50 MiB)', () => {
      expectRefused(checkRows([{ ...MATCHING, file_size_limit: 52428800 }]), /file_size_limit/);
    });

    it('a size limit one byte over 5 MiB', () => {
      expectRefused(checkRows([{ ...MATCHING, file_size_limit: 5242881 }]), /file_size_limit/);
    });

    it('a stricter size limit', () => {
      expectRefused(checkRows([{ ...MATCHING, file_size_limit: 1048576 }]), /file_size_limit/);
    });

    it('an extra file type', () => {
      expectRefused(
        checkRows([
          {
            ...MATCHING,
            allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
          },
        ]),
        /allowed_mime_types/,
      );
    });

    it('a missing file type', () => {
      expectRefused(
        checkRows([{ ...MATCHING, allowed_mime_types: ['image/png', 'image/jpeg'] }]),
        /allowed_mime_types/,
      );
    });

    it('a wildcard type instead of the three', () => {
      expectRefused(
        checkRows([{ ...MATCHING, allowed_mime_types: ['image/*'] }]),
        /allowed_mime_types/,
      );
    });

    it('a null size limit (no limit at all)', () => {
      expectRefused(checkRows([{ ...MATCHING, file_size_limit: null }]), /file_size_limit/);
    });

    it('null file types (any type allowed)', () => {
      expectRefused(checkRows([{ ...MATCHING, allowed_mime_types: null }]), /allowed_mime_types/);
    });

    it('an empty list of file types', () => {
      expectRefused(checkRows([{ ...MATCHING, allowed_mime_types: [] }]), /allowed_mime_types/);
    });

    for (const field of ['public', 'file_size_limit', 'allowed_mime_types']) {
      it(`a row without the ${field} field, never treating it as a match`, () => {
        const row = { ...MATCHING };
        delete row[field];
        expectRefused(checkRows([row]), new RegExp(field));
      });
    }

    it('input that is not JSON', () => {
      expectRefused(check('<html>502 Bad Gateway</html>'));
    });

    it('empty input', () => {
      expectRefused(check(''));
    });

    it('an API error object instead of a list of rows', () => {
      expectRefused(check(JSON.stringify({ message: 'Unauthorized' })));
    });
  });

  describe('takes the expected values from supabase/config.toml', () => {
    // The script in a copy of the repo layout whose config.toml says 2 MiB
    // and png only: the values it accepts must follow.
    let sandbox: string;
    let copied: string;

    beforeAll(() => {
      sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-check-config-')));
      fs.mkdirSync(path.join(sandbox, 'scripts'));
      fs.mkdirSync(path.join(sandbox, 'supabase'));
      copied = path.join(sandbox, 'scripts', 'check-quiz-images-bucket.mjs');
      fs.copyFileSync(SCRIPT, copied);
      const config = fs
        .readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8')
        .replace(/^file_size_limit = "5MiB"$/m, 'file_size_limit = "2MiB"')
        .replace(
          /^allowed_mime_types = \["image\/png", "image\/jpeg", "image\/webp"\]$/m,
          'allowed_mime_types = ["image/png"]',
        );
      fs.writeFileSync(path.join(sandbox, 'supabase', 'config.toml'), config);
    });

    afterAll(() => {
      fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it('accepts a bucket matching the changed config', () => {
      const result = check(
        JSON.stringify([
          { ...MATCHING, file_size_limit: 2097152, allowed_mime_types: ['image/png'] },
        ]),
        { cwd: sandbox, script: copied },
      );
      expect(result.status).toBe(0);
    });

    it('refuses the values of the real config there', () => {
      expectRefused(check(JSON.stringify([MATCHING]), { cwd: sandbox, script: copied }));
    });
  });
});
