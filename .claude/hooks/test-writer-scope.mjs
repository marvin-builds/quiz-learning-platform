// PreToolUse in the test-writer agent: it writes tests, never the code that
// makes them pass, so tests can't be shaped around an implementation.
import { deny, editedPath, isTestFile, projectDir, readInput, relativeToProject } from './lib.mjs';

const input = await readInput();
const filePath = editedPath(input);
const rel = relativeToProject(projectDir(input), filePath);

if (filePath && !(rel && isTestFile(rel))) {
  deny(
    `The test-writer may only write test files (__tests__/, *.test.*, *.spec.*, ` +
      `supabase/tests/, e2e/), not ${rel ?? filePath}.`,
  );
}
