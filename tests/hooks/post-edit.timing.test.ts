/**
 * @jest-environment node
 *
 * Runs on its own (`npm run test:timing`), never next to the parallel suite,
 * whose load would make the duration flaky. */
import { REPO_ROOT, runHook } from './fixture';
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

describe('post-edit hook on this repo', () => {
  it('takes under 5 seconds for a source file once the typecheck cache is warm', () => {
    const file = path.join(REPO_ROOT, 'src', 'app', 'index.tsx');
    runHook(HOOK, edited(file), REPO_ROOT);

    // The fastest of a few runs: load from other processes slows some runs,
    // a slower hook slows all of them.
    const results = [1, 2, 3].map(() => runHook(HOOK, edited(file), REPO_ROOT));

    for (const result of results) expect(result.output).toBeUndefined();
    expect(Math.min(...results.map((result) => result.durationMs))).toBeLessThan(5_000);
  });
});
