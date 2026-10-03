/**
 * @jest-environment node
 */
import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'stop-gate.mjs';
const CAP = { QUIZ_STOP_CAP: '2' };

describe('stop-gate hook (Stop and SubagentStop)', () => {
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

  function stop(input: Record<string, unknown> = {}, env: Record<string, string> = {}) {
    return fixture.runHook(
      HOOK,
      { hook_event_name: 'Stop', stop_hook_active: false, ...input },
      { ...CAP, ...env },
    );
  }

  function breakCommittedTest(): void {
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');
  }

  it('lets the agent stop when tests and typecheck are green', () => {
    fixture.write('src/sum.js', 'module.exports = (a, b) => b + a;\n');

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it('blocks stopping while a committed test fails', () => {
    breakCommittedTest();

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('blocks stopping while a committed test fails after the change was committed on the branch', () => {
    breakCommittedTest();
    fixture.commitAll('break sum');

    expect(stop().output?.decision).toBe('block');
  });

  it('blocks stopping while production code has a type error', () => {
    fixture.write('src/score.ts', "export const score: number = 'ten';\n");

    const result = stop();

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('TS2322');
  });

  it('lets the agent stop at gate 1, when only new tests fail', () => {
    fixture.write(
      'src/score.test.js',
      "const score = require('./score');\ntest('scores', () => expect(score()).toBe(1));\n",
    );
    fixture.write(
      'src/score-types.test.ts',
      "import { score } from './score';\nexport const points: number = score();\n",
    );

    const result = stop();

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
  });

  it.each(['test-writer', 'reviewer'])(
    'lets the %s subagent stop while tests are red',
    (agentType) => {
      breakCommittedTest();

      const result = stop({ hook_event_name: 'SubagentStop', agent_type: agentType });

      expect(result.output?.decision).toBeUndefined();
    },
  );

  it('blocks other subagents while tests are red', () => {
    breakCommittedTest();

    const result = stop({ hook_event_name: 'SubagentStop', agent_type: 'general-purpose' });

    expect(result.output?.decision).toBe('block');
  });

  describe('after the cap of blocked stops', () => {
    beforeEach(() => {
      breakCommittedTest();
      expect(stop().output?.decision).toBe('block');
      expect(stop({ stop_hook_active: true }).output?.decision).toBe('block');
    });

    it('demands an escalation note instead of another fix attempt', () => {
      const result = stop({ stop_hook_active: true });

      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toContain('.claude/state/escalation.md');
    });

    it('lets the agent stop once the escalation note is written', () => {
      stop({ stop_hook_active: true });
      fixture.write('.claude/state/escalation.md', 'Tried X and Y; stuck on Z.\n');

      const result = stop({ stop_hook_active: true });

      expect(result.status).toBe(0);
      expect(result.output?.decision).toBeUndefined();
    });

    it('does not accept an escalation note left over from an earlier cap', () => {
      fixture.write('.claude/state/escalation.md', 'Old note.\n');
      stop({ stop_hook_active: true });

      expect(stop({ stop_hook_active: true }).output?.decision).toBe('block');
    });

    it('releases the agent anyway if no note follows', () => {
      for (let i = 0; i < 3; i++) {
        stop({ stop_hook_active: true });
      }

      expect(stop({ stop_hook_active: true }).output?.decision).toBeUndefined();
    });

    it('starts counting again on a new turn', () => {
      const result = stop({ stop_hook_active: false });

      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).not.toContain('escalation.md');
    });
  });
});
