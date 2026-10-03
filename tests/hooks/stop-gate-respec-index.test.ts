/**
 * @jest-environment node
 */
import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'stop-gate.mjs';
const CAP = { QUIZ_STOP_CAP: '2' };

// Jest runs the file in the working tree, not the one in the index. A committed
// test that is only removed from the index still asserts the approved content,
// so it is no re-spec and must not excuse a red run.
describe('stop-gate hook with a committed test changed only in the index', () => {
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

  it('still blocks for a red committed test that was only removed from the index', () => {
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
    fixture.git('rm', '-q', '--cached', 'src/sum.test.js');

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });
});
