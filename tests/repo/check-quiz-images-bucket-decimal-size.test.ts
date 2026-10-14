/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #124 review: the script reads the size in config.toml the way
// tests/repo/quiz-images-bucket-limits.test.ts does, decimals included, so a
// "1.5MiB" there can't pass the repo test and then fail the hosted check.

jest.setTimeout(30_000);

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'check-quiz-images-bucket.mjs');

describe('scripts/check-quiz-images-bucket.mjs with a decimal size in config.toml', () => {
  let sandbox: string;
  let copied: string;

  beforeAll(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-check-decimal-')));
    fs.mkdirSync(path.join(sandbox, 'scripts'));
    fs.mkdirSync(path.join(sandbox, 'supabase'));
    copied = path.join(sandbox, 'scripts', 'check-quiz-images-bucket.mjs');
    fs.copyFileSync(SCRIPT, copied);
    const config = fs
      .readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8')
      .replace(/^file_size_limit = "5MiB"$/m, 'file_size_limit = "1.5MiB"');
    fs.writeFileSync(path.join(sandbox, 'supabase', 'config.toml'), config);
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function check(fileSizeLimit: number) {
    const result = spawnSync('node', [copied], {
      cwd: sandbox,
      input: JSON.stringify([
        {
          id: 'quiz-images',
          name: 'quiz-images',
          public: true,
          file_size_limit: fileSizeLimit,
          allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
        },
      ]),
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('accepts a bucket of 1.5 MiB', () => {
    const result = check(1572864);
    expect(result.output).not.toMatch(/can't read the size/);
    expect(result.status).toBe(0);
  });

  it('refuses a bucket of 1 MiB', () => {
    const result = check(1048576);
    expect(result.output).not.toMatch(/can't read the size/);
    expect(result.status).not.toBe(0);
  });
});
