/**
 * @jest-environment node
 */
import { Fixture, REPO_ROOT, runHook, writeTypeScriptProject } from './fixture';
import path from 'node:path';

jest.setTimeout(60_000);

const HOOK = 'post-edit.mjs';

function edited(filePath: string) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath },
    tool_response: { filePath, success: true },
  };
}

describe('post-edit hook (PostToolUse)', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
    writeTypeScriptProject(fixture);
    fixture.commitAll();
  });

  afterEach(() => {
    fixture.remove();
  });

  it('feeds a type error back to the agent in the same turn', () => {
    const file = fixture.write('src/score.ts', "export const score: number = 'ten';\n");

    const result = fixture.runHook(HOOK, edited(file));

    expect(result.status).toBe(0);
    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/score.ts');
    expect(result.output?.reason).toContain('TS2322');
  });

  it('stays silent when the edited file is clean', () => {
    const file = fixture.write('src/score.ts', 'export const score = 10;\n');

    const result = fixture.runHook(HOOK, edited(file));

    expect(result.status).toBe(0);
    expect(result.output).toBeUndefined();
  });

  it('applies lint fixes to the edited file', () => {
    const file = fixture.write('src/score.ts', 'let score = 10;\nexport { score };\n');

    const result = fixture.runHook(HOOK, edited(file));

    expect(result.output).toBeUndefined();
    expect(fixture.read('src/score.ts')).toContain('const score = 10;');
  });

  it('feeds lint errors that cannot be fixed back to the agent', () => {
    const file = fixture.write('src/score.ts', 'debugger;\nexport const score = 10;\n');

    const result = fixture.runHook(HOOK, edited(file));

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('no-debugger');
  });

  it('formats other files with Prettier', () => {
    const file = fixture.write('data/settings.json', '{"a":1}');

    const result = fixture.runHook(HOOK, edited(file));

    expect(result.output).toBeUndefined();
    expect(fixture.read('data/settings.json')).toBe('{ "a": 1 }\n');
  });

  it('resets the database and runs pgTAP after a migration edit', () => {
    const file = fixture.write('supabase/migrations/20261003000000_quizzes.sql', 'select 1;\n');

    const result = fixture.runHook(HOOK, edited(file));

    expect(fixture.supabaseCalls()).toEqual(['db reset', 'test db']);
    expect(result.output).toBeUndefined();
  });

  it('feeds pgTAP failures after a migration edit back to the agent', () => {
    const file = fixture.write('supabase/migrations/20261003000000_quizzes.sql', 'select 1;\n');

    const result = fixture.runHook(HOOK, edited(file), {
      FAKE_PGTAP_FAILURE: 'not ok 3 - anon cannot read answers.is_correct',
    });

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('not ok 3 - anon cannot read answers.is_correct');
  });

  it('ignores files outside the project', () => {
    const result = fixture.runHook(HOOK, edited('/etc/hosts'));

    expect(result.status).toBe(0);
    expect(result.output).toBeUndefined();
    expect(fixture.supabaseCalls()).toEqual([]);
  });
});

describe('post-edit hook on this repo', () => {
  it('takes under 5 seconds for a source file once the typecheck cache is warm', () => {
    const file = path.join(REPO_ROOT, 'src', 'app', 'index.tsx');
    runHook(HOOK, edited(file), REPO_ROOT);

    const result = runHook(HOOK, edited(file), REPO_ROOT);

    expect(result.output).toBeUndefined();
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
