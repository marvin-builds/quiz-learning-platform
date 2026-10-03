import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export type HookResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** stdout parsed as JSON, or undefined when the hook printed nothing. */
  output: Record<string, any> | undefined;
};

/**
 * A throwaway git repo that stands in for the project in hook tests. Its
 * node_modules links to the real packages, except for a fake `supabase` binary
 * that logs its arguments, so no Docker stack is needed.
 */
export class Fixture {
  readonly dir: string;

  constructor() {
    this.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-fixture-')));
    this.linkNodeModules();
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'fixture@example.com');
    this.git('config', 'user.name', 'Fixture');
    this.write('.gitignore', 'node_modules/\n.claude/state/\n');
  }

  path(relative: string): string {
    return path.join(this.dir, relative);
  }

  write(relative: string, content: string): string {
    const file = this.path(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  read(relative: string): string {
    return fs.readFileSync(this.path(relative), 'utf8');
  }

  exists(relative: string): boolean {
    return fs.existsSync(this.path(relative));
  }

  git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: this.dir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  commitAll(message = 'commit'): void {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
  }

  /** Marks the current commit as origin/main, the base the branch diverged from. */
  markAsOriginMain(): void {
    this.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }

  /** Arguments of every fake `supabase` call, one call per line. */
  supabaseCalls(): string[] {
    const log = this.path('supabase-calls.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  }

  /** Runs a hook script from this repo with the fixture as the project dir. */
  runHook(script: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
    return runHook(script, input, this.dir, env);
  }

  remove(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private linkNodeModules(): void {
    const real = path.join(REPO_ROOT, 'node_modules');
    const own = this.path('node_modules');
    fs.mkdirSync(path.join(own, '.bin'), { recursive: true });
    for (const entry of fs.readdirSync(real)) {
      if (entry !== '.bin' && entry !== '.cache') {
        fs.symlinkSync(path.join(real, entry), path.join(own, entry));
      }
    }
    for (const entry of fs.readdirSync(path.join(real, '.bin'))) {
      if (entry !== 'supabase') {
        fs.symlinkSync(
          fs.realpathSync(path.join(real, '.bin', entry)),
          path.join(own, '.bin', entry),
        );
      }
    }
    const fakeSupabase = path.join(own, '.bin', 'supabase');
    fs.writeFileSync(
      fakeSupabase,
      [
        '#!/bin/sh',
        `echo "$*" >> "${this.path('supabase-calls.log')}"`,
        'if [ "$*" = "test db" ] && [ -n "$FAKE_PGTAP_FAILURE" ]; then',
        '  echo "$FAKE_PGTAP_FAILURE"',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    fs.chmodSync(fakeSupabase, 0o755);
  }
}

export function runHook(
  script: string,
  input: Record<string, unknown>,
  projectDir: string,
  env: Record<string, string> = {},
): HookResult {
  const started = Date.now();
  const result = spawnSync('node', [path.join(REPO_ROOT, '.claude', 'hooks', script)], {
    cwd: projectDir,
    input: JSON.stringify({ session_id: 'test-session', cwd: projectDir, ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env },
  });
  // Every hook reports through JSON on exit code 0, so any other exit is a
  // crash, and a crash must not pass as "the hook allowed it".
  if (result.status !== 0) {
    throw new Error(`${script} exited with ${result.status}: ${result.stderr}`);
  }
  const stdout = result.stdout ?? '';
  return {
    status: result.status,
    stdout,
    stderr: result.stderr ?? '',
    durationMs: Date.now() - started,
    output: stdout.trim() ? JSON.parse(stdout) : undefined,
  };
}

/** Typecheck and lint setup for fixtures: strict tsc and two ESLint rules. */
export function writeTypeScriptProject(fixture: Fixture): void {
  fixture.write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['**/*.ts'],
    }),
  );
  fixture.write(
    'eslint.config.js',
    `const tsParser = require('@typescript-eslint/parser');
module.exports = [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser },
    rules: { 'prefer-const': 'error', 'no-debugger': 'error' },
  },
];
`,
  );
}
