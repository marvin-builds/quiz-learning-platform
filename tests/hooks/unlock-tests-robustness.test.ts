/**
 * @jest-environment node
 */
import { Fixture, runHookInSession } from './fixture';

const HOOK = 'unlock-tests.mjs';
// UNLOCK_FILE from .claude/hooks/lib.mjs, which Jest can't import as ESM.
const MARKER = '.claude/state/tests-unlocked';

type Result = ReturnType<Fixture['runHook']>;

function submit(fixture: Fixture, text: string) {
  return fixture.runHook(HOOK, { hook_event_name: 'UserPromptSubmit', prompt_text: text });
}

function context(result: Result): string | undefined {
  return result.output?.hookSpecificOutput?.additionalContext;
}

function markerPaths(fixture: Fixture): string[] {
  return fixture.read(MARKER).split(/\s+/).filter(Boolean);
}

const LONG_NAME = `${'a'.repeat(300 - '.test.ts'.length)}.test.ts`;
const NUL_NAME = 'a\u0000.test.ts';

describe('unlock-tests hook robustness', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
    fixture.write('a.test.ts', 'a\n');
    fixture.write('b.test.ts', 'a\n');
    fixture.commitAll();
  });

  afterEach(() => {
    fixture.remove();
  });

  describe('odd path entries', () => {
    it.each([
      ['a 300-character file name', LONG_NAME],
      ['a name with a NUL byte', NUL_NAME],
    ])('ignores %s without crashing and removes an older unlock-all marker', (_label, entry) => {
      fixture.write(MARKER, '');

      const result = submit(fixture, `unlock tests: ${entry}`);

      expect(result.status).toBe(0);
      expect(fixture.exists(MARKER)).toBe(false);
      expect(context(result)).toMatch(/ignored/i);
      expect(context(result)).toContain('.test.ts');
      if (entry === LONG_NAME) expect(context(result)).toContain(LONG_NAME);
    });

    it.each([
      ['a 300-character file name', LONG_NAME],
      ['a name with a NUL byte', NUL_NAME],
    ])('still unlocks a valid entry listed next to %s', (_label, entry) => {
      fixture.write(MARKER, '');

      const result = submit(fixture, `unlock tests: ${entry} a.test.ts`);

      expect(result.status).toBe(0);
      expect(markerPaths(fixture)).toEqual(['a.test.ts']);
      expect(context(result)).toMatch(/ignored/i);
    });
  });

  describe('re-lock in the launch checkout', () => {
    let session: Fixture;

    beforeEach(() => {
      session = new Fixture({ nodeModules: false });
      session.write('a.test.ts', 'a\n');
      session.commitAll();
      session.write(MARKER, '');
      fixture.write(MARKER, '');
    });

    afterEach(() => {
      session.remove();
    });

    it('removes the marker in both the session work tree and the launch dir on a plain prompt', () => {
      const result = runHookInSession(
        HOOK,
        { hook_event_name: 'UserPromptSubmit', prompt_text: 'please continue' },
        { cwd: session.dir, launchDir: fixture.dir },
      );

      expect(result.status).toBe(0);
      expect(session.exists(MARKER)).toBe(false);
      expect(fixture.exists(MARKER)).toBe(false);
    });

    it('removes the marker in both the session work tree and the launch dir on SessionStart', () => {
      const result = runHookInSession(
        HOOK,
        { hook_event_name: 'SessionStart', source: 'startup' },
        { cwd: session.dir, launchDir: fixture.dir },
      );

      expect(result.status).toBe(0);
      expect(session.exists(MARKER)).toBe(false);
      expect(fixture.exists(MARKER)).toBe(false);
    });
  });

  describe('context wording', () => {
    it.each([
      ['all tests', 'unlock tests'],
      ['listed tests', 'unlock tests: a.test.ts'],
    ])('says an unlock of %s lasts until the next message, not for this turn', (_label, text) => {
      const result = submit(fixture, text);

      expect(context(result)).toMatch(/next message/i);
      expect(context(result)).not.toMatch(/this turn/i);
    });
  });
});
