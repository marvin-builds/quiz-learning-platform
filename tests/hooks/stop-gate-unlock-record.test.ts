/**
 * @jest-environment node
 */
import fs from 'node:fs';
import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'stop-gate.mjs';
const CAP = { QUIZ_STOP_CAP: '2' };
const UNLOCK_FILE = '.claude/state/tests-unlocked';
const RECORD = '.claude/state/unlocked-edits';

const SUM_TEST = "const sum = require('./sum');\ntest('adds', () => expect(sum(1, 2)).toBe(3));\n";
/** A re-spec of the sum test that fails against the unchanged code. */
const RED_SUM_TEST =
  "const sum = require('./sum');\ntest('adds three', () => expect(sum(1, 2, 3)).toBe(6));\n";
/** A re-spec of the sum test that passes against the unchanged code. */
const GREEN_SUM_TEST =
  "const sum = require('./sum');\ntest('adds two', () => expect(sum(2, 2)).toBe(4));\n";

// A changed committed test may be red only when the human unlocked it and the
// change went through Edit/Write, which protect-tests records. A change made
// any other way (a shell `sed`, `echo >>`) leaves no record and still blocks.
describe('stop-gate hook excusing only recorded re-specs of committed tests', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
    writeTypeScriptProject(fixture);
    fixture.write(
      'package.json',
      JSON.stringify({ jest: { testEnvironment: 'node', testMatch: ['**/*.test.js'] } }),
    );
    fixture.write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
    fixture.write('src/sum.test.js', SUM_TEST);
    fixture.write('src/other.test.js', "test('holds', () => expect(1).toBe(1));\n");
    fixture.write('src/score.ts', 'export const score = (): number => 1;\n');
    fixture.write(
      'src/score-types.test.ts',
      "import { score } from './score';\nexport const points: number = score();\n",
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
   * protect-tests hook allows the Edit, then the tool writes the file. The
   * human's next message locks again, so the unlock marker is gone at the stop.
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

  function recorded(): string[] {
    return fixture.exists(RECORD) ? fixture.read(RECORD).split('\n').filter(Boolean) : [];
  }

  it('lets the agent stop when the only red test is a recorded re-spec of a committed test', () => {
    unlockedEdit('src/sum.test.js', RED_SUM_TEST);

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('lets the agent stop when a recorded re-spec of a committed TypeScript test has a type error', () => {
    unlockedEdit(
      'src/score-types.test.ts',
      "import { score } from './score';\nexport const points: string = score();\n",
    );

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('blocks for a red committed test whose content was changed without a record', () => {
    fixture.write('src/sum.test.js', RED_SUM_TEST);

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('blocks for a type error in a committed TypeScript test changed without a record', () => {
    fixture.write(
      'src/score-types.test.ts',
      "import { score } from './score';\nexport const points: string = score();\n",
    );

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/score-types.test.ts');
    expect(result.output?.reason).toContain('TS2322');
  });

  it('blocks for a red committed test changed by other means while the human has it unlocked', () => {
    fixture.write(UNLOCK_FILE, 'src/sum.test.js\n');
    fixture.write('src/sum.test.js', RED_SUM_TEST);

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('blocks for a red changed committed test when only another test is recorded', () => {
    unlockedEdit('src/other.test.js', "test('holds', () => expect(2).toBe(2));\n");
    fixture.write('src/sum.test.js', RED_SUM_TEST);

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
    expect(result.output?.reason).not.toContain('src/other.test.js');
  });

  it('still blocks for a red recorded test whose only change is its indentation', () => {
    unlockedEdit('src/sum.test.js', SUM_TEST.replace('test(', '    test('));
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('drops a committed re-spec from the record and keeps still-changed ones', () => {
    unlockedEdit('src/sum.test.js', GREEN_SUM_TEST);
    unlockedEdit('src/other.test.js', "test('fails', () => expect(1).toBe(2));\n");
    expect(recorded()).toEqual(['src/sum.test.js', 'src/other.test.js']);
    fixture.git('add', 'src/sum.test.js');
    fixture.git('commit', '-q', '-m', 'approve sum re-spec');

    const result = stop();

    expect(result.output?.decision).toBeUndefined();
    expect(recorded()).toEqual(['src/other.test.js']);
  });

  it('drops a re-spec from the record once the file matches HEAD again', () => {
    unlockedEdit('src/sum.test.js', RED_SUM_TEST);
    expect(recorded()).toEqual(['src/sum.test.js']);
    fixture.git('checkout', '--', 'src/sum.test.js');

    stop();

    expect(recorded()).toEqual([]);
  });

  it('blocks for a later unrecorded change to a test whose re-spec was committed', () => {
    unlockedEdit('src/sum.test.js', GREEN_SUM_TEST);
    expect(recorded()).toEqual(['src/sum.test.js']);
    fixture.commitAll('approve sum re-spec');
    expect(stop().output?.decision).toBeUndefined();

    fixture.write('src/sum.test.js', RED_SUM_TEST);
    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });
});
