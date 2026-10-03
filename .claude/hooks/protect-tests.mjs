// PreToolUse: approved (committed) tests are the spec, so the agent may not
// change them to get green. The human lifts the block by creating
// .claude/state/tests-unlocked (unlock-tests.mjs does it when the human's
// message starts with "unlock tests"); the agent may not create that file.
// An edit allowed by the unlock is recorded, so the stop gate excuses the
// changed test only when it was changed this way; the agent may not write
// that record either.
import {
  UNLOCKED_EDITS_FILE,
  UNLOCK_FILE,
  deny,
  editedPath,
  isCommitted,
  isTestFile,
  isUnlocked,
  projectDir,
  readInput,
  readUnlockedEdits,
  relativeToProject,
  writeUnlockedEdits,
} from './lib.mjs';

const OFF_LIMITS = [UNLOCK_FILE, UNLOCKED_EDITS_FILE];
const offLimits = (file) => `Only the human unlocks tests; ${file} is off-limits for the agent.`;

const input = await readInput();
const dir = projectDir(input);

if (input.tool_name === 'Bash') {
  const command = input.tool_input?.command ?? '';
  const named = OFF_LIMITS.find((file) => command.includes(file.split('/').pop()));
  if (named) deny(offLimits(named));
} else {
  const rel = relativeToProject(dir, editedPath(input));
  if (OFF_LIMITS.includes(rel)) {
    deny(offLimits(rel));
  } else if (rel && isTestFile(rel) && isCommitted(dir, rel)) {
    if (!isUnlocked(dir, rel)) {
      deny(
        `${rel} is an approved test (committed in HEAD) and must not be changed to get green. ` +
          `If the test itself is wrong, stop, explain why and ask the human to start ` +
          `a message with "unlock tests: ${rel}".`,
      );
    } else {
      const recorded = readUnlockedEdits(dir);
      if (!recorded.includes(rel)) writeUnlockedEdits(dir, [...recorded, rel]);
    }
  }
}
