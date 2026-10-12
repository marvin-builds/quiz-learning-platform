/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fixture, runHookInSession, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

// A workflow agent of the orchestrator (#17): its cwd and CLAUDE_PROJECT_DIR
// stay the orchestrator checkout (`launch`, clean), and `cd` doesn't persist,
// so it edits the slice worktree (`slice`, a separate repository) by absolute
// path. The hooks have to check the slice, not the launch checkout.
describe('hooks of an agent that works in a slice worktree by absolute path', () => {
  let launch: Fixture;
  let slice: Fixture;
  let scratch: string;

  beforeEach(() => {
    launch = new Fixture({ nodeModules: false });
    launch.write('README.md', 'orchestrator checkout\n');
    launch.commitAll();
    launch.markAsOriginMain();
    slice = new Fixture();
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-slice-scratch-')));
  });

  afterEach(() => {
    launch.remove();
    slice.remove();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function fromLaunch(script: string, input: Record<string, unknown>) {
    return runHookInSession(script, input, {
      cwd: launch.dir,
      launchDir: launch.dir,
    });
  }

  describe('post-edit', () => {
    function edited(filePath: string) {
      return fromLaunch('post-edit.mjs', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
        tool_response: { filePath, success: true },
      });
    }

    beforeEach(() => {
      writeTypeScriptProject(slice);
      slice.commitAll();
    });

    it('typechecks the slice worktree the edited file belongs to', () => {
      const file = slice.write('src/score.ts', "export const score: number = 'ten';\n");

      const result = edited(file);

      expect(result.status).toBe(0);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toContain('TS2322');
    });

    it('applies lint fixes in the slice worktree and lets a clean edit pass', () => {
      const file = slice.write('src/score.ts', 'let score = 10;\nexport { score };\n');

      const result = edited(file);

      expect(result.status).toBe(0);
      expect(result.output).toBeUndefined();
      expect(slice.read('src/score.ts')).toContain('const score = 10;');
    });
  });

  describe('test-writer-scope', () => {
    function write(filePath: string) {
      return fromLaunch('test-writer-scope.mjs', {
        hook_event_name: 'PreToolUse',
        agent_type: 'test-writer',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'x' },
      });
    }

    beforeEach(() => {
      slice.write('supabase/tests/database/existing.test.sql', 'select 1;\n');
      slice.write('src/existing.ts', 'export {};\n');
      slice.commitAll();
    });

    it('allows a test file of the slice worktree', () => {
      const result = write(slice.path('supabase/tests/database/x.test.sql'));

      expect(result.status).toBe(0);
      expect(result.output?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });

    it('allows a test file in a directory of the slice worktree that does not exist yet', () => {
      const result = write(slice.path('supabase/tests/database/new/deeper/x.test.sql'));

      expect(result.status).toBe(0);
      expect(result.output?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });

    it('blocks a non-test file of the slice worktree, named relative to it', () => {
      const result = write(slice.path('src/x.ts'));

      expect(result.status).toBe(0);
      expect(result.output?.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(result.output?.hookSpecificOutput?.permissionDecisionReason).toContain(
        'not src/x.ts.',
      );
    });

    it('blocks a file outside any git repository', () => {
      const outside = path.join(scratch, 'supabase/tests/database/x.test.sql');

      const result = write(outside);

      expect(result.status).toBe(0);
      expect(result.output?.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(result.output?.hookSpecificOutput?.permissionDecisionReason).toContain(outside);
    });
  });

  describe('stop gate', () => {
    type Content = string | { type: 'text'; text: string }[];
    const userEntry = (content: Content) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content } });
    const assistantEntry = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    const summaryEntry = (summary: string) => JSON.stringify({ type: 'summary', summary });
    const prompt = (worktree: string) =>
      `Implement issue #17.\nSlice worktree: ${worktree}\nRun the tests there.`;

    function transcript(...entries: string[]): string {
      const file = path.join(scratch, 'agent-transcript.jsonl');
      fs.writeFileSync(file, `${entries.join('\n')}\n`);
      return file;
    }

    function subagentStop(transcriptPath: string, agentType = 'general-purpose') {
      return fromLaunch('stop-gate.mjs', {
        hook_event_name: 'SubagentStop',
        agent_type: agentType,
        agent_id: 'agent-1',
        stop_hook_active: false,
        agent_transcript_path: transcriptPath,
      });
    }

    /** The gate checked `slice`: its committed test fails there. */
    function expectSliceChecked(result: ReturnType<typeof subagentStop>) {
      expect(result.status).toBe(0);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toContain('Failing test src/sum.test.js');
      expect(result.output?.reason).not.toContain(launch.dir);
    }

    /**
     * The gate checked `launch`: it has a code change but no node_modules, so
     * the gate reports a setup problem that names the launch directory.
     */
    function expectLaunchChecked(result: ReturnType<typeof subagentStop>) {
      expect(result.status).toBe(0);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toContain(
        `Setup problem: jest could not be started in ${launch.dir}`,
      );
      expect(result.output?.reason).not.toContain('src/sum.test.js');
    }

    beforeEach(() => {
      launch.write('src/app.js', 'module.exports = 1;\n');
      slice.write('package.json', JSON.stringify({ jest: { testEnvironment: 'node' } }));
      slice.write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
      slice.write(
        'src/sum.test.js',
        "const sum = require('./sum');\ntest('adds', () => expect(sum(1, 2)).toBe(3));\n",
      );
      slice.commitAll();
      slice.markAsOriginMain();
      // Production code broken: the committed test fails.
      slice.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
    });

    describe('on SubagentStop', () => {
      it('checks the slice worktree named in the first user entry (string content, after a non-user entry)', () => {
        const result = subagentStop(
          transcript(summaryEntry('Earlier work'), userEntry(prompt(slice.dir))),
        );

        expectSliceChecked(result);
      });

      it('checks the slice worktree named in the first user entry (text blocks)', () => {
        const result = subagentStop(
          transcript(
            userEntry([
              { type: 'text', text: 'Implement issue #17.' },
              { type: 'text', text: `Slice worktree: ${slice.dir}\nRun the tests there.` },
            ]),
          ),
        );

        expectSliceChecked(result);
      });

      it('checks the cwd repository when the transcript names no slice worktree', () => {
        expectLaunchChecked(subagentStop(transcript(userEntry('Implement issue #17.'))));
      });

      it('falls back to the cwd repository when the named directory does not exist', () => {
        expectLaunchChecked(
          subagentStop(transcript(userEntry(prompt(path.join(scratch, 'missing'))))),
        );
      });

      it('falls back to the cwd repository when the named directory is not a git repository', () => {
        expectLaunchChecked(subagentStop(transcript(userEntry(prompt(scratch)))));
      });

      it('ignores a slice worktree named in a later user entry', () => {
        expectLaunchChecked(
          subagentStop(
            transcript(
              userEntry('Implement issue #17.'),
              assistantEntry('Working on it.'),
              userEntry(prompt(slice.dir)),
            ),
          ),
        );
      });

      it('falls back to the cwd repository when the transcript does not exist', () => {
        expectLaunchChecked(subagentStop(path.join(scratch, 'missing.jsonl')));
      });

      it('falls back to the cwd repository when the transcript is not JSON', () => {
        expectLaunchChecked(subagentStop(transcript('not json', userEntry(prompt(slice.dir)))));
      });

      it.each(['test-writer', 'reviewer'])(
        'lets the %s agent stop red in the slice worktree',
        (agentType) => {
          const result = subagentStop(transcript(userEntry(prompt(slice.dir))), agentType);

          expect(result.status).toBe(0);
          expect(result.output?.decision).toBeUndefined();
        },
      );
    });

    it('ignores the slice worktree marker on Stop of the main session', () => {
      const file = transcript(userEntry(prompt(slice.dir)));

      const result = fromLaunch('stop-gate.mjs', {
        hook_event_name: 'Stop',
        stop_hook_active: false,
        transcript_path: file,
        agent_transcript_path: file,
      });

      expectLaunchChecked(result);
    });
  });
});
