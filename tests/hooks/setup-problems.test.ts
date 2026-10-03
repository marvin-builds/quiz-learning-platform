/**
 * @jest-environment node
 */
import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

// A checkout where `npm ci` never ran: the tools can't even be started, which
// is a setup problem to fix there, not red tests or type errors.
describe('hooks in a checkout without node_modules', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture({ nodeModules: false });
    writeTypeScriptProject(fixture);
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

  function expectSetupProblem(reason: string | undefined): void {
    expect(reason).toMatch(/setup problem/i);
    expect(reason).toContain(`could not be started in ${fixture.dir}`);
    expect(reason).toContain('npm ci');
  }

  it('stop gate reports a setup problem naming the directory', () => {
    // A branch without code changes skips the checks, so change some code.
    fixture.write('src/sum.js', 'module.exports = (a, b) => b + a;\n');

    const result = fixture.runHook(
      'stop-gate.mjs',
      { hook_event_name: 'Stop', stop_hook_active: false },
      { QUIZ_STOP_CAP: '2' },
    );

    expect(result.output?.decision).toBe('block');
    expectSetupProblem(result.output?.reason);
    expect(result.output?.reason).not.toMatch(/Failing test|Jest did not run|TypeScript/);
  });

  it('post-edit reports a setup problem naming the directory', () => {
    const file = fixture.write('src/score.ts', 'export const score = 10;\n');

    const result = fixture.runHook('post-edit.mjs', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file },
      tool_response: { filePath: file, success: true },
    });

    expect(result.output?.decision).toBe('block');
    expectSetupProblem(result.output?.reason);
    expect(result.output?.reason).not.toMatch(/ESLint:|TypeScript:/);
  });
});
