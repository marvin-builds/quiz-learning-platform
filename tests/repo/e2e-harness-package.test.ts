/**
 * @jest-environment node
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const E2E = path.join(ROOT, 'e2e');

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;

function e2eSpecs(): string[] {
  return existsSync(E2E) ? readdirSync(E2E).filter((name) => name.endsWith('.spec.ts')) : [];
}

describe('E2E harness: packages, scripts, Jest and ESLint', () => {
  it.each(['@playwright/test', '@axe-core/playwright'])('has %s as a dev dependency', (name) => {
    expect(pkg.devDependencies ?? {}).toHaveProperty([name]);
    expect(pkg.dependencies ?? {}).not.toHaveProperty([name]);
  });

  it('has a test:e2e script that runs Playwright', () => {
    expect(pkg.scripts?.['test:e2e']).toMatch(/\bplaywright test\b/);
  });

  it('keeps e2e out of the check script', () => {
    const check = pkg.scripts?.check ?? '';
    expect(check).not.toBe('');
    expect(check).not.toMatch(/playwright|test:e2e/);
  });

  it('has Playwright specs in e2e/, so the checks below cannot pass vacuously', () => {
    expect(e2eSpecs().length).toBeGreaterThan(0);
  });

  it('keeps Jest out of e2e/ but not out of other paths that mention e2e', () => {
    const listed = execFileSync(path.join(ROOT, 'node_modules', '.bin', 'jest'), ['--listTests'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter(Boolean);

    expect(listed.filter((file) => file.startsWith(`${E2E}${path.sep}`))).toEqual([]);
    expect(listed).toContain(__filename);
  });

  // ESLint 9 loads its config with a dynamic import, which Jest's module VM does
  // not support, so the project's real ESLint CLI runs in a child process.
  it('lints e2e/ and finds no problems there', () => {
    const { stdout, stderr } = spawnSync(
      path.join(ROOT, 'node_modules', '.bin', 'eslint'),
      ['e2e', '--format', 'json'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (!stdout) throw new Error(`ESLint produced no output: ${stderr}`);
    const results = JSON.parse(stdout) as {
      filePath: string;
      messages: { line: number; ruleId: string | null; message: string }[];
    }[];

    const linted = results.map((result) => path.relative(E2E, result.filePath));
    expect(linted).toEqual(expect.arrayContaining(e2eSpecs()));
    const problems = results.flatMap((result) =>
      result.messages.map(
        (m) => `${path.relative(ROOT, result.filePath)}:${m.line} ${m.ruleId}: ${m.message}`,
      ),
    );
    expect(problems).toEqual([]);
  });
});
