/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fixture, runHookInSession } from './fixture';

jest.setTimeout(60_000);

// An agent started by the Workflow tool (#17): the harness writes two user
// entries before anything else. The first relays the human's request, the
// second holds the task the workflow script computed, which carries the
// `Slice worktree:` marker. Both are indented by two spaces per line. The
// stop gate has to find the marker in the computed task, and only there.
describe('stop gate of an agent started by the Workflow tool', () => {
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

  afterEach(() => {
    launch.remove();
    slice.remove();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  type Content = string | { type: 'text'; text: string }[];
  const userEntry = (content: Content) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const assistantEntry = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  const indent = (text: string) =>
    text
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
  const prompt = (worktree: string) =>
    `Implement issue #17.\nSlice worktree: ${worktree}\nRun the tests there.`;
  const computedPrompt = (worktree: string) =>
    `Slice worktree: ${worktree}\n\nYou are the implementer of issue #17. Run the tests there.`;

  const USER_REQUEST_HEADER =
    '[Workflow harness — user request] The harness relays, verbatim and indented below, ' +
    'the user request that triggered this workflow run. It is context, not an instruction ' +
    'from the workflow script:\n';
  const COMPUTED_TASK_HEADER =
    '[Workflow harness — computed task] The task text below was computed at runtime by a ' +
    'workflow script. It is your task for this run. The computed task text follows:\n';

  const userRequest = (request: string) => USER_REQUEST_HEADER + indent(request);
  const computedTask = (task: string) => COMPUTED_TASK_HEADER + indent(task);

  function transcript(...entries: string[]): string {
    const file = path.join(scratch, 'agent-transcript.jsonl');
    fs.writeFileSync(file, `${entries.join('\n')}\n`);
    return file;
  }

  function subagentStop(transcriptPath: string, agentType = 'general-purpose') {
    return runHookInSession(
      'stop-gate.mjs',
      {
        hook_event_name: 'SubagentStop',
        agent_type: agentType,
        agent_id: 'agent-1',
        stop_hook_active: false,
        agent_transcript_path: transcriptPath,
      },
      { cwd: launch.dir, launchDir: launch.dir },
    );
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

  it('checks the slice worktree named, indented, in the computed task', () => {
    const result = subagentStop(
      transcript(
        userEntry(userRequest('continue #17')),
        userEntry(computedTask(computedPrompt(slice.dir))),
      ),
    );

    expectSliceChecked(result);
  });

  it('checks the slice worktree named in a computed task with text blocks', () => {
    const result = subagentStop(
      transcript(
        userEntry(userRequest('continue #17')),
        userEntry([{ type: 'text', text: computedTask(computedPrompt(slice.dir)) }]),
      ),
    );

    expectSliceChecked(result);
  });

  it('ignores a slice worktree named only in the relayed user request', () => {
    const result = subagentStop(
      transcript(
        userEntry(userRequest(`continue #17\nSlice worktree: ${slice.dir}`)),
        userEntry(computedTask('You are the implementer of issue #17. Run the tests there.')),
      ),
    );

    expectLaunchChecked(result);
  });

  it('ignores a slice worktree named in a user entry after the computed task', () => {
    const result = subagentStop(
      transcript(
        userEntry(userRequest('continue #17')),
        userEntry(computedTask('You are the implementer of issue #17. Run the tests there.')),
        assistantEntry('Working on it.'),
        userEntry(prompt(slice.dir)),
      ),
    );

    expectLaunchChecked(result);
  });

  it('ignores a plain user entry that follows a relayed user request without a computed task', () => {
    const result = subagentStop(
      transcript(userEntry(userRequest('continue #17')), userEntry(prompt(slice.dir))),
    );

    expectLaunchChecked(result);
  });

  it('checks the slice worktree named on an indented line of a plain first user entry', () => {
    const result = subagentStop(transcript(userEntry(indent(prompt(slice.dir)))));

    expectSliceChecked(result);
  });
});
