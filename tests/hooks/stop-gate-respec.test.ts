/**
 * @jest-environment node
 */
import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'stop-gate.mjs';
const CAP = { QUIZ_STOP_CAP: '2' };

// A committed test with uncommitted changes is a re-spec the human unlocked:
// like a new test at gate 1, it may be red until the human approves it.
describe('stop-gate hook with a committed test that has uncommitted changes', () => {
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

  /** Changes the approved sum test so that it fails against the unchanged code. */
  function respecCommittedTest(): void {
    fixture.write(
      'src/sum.test.js',
      "const sum = require('./sum');\ntest('adds three', () => expect(sum(1, 2, 3)).toBe(6));\n",
    );
  }

  function breakProductionCode(): void {
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
  }

  it('lets the agent stop when the only red test is a committed test changed in the working tree', () => {
    respecCommittedTest();

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('lets the agent stop when the only red test is a committed test with staged changes', () => {
    respecCommittedTest();
    fixture.git('add', 'src/sum.test.js');

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('lets the agent stop when a changed committed TypeScript test has a type error', () => {
    // Jest only runs the .js tests here, so the type error is the only failure.
    fixture.write(
      'package.json',
      JSON.stringify({ jest: { testEnvironment: 'node', testMatch: ['**/*.test.js'] } }),
    );
    fixture.write('src/score.ts', 'export const score = (): number => 1;\n');
    fixture.write(
      'src/score-types.test.ts',
      "import { score } from './score';\nexport const points: number = score();\n",
    );
    fixture.commitAll('approve score types');
    fixture.markAsOriginMain();
    expect(stop().output?.decision).toBeUndefined();

    fixture.write(
      'src/score-types.test.ts',
      "import { score } from './score';\nexport const points: string = score();\n",
    );

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('still blocks stopping while production code has a type error', () => {
    respecCommittedTest();
    fixture.write('src/score.ts', "export const score: number = 'ten';\n");

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('TS2322');
  });

  it('still blocks for a red unchanged committed test and names only that test', () => {
    fixture.write(
      'src/sum-more.test.js',
      "const sum = require('./sum');\ntest('adds two', () => expect(sum(2, 2)).toBe(4));\n",
    );
    fixture.commitAll('approve sum-more');
    fixture.markAsOriginMain();
    respecCommittedTest();
    breakProductionCode();

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum-more.test.js');
    expect(result.output?.reason).not.toContain('src/sum.test.js');
  });

  it('blocks stopping once the changed test is committed (approved again) and still red', () => {
    respecCommittedTest();
    fixture.commitAll('approve re-spec');

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });
});
