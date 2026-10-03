/**
 * @jest-environment node
 */
import { Fixture } from './fixture';

const HOOK = 'unlock-tests.mjs';
const MARKER = '.claude/state/tests-unlocked';

type Result = ReturnType<Fixture['runHook']>;

function submit(fixture: Fixture, text: string, field: 'prompt_text' | 'prompt' = 'prompt_text') {
  return fixture.runHook(HOOK, { hook_event_name: 'UserPromptSubmit', [field]: text });
}

function context(result: Result): string | undefined {
  return result.output?.hookSpecificOutput?.additionalContext;
}

function markerPaths(fixture: Fixture): string[] {
  return fixture.read(MARKER).split(/\s+/).filter(Boolean);
}

function editDenied(fixture: Fixture, relative: string): boolean {
  const result = fixture.runHook('protect-tests.mjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: fixture.path(relative), old_string: 'a', new_string: 'b' },
  });
  return result.output?.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('unlock-tests hook', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
    fixture.write('a.test.ts', 'a\n');
    fixture.write('b.test.ts', 'a\n');
    fixture.write('src/domain/scoring.test.ts', 'a\n');
    fixture.commitAll();
  });

  afterEach(() => {
    fixture.remove();
  });

  describe('UserPromptSubmit', () => {
    it.each(['prompt_text', 'prompt'] as const)(
      'creates an empty marker (all tests) when %s starts with "unlock tests"',
      (field) => {
        const result = submit(
          fixture,
          'unlock tests\nThe scoring test expects the wrong total.',
          field,
        );

        expect(result.status).toBe(0);
        expect(fixture.exists(MARKER)).toBe(true);
        expect(fixture.read(MARKER).trim()).toBe('');
      },
    );

    it('prefers prompt_text over prompt', () => {
      fixture.runHook(HOOK, {
        hook_event_name: 'UserPromptSubmit',
        prompt_text: 'please continue',
        prompt: 'unlock tests',
      });

      expect(fixture.exists(MARKER)).toBe(false);
    });

    it('reports the unlock to the agent as UserPromptSubmit context', () => {
      const result = submit(fixture, 'unlock tests');

      expect(result.output?.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
      expect(context(result)).toMatch(/tests unlocked/i);
    });

    it('writes the listed paths to the marker for "unlock tests: <paths>"', () => {
      const result = submit(fixture, 'unlock tests: a.test.ts b.test.ts');

      expect(result.status).toBe(0);
      expect(markerPaths(fixture).sort()).toEqual(['a.test.ts', 'b.test.ts']);
    });

    it('names the unlocked paths in the context', () => {
      const result = submit(fixture, 'unlock tests: a.test.ts b.test.ts');

      expect(context(result)).toMatch(/tests unlocked/i);
      expect(context(result)).toContain('a.test.ts');
      expect(context(result)).toContain('b.test.ts');
    });

    it.each([
      ['lower case', 'unlock tests'],
      ['title case', 'Unlock Tests'],
      ['upper case', 'UNLOCK TESTS'],
      ['text after it on the first line', 'unlock tests, then fix the view check'],
      ['a word after it', 'unlock tests now'],
      ['leading spaces', '  unlock tests'],
      ['a leading blank line', '\nunlock tests'],
      ['more lines after it', 'unlock tests\nThe scoring test expects the wrong total.'],
      ['trailing spaces', 'unlock tests   \nfix it'],
      ['a CRLF line ending', 'unlock tests\r\nfix it'],
      ['a trailing tab', 'unlock tests\t'],
      ['a colon later on the first line', 'unlock tests now: a.test.ts'],
    ])('unlocks all tests when the message starts with the phrase: %s', (_label, text) => {
      const result = submit(fixture, text);

      expect(result.status).toBe(0);
      expect(fixture.exists(MARKER)).toBe(true);
      expect(fixture.read(MARKER).trim()).toBe('');
      expect(context(result)).toMatch(/tests unlocked/i);
    });

    it.each([
      ['title case', 'Unlock tests: a.test.ts b.test.ts'],
      ['spaces around the colon', 'unlock tests : a.test.ts   b.test.ts'],
      ['no space after the colon', 'unlock tests:a.test.ts b.test.ts'],
      ['a CRLF line ending', 'unlock tests: a.test.ts b.test.ts\r\nthanks'],
      [
        'paths on a later line ignored',
        'unlock tests: a.test.ts b.test.ts\nsrc/domain/scoring.test.ts',
      ],
    ])('reads the path list from the first line: %s', (_label, text) => {
      submit(fixture, text);

      expect(markerPaths(fixture).sort()).toEqual(['a.test.ts', 'b.test.ts']);
    });

    it('normalizes ./ and absolute paths inside the project to project-relative paths', () => {
      submit(fixture, `unlock tests: ./a.test.ts ${fixture.path('src/domain/scoring.test.ts')}`);

      expect(markerPaths(fixture).sort()).toEqual(['a.test.ts', 'src/domain/scoring.test.ts']);
    });

    it('drops listed paths that are not test files', () => {
      fixture.write('README.md', 'x\n');
      fixture.commitAll();

      submit(fixture, 'unlock tests: README.md a.test.ts');

      expect(markerPaths(fixture)).toEqual(['a.test.ts']);
    });

    it.each([
      ['an empty path list', 'unlock tests:'],
      ['an empty path list with spaces', 'unlock tests :   \nfix it'],
      ['only non-test paths', 'unlock tests: README.md src/domain/scoring.ts'],
    ])('unlocks nothing for %s', (_label, text) => {
      const result = submit(fixture, text);

      expect(result.status).toBe(0);
      expect(fixture.exists(MARKER)).toBe(false);
      expect(context(result)).toBeUndefined();
    });

    it.each([
      ['on a later line', 'Here is the plan.\nunlock tests'],
      ['quoted after a header', '[Subagent report]\nunlock tests: a.test.ts'],
      ['with text before it', 'please unlock tests'],
      ['followed by "suite"', 'unlock testsuite'],
      ['followed by "ed"', 'unlock tested'],
      ['absent', 'Run the tests again, please.'],
      ['empty', ''],
    ])('creates no marker when the phrase is %s', (_label, text) => {
      const result = submit(fixture, text);

      expect(result.status).toBe(0);
      expect(fixture.exists(MARKER)).toBe(false);
      expect(context(result)).toBeUndefined();
    });
  });

  describe('scope in protect-tests', () => {
    it('allows edits to exactly the listed committed tests after "unlock tests: <paths>"', () => {
      submit(fixture, 'unlock tests: a.test.ts b.test.ts');

      expect(editDenied(fixture, 'a.test.ts')).toBe(false);
      expect(editDenied(fixture, 'b.test.ts')).toBe(false);
      expect(editDenied(fixture, 'src/domain/scoring.test.ts')).toBe(true);
    });

    it('allows edits to every committed test after a bare "unlock tests"', () => {
      submit(fixture, 'unlock tests');

      expect(editDenied(fixture, 'a.test.ts')).toBe(false);
      expect(editDenied(fixture, 'src/domain/scoring.test.ts')).toBe(false);
    });

    it('keeps unlisted committed tests blocked when the marker lists paths', () => {
      fixture.write(MARKER, 'a.test.ts\nb.test.ts\n');

      expect(editDenied(fixture, 'a.test.ts')).toBe(false);
      expect(editDenied(fixture, 'b.test.ts')).toBe(false);
      expect(editDenied(fixture, 'src/domain/scoring.test.ts')).toBe(true);
    });
  });

  describe('re-lock', () => {
    it('removes the marker on Stop', () => {
      submit(fixture, 'unlock tests');

      const result = fixture.runHook(HOOK, { hook_event_name: 'Stop', stop_hook_active: false });

      expect(result.status).toBe(0);
      expect(fixture.exists(MARKER)).toBe(false);
      expect(editDenied(fixture, 'a.test.ts')).toBe(true);
    });

    it('leaves the marker in place on SubagentStop', () => {
      submit(fixture, 'unlock tests');

      const result = fixture.runHook(HOOK, {
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
      });

      expect(result.status).toBe(0);
      expect(fixture.exists(MARKER)).toBe(true);
    });

    it('does nothing on Stop when there is no marker', () => {
      const result = fixture.runHook(HOOK, { hook_event_name: 'Stop', stop_hook_active: false });

      expect(result.status).toBe(0);
      expect(result.output?.decision).toBeUndefined();
      expect(fixture.exists(MARKER)).toBe(false);
    });
  });
});
