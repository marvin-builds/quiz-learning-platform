/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fixture, runHookInSession, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

// A session that moved into a worktree: the event's cwd is the worktree, while
// CLAUDE_PROJECT_DIR and the hook's process stay in the launch checkout, which
// here has no node_modules, as on #13.
describe('hooks in a session that works in another repository than it was launched from', () => {
  let session: Fixture;
  let launch: Fixture;

  beforeEach(() => {
    session = new Fixture();
    launch = new Fixture({ nodeModules: false });
    launch.write('README.md', 'launch checkout\n');
    launch.commitAll();
  });

  afterEach(() => {
    session.remove();
    launch.remove();
  });

  function inSession(script: string, input: Record<string, unknown>, cwd = session.dir) {
    return runHookInSession(script, input, {
      cwd,
      launchDir: launch.dir,
      env: { QUIZ_STOP_CAP: '2' },
    });
  }

  describe('stop gate', () => {
    const stop = () =>
      inSession('stop-gate.mjs', { hook_event_name: 'Stop', stop_hook_active: false });

    beforeEach(() => {
      writeTypeScriptProject(session);
      session.write('package.json', JSON.stringify({ jest: { testEnvironment: 'node' } }));
      session.write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
      session.write(
        'src/sum.test.js',
        "const sum = require('./sum');\ntest('adds', () => expect(sum(1, 2)).toBe(3));\n",
      );
      session.commitAll();
      session.markAsOriginMain();
    });

    it('lets the agent stop when tests and typecheck in the cwd repository are green', () => {
      session.write('src/sum.js', 'module.exports = (a, b) => b + a;\n');

      const result = stop();

      expect(result.output?.reason).toBeUndefined();
      expect(result.output?.decision).toBeUndefined();
    });

    it('runs Jest in the cwd repository', () => {
      session.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');

      const result = stop();

      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toContain('Failing test src/sum.test.js');
    });

    it('runs tsc in the cwd repository', () => {
      session.write('src/score.ts', "export const score: number = 'ten';\n");

      const result = stop();

      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toContain('TS2322');
    });
  });

  describe('protect-tests', () => {
    function edit(relative: string, cwd = session.dir) {
      return inSession(
        'protect-tests.mjs',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: session.path(relative), old_string: 'a', new_string: 'b' },
        },
        cwd,
      );
    }

    const denied = (result: ReturnType<typeof edit>) =>
      result.output?.hookSpecificOutput?.permissionDecision === 'deny';

    it('blocks editing a test committed in the cwd repository', () => {
      session.write('src/domain/scoring.test.ts', 'a\n');
      session.commitAll();

      expect(denied(edit('src/domain/scoring.test.ts'))).toBe(true);
    });

    it('allows a new, uncommitted test in the cwd repository', () => {
      launch.write('src/domain/new-feature.test.ts', 'a\n');
      launch.commitAll();
      session.write('README.md', 'x\n');
      session.commitAll();

      expect(denied(edit('src/domain/new-feature.test.ts'))).toBe(false);
    });

    it('resolves a cwd in a subdirectory to the top level of its work tree', () => {
      session.write('tests/lint/rule.test.ts', 'a\n');
      session.commitAll();

      expect(denied(edit('tests/lint/rule.test.ts', session.path('tests/lint')))).toBe(true);
    });
  });

  describe('post-edit', () => {
    function edited(relative: string) {
      const filePath = session.path(relative);
      return inSession('post-edit.mjs', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
        tool_response: { filePath, success: true },
      });
    }

    beforeEach(() => {
      writeTypeScriptProject(session);
      session.commitAll();
    });

    it('typechecks in the cwd repository', () => {
      session.write('src/score.ts', "export const score: number = 'ten';\n");

      const result = edited('src/score.ts');

      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toContain('src/score.ts');
      expect(result.output?.reason).toContain('TS2322');
    });

    it('applies lint fixes in the cwd repository', () => {
      session.write('src/score.ts', 'let score = 10;\nexport { score };\n');

      const result = edited('src/score.ts');

      expect(result.output).toBeUndefined();
      expect(session.read('src/score.ts')).toContain('const score = 10;');
    });
  });

  describe('test-writer-scope', () => {
    function write(relative: string) {
      return inSession('test-writer-scope.mjs', {
        hook_event_name: 'PreToolUse',
        agent_type: 'test-writer',
        tool_name: 'Write',
        tool_input: { file_path: session.path(relative), content: 'x' },
      });
    }

    it('allows writing a test file of the cwd repository', () => {
      const result = write('src/domain/scoring.test.ts');

      expect(result.output?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });

    it('blocks a non-test file of the cwd repository, named relative to it', () => {
      const result = write('src/domain/scoring.ts');

      expect(result.output?.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(result.output?.hookSpecificOutput?.permissionDecisionReason).toContain(
        'not src/domain/scoring.ts.',
      );
    });
  });
});

describe('project directory fallbacks', () => {
  let project: Fixture;
  let elsewhere: Fixture;
  let notARepo: string;

  beforeEach(() => {
    project = new Fixture({ nodeModules: false });
    project.write('src/domain/scoring.test.ts', 'a\n');
    project.commitAll();
    elsewhere = new Fixture({ nodeModules: false });
    elsewhere.write('README.md', 'x\n');
    elsewhere.commitAll();
    notARepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-no-repo-')));
  });

  afterEach(() => {
    project.remove();
    elsewhere.remove();
    fs.rmSync(notARepo, { recursive: true, force: true });
  });

  function editCommittedTest(
    cwd: string | undefined,
    launchDir: string,
    env: Record<string, string> = {},
  ) {
    const result = runHookInSession(
      'protect-tests.mjs',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: project.path('src/domain/scoring.test.ts'),
          old_string: 'a',
          new_string: 'b',
        },
      },
      { cwd, launchDir, env },
    );
    return result.output?.hookSpecificOutput?.permissionDecision === 'deny';
  }

  it('uses CLAUDE_PROJECT_DIR when the event has no cwd', () => {
    expect(editCommittedTest(undefined, project.dir)).toBe(true);
  });

  it('uses CLAUDE_PROJECT_DIR when cwd is not inside a git work tree', () => {
    expect(editCommittedTest(notARepo, project.dir)).toBe(true);
  });

  it('prefers CLAUDE_PROJECT_DIR over the process directory', () => {
    expect(editCommittedTest(notARepo, elsewhere.dir, { CLAUDE_PROJECT_DIR: project.dir })).toBe(
      true,
    );
  });

  it('uses the process directory when there is neither a usable cwd nor CLAUDE_PROJECT_DIR', () => {
    expect(editCommittedTest(notARepo, project.dir, { CLAUDE_PROJECT_DIR: '' })).toBe(true);
  });
});
