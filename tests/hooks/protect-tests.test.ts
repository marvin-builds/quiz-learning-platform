/**
 * @jest-environment node
 */
import { Fixture } from './fixture';

const HOOK = 'protect-tests.mjs';

function denied(result: ReturnType<Fixture['runHook']>): boolean {
  return result.output?.hookSpecificOutput?.permissionDecision === 'deny';
}

function edit(fixture: Fixture, relative: string, toolName = 'Edit') {
  return fixture.runHook(HOOK, {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: fixture.path(relative), old_string: 'a', new_string: 'b' },
  });
}

describe('protect-tests hook (PreToolUse)', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  it.each([
    'src/__tests__/home-screen.test.tsx',
    'src/domain/scoring.test.ts',
    'supabase/tests/database/profiles.test.sql',
    'e2e/play-quiz.spec.ts',
    'tests/lint/no-hard-coded-strings.test.ts',
  ])('blocks editing the committed test %s', (testFile) => {
    fixture.write(testFile, 'a\n');
    fixture.commitAll();

    const result = edit(fixture, testFile);

    expect(result.status).toBe(0);
    expect(denied(result)).toBe(true);
    const reason = result.output?.hookSpecificOutput?.permissionDecisionReason;
    expect(reason).toContain(`unlock tests: ${testFile}`);
    expect(reason).toMatch(/ask the human/i);
    expect(reason).not.toContain('.claude/state/tests-unlocked');
  });

  it.each(['Write', 'MultiEdit'])('blocks %s on a committed test as well', (toolName) => {
    fixture.write('src/domain/scoring.test.ts', 'a\n');
    fixture.commitAll();

    expect(denied(edit(fixture, 'src/domain/scoring.test.ts', toolName))).toBe(true);
  });

  it('allows writing a test that is not committed yet', () => {
    fixture.write('README.md', 'x\n');
    fixture.commitAll();

    const result = edit(fixture, 'src/domain/new-feature.test.ts', 'Write');

    expect(result.status).toBe(0);
    expect(denied(result)).toBe(false);
  });

  it('allows editing a test that exists only in the working tree', () => {
    fixture.write('README.md', 'x\n');
    fixture.commitAll();
    fixture.write('src/domain/new-feature.test.ts', 'a\n');

    expect(denied(edit(fixture, 'src/domain/new-feature.test.ts'))).toBe(false);
  });

  it('allows editing committed production code', () => {
    fixture.write('src/domain/scoring.ts', 'a\n');
    fixture.commitAll();

    expect(denied(edit(fixture, 'src/domain/scoring.ts'))).toBe(false);
  });

  it('allows editing a committed test while .claude/state/tests-unlocked exists', () => {
    fixture.write('src/domain/scoring.test.ts', 'a\n');
    fixture.commitAll();
    fixture.write('.claude/state/tests-unlocked', '');

    expect(denied(edit(fixture, 'src/domain/scoring.test.ts'))).toBe(false);
  });

  it.each(['Write', 'Edit'])(
    'blocks the agent from creating the unlock file with %s',
    (toolName) => {
      fixture.write('README.md', 'x\n');
      fixture.commitAll();

      expect(denied(edit(fixture, '.claude/state/tests-unlocked', toolName))).toBe(true);
    },
  );

  it('blocks shell commands that touch the unlock file', () => {
    const result = fixture.runHook(HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'touch .claude/state/tests-unlocked' },
    });

    expect(denied(result)).toBe(true);
  });

  it('allows other shell commands', () => {
    const result = fixture.runHook(HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result.status).toBe(0);
    expect(denied(result)).toBe(false);
  });
});
