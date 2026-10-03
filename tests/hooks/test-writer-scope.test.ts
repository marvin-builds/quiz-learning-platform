/**
 * @jest-environment node
 */
import { Fixture } from './fixture';

const HOOK = 'test-writer-scope.mjs';

describe('test-writer-scope hook (PreToolUse in the test-writer agent)', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = new Fixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  function write(relative: string) {
    return fixture.runHook(HOOK, {
      hook_event_name: 'PreToolUse',
      agent_type: 'test-writer',
      tool_name: 'Write',
      tool_input: { file_path: fixture.path(relative), content: 'x' },
    });
  }

  it.each([
    'src/__tests__/home-screen.test.tsx',
    'src/domain/__tests__/factories.ts',
    'src/domain/scoring.test.ts',
    'supabase/tests/database/quizzes.test.sql',
    'e2e/play-quiz.spec.ts',
  ])('allows writing the test file %s', (relative) => {
    const result = write(relative);

    expect(result.status).toBe(0);
    expect(result.output?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it.each([
    'src/domain/scoring.ts',
    'src/app/index.tsx',
    'supabase/migrations/20261003000000_quizzes.sql',
    'package.json',
  ])('blocks writing the non-test file %s', (relative) => {
    const result = write(relative);

    expect(result.status).toBe(0);
    expect(result.output?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.output?.hookSpecificOutput?.permissionDecisionReason).toMatch(/test files/i);
  });
});
