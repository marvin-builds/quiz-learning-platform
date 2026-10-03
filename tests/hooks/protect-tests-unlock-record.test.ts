/**
 * @jest-environment node
 */
import { Fixture } from './fixture';

const HOOK = 'protect-tests.mjs';
const UNLOCK_FILE = '.claude/state/tests-unlocked';
const RECORD = '.claude/state/unlocked-edits';

function denied(result: ReturnType<Fixture['runHook']>): boolean {
  return result.output?.hookSpecificOutput?.permissionDecision === 'deny';
}

// When the human unlocked a committed test and the agent edits it through
// Edit/Write, protect-tests records the path, so the stop gate can tell an
// unlocked re-spec from a change made some other way (e.g. a shell `sed`).
describe('protect-tests hook recording unlocked edits of committed tests', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
    fixture.write('src/domain/scoring.ts', 'a\n');
    fixture.write('src/domain/scoring.test.ts', 'a\n');
    fixture.write('src/domain/streak.test.ts', 'a\n');
    fixture.write('tests/notebooks/report.ipynb', '{}\n');
    fixture.commitAll();
  });

  afterEach(() => {
    fixture.remove();
  });

  function edit(relative: string, toolName = 'Edit') {
    const tool_input =
      toolName === 'NotebookEdit'
        ? { notebook_path: fixture.path(relative), new_source: 'b' }
        : { file_path: fixture.path(relative), old_string: 'a', new_string: 'b' };
    return fixture.runHook(HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input,
    });
  }

  function recorded(): string[] {
    return fixture.exists(RECORD) ? fixture.read(RECORD).split('\n').filter(Boolean) : [];
  }

  it.each([
    ['Edit', 'src/domain/scoring.test.ts'],
    ['Write', 'src/domain/scoring.test.ts'],
    ['MultiEdit', 'src/domain/scoring.test.ts'],
    ['NotebookEdit', 'tests/notebooks/report.ipynb'],
  ])('records the path when %s on an unlocked committed test is allowed', (toolName, testFile) => {
    fixture.write(UNLOCK_FILE, '');

    const result = edit(testFile, toolName);

    expect(denied(result)).toBe(false);
    expect(recorded()).toEqual([testFile]);
  });

  it('records the path when the unlock lists that test', () => {
    fixture.write(UNLOCK_FILE, 'src/domain/scoring.test.ts\n');

    expect(denied(edit('src/domain/scoring.test.ts'))).toBe(false);

    expect(recorded()).toEqual(['src/domain/scoring.test.ts']);
  });

  it('records each unlocked test once, one path per line', () => {
    fixture.write(UNLOCK_FILE, '');

    edit('src/domain/scoring.test.ts');
    edit('src/domain/streak.test.ts');
    edit('src/domain/scoring.test.ts', 'Write');

    expect(fixture.read(RECORD)).toBe('src/domain/scoring.test.ts\nsrc/domain/streak.test.ts\n');
  });

  it('records nothing when the committed test is locked', () => {
    const result = edit('src/domain/scoring.test.ts');

    expect(denied(result)).toBe(true);
    expect(recorded()).toEqual([]);
  });

  it('records nothing when the unlock lists only other tests', () => {
    fixture.write(UNLOCK_FILE, 'src/domain/streak.test.ts\n');

    const result = edit('src/domain/scoring.test.ts');

    expect(denied(result)).toBe(true);
    expect(recorded()).toEqual([]);
  });

  it('records nothing for a new, uncommitted test', () => {
    fixture.write(UNLOCK_FILE, '');
    fixture.write('src/domain/new-feature.test.ts', 'a\n');

    expect(denied(edit('src/domain/new-feature.test.ts'))).toBe(false);

    expect(recorded()).toEqual([]);
  });

  it('records nothing for a file that is not a test', () => {
    fixture.write(UNLOCK_FILE, '');

    expect(denied(edit('src/domain/scoring.ts'))).toBe(false);

    expect(recorded()).toEqual([]);
  });

  it.each(['Write', 'Edit'])('blocks the agent from writing the record with %s', (toolName) => {
    fixture.write(UNLOCK_FILE, '');

    expect(denied(edit(RECORD, toolName))).toBe(true);
  });

  it('blocks shell commands that touch the record', () => {
    const result = fixture.runHook(HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo src/domain/scoring.test.ts >> .claude/state/unlocked-edits' },
    });

    expect(denied(result)).toBe(true);
  });
});
