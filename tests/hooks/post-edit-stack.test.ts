/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fixture, runHookInSession } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'post-edit.mjs';
const MIGRATION = 'supabase/migrations/20261003000000_quizzes.sql';
const STACK_ENV =
  'SUPABASE_PROJECT_ID=quiz-learning-platform-7-quiz-player\nSUPABASE_API_PORT=54421\n';

function edited(filePath: string) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath },
    tool_response: { filePath, success: true },
  };
}

// A migration edit in a linked worktree must reach that worktree's own stack
// (its supabase/.env.local), never the main checkout's stack on the default
// ports. The session is launched in the main checkout and works in the
// worktree, so the hook has to go by the event's cwd, not by
// CLAUDE_PROJECT_DIR or its own working directory.
describe('post-edit hook: migration edits and the worktree stack', () => {
  let fixture: Fixture;
  let outside: string;
  let worktree: string;
  let worktreeLog: string;

  beforeEach(() => {
    fixture = new Fixture();
    fixture.write('supabase/config.toml', 'project_id = "quiz-learning-platform"\n');
    fixture.commitAll();
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-worktree-')));
    worktree = path.join(outside, '7-quiz-player');
    fixture.git('worktree', 'add', '-q', '-b', '7-quiz-player', worktree);
    // The worktree's own fake `supabase`, which logs its arguments and the
    // directory it ran in, separate from the main checkout's fake.
    worktreeLog = path.join(outside, 'worktree-supabase-calls.log');
    const fake = path.join(worktree, 'node_modules', '.bin', 'supabase');
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(
      fake,
      ['#!/bin/sh', `printf '%s|%s\\n' "$*" "$(pwd -P)" >> "${worktreeLog}"`, 'exit 0', ''].join(
        '\n',
      ),
    );
    fs.chmodSync(fake, 0o755);
  });

  afterEach(() => {
    fixture.remove();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function worktreeCalls(): { args: string; cwd: string }[] {
    if (!fs.existsSync(worktreeLog)) return [];
    return fs
      .readFileSync(worktreeLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [args, cwd] = line.split('|');
        return { args, cwd };
      });
  }

  function writeMigration(dir: string): string {
    const file = path.join(dir, MIGRATION);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'select 1;\n');
    return file;
  }

  /** Edits a migration in the worktree from a session launched in the main checkout. */
  function editMigrationInWorktree() {
    const file = writeMigration(worktree);
    return runHookInSession(
      HOOK,
      { ...edited(file), cwd: worktree },
      { cwd: worktree, launchDir: fixture.dir },
    );
  }

  it('blocks a migration edit in a worktree without its own stack and names scripts/stack.mjs', () => {
    const result = editMigrationInWorktree();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('scripts/stack.mjs');
    expect(worktreeCalls()).toEqual([]);
    expect(fixture.supabaseCalls()).toEqual([]);
  });

  it('blocks a migration edit in a worktree without its own stack even when the main checkout has stack settings', () => {
    fixture.write('supabase/.env.local', STACK_ENV);

    const result = editMigrationInWorktree();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('scripts/stack.mjs');
    expect(worktreeCalls()).toEqual([]);
    expect(fixture.supabaseCalls()).toEqual([]);
  });

  it('resets and tests the worktree database in the worktree when the worktree has its own stack', () => {
    fs.writeFileSync(path.join(worktree, 'supabase', '.env.local'), STACK_ENV);
    expect(fixture.exists('supabase/.env.local')).toBe(false);

    const result = editMigrationInWorktree();

    expect(result.output).toBeUndefined();
    expect(worktreeCalls()).toEqual([
      { args: 'db reset', cwd: worktree },
      { args: 'test db', cwd: worktree },
    ]);
    expect(fixture.supabaseCalls()).toEqual([]);
  });

  it('resets and tests the database in the main checkout, which needs no stack settings', () => {
    const file = writeMigration(fixture.dir);

    const result = runHookInSession(
      HOOK,
      { ...edited(file), cwd: fixture.dir },
      { cwd: fixture.dir, launchDir: fixture.dir },
    );

    expect(result.output).toBeUndefined();
    expect(fixture.supabaseCalls()).toEqual(['db reset', 'test db']);
    expect(worktreeCalls()).toEqual([]);
  });
});
