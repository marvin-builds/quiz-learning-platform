/**
 * @jest-environment node
 */
import fs from 'node:fs';

import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'stop-gate.mjs';
const CAP = { QUIZ_STOP_CAP: '2' };
const UNLOCK_FILE = '.claude/state/tests-unlocked';

// Only a change to what a committed test asserts is a re-spec the human
// unlocked. Changes that leave the test's content as it was (a file mode, blank
// lines, indentation), or a change to another file, must not excuse it.
describe('stop-gate hook with a committed test whose change is not a re-spec', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
    writeTypeScriptProject(fixture);
    fixture.write('package.json', JSON.stringify({ jest: { testEnvironment: 'node' } }));
    fixture.write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
    fixture.write(
      'src/sum.test.js',
      "const sum = require('./sum');\ntest('adds', () => expect(sum(1, 2)).toBe(3));\n",
    );
    fixture.commitAll();
    fixture.markAsOriginMain();
  });

  afterEach(() => {
    fixture.remove();
  });

  function stop() {
    return fixture.runHook(HOOK, { hook_event_name: 'Stop', stop_hook_active: false }, CAP);
  }

  /**
   * Changes a committed test as the agent does after the human's unlock: the
   * protect-tests hook allows the Edit and records it, then the tool writes the
   * file. The human's next message locks again, so the marker is gone at the stop.
   */
  function unlockedEdit(relative: string, content: string): void {
    fixture.write(UNLOCK_FILE, '');
    const result = fixture.runHook('protect-tests.mjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: fixture.path(relative), old_string: 'a', new_string: 'b' },
    });
    expect(result.output?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    fixture.write(relative, content);
    fs.rmSync(fixture.path(UNLOCK_FILE));
  }

  /** Makes the approved sum test red without touching it. */
  function breakProductionCode(): void {
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
  }

  it('still blocks for a red committed test whose only change is its file mode', () => {
    breakProductionCode();
    fs.chmodSync(fixture.path('src/sum.test.js'), 0o755);

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('still blocks for a red committed test whose only change is appended blank lines', () => {
    breakProductionCode();
    fs.appendFileSync(fixture.path('src/sum.test.js'), '\n\n');

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('still blocks for a red committed test whose only change is its indentation', () => {
    breakProductionCode();
    fixture.write(
      'src/sum.test.js',
      "const sum = require('./sum');\n    test('adds', () => expect(sum(1, 2)).toBe(3));\n",
    );

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('still blocks for a red unchanged committed test whose path matches a changed test as a glob', () => {
    // As a git pathspec, `src/[s]um.test.js` also matches `src/sum.test.js`.
    fixture.write(
      'src/[s]um.test.js',
      "const sum = require('./sum');\ntest('adds two', () => expect(sum(2, 2)).toBe(4));\n",
    );
    fixture.commitAll('approve bracket test');
    fixture.markAsOriginMain();
    breakProductionCode();
    unlockedEdit(
      'src/sum.test.js',
      "const sum = require('./sum');\ntest('subtracts', () => expect(sum(3, 1)).toBe(2));\n",
    );

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/[s]um.test.js');
    expect(result.output?.reason).not.toContain('Failing test src/sum.test.js');
  });
});
