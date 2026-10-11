/**
 * @jest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'stop-gate.mjs';
const CAP = { QUIZ_STOP_CAP: '2' };

const SUM_TEST = "const sum = require('./sum');\ntest('adds', () => expect(sum(1, 2)).toBe(3));\n";
/** A re-spec of the sum test that fails against the unchanged code. */
const RED_SUM_TEST =
  "const sum = require('./sum');\ntest('adds three', () => expect(sum(1, 2, 3)).toBe(6));\n";

// Approved tests are no longer locked (#100): a committed test whose content
// the agent changed is a re-spec waiting for gate 1, however it was changed,
// and may be red like a new test. A red committed test the agent didn't
// change is a regression and still blocks.
describe('stop-gate hook excusing any re-spec of a committed test', () => {
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

  it('lets the agent stop when the only red test is a changed committed test', () => {
    fixture.write('src/sum.test.js', RED_SUM_TEST);

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('lets the agent stop when a changed committed TypeScript test has a type error', () => {
    fixture.write(
      'src/score-types.test.ts',
      "import { score } from './score';\nexport const points: string = score();\n",
    );

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('blocks for a red committed test whose only change is its indentation', () => {
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
    fixture.write('src/sum.test.js', SUM_TEST.replace('test(', '  test('));

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('blocks for a red committed test the agent did not change', () => {
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });
});

describe('the harness without a test lock', () => {
  const root = path.resolve(__dirname, '../..');

  it('registers no hook that locks or unlocks tests', () => {
    const settings = fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8');

    expect(settings).not.toMatch(/protect-tests|unlock-tests/);
  });

  it('ships no lock hooks', () => {
    expect(fs.existsSync(path.join(root, '.claude/hooks/protect-tests.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude/hooks/unlock-tests.mjs'))).toBe(false);
  });
});
