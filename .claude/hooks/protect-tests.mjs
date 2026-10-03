// PreToolUse: approved (committed) tests are the spec, so the agent may not
// change them to get green. The human lifts the block by creating
// .claude/state/tests-unlocked (unlock-tests.mjs does it when the human's
// message starts with "unlock tests"); the agent may not create that file.
import {
  UNLOCK_FILE,
  deny,
  editedPath,
  isCommitted,
  isTestFile,
  isUnlocked,
  projectDir,
  readInput,
  relativeToProject,
} from './lib.mjs';

const input = await readInput();
const dir = projectDir(input);

if (input.tool_name === 'Bash') {
  if ((input.tool_input?.command ?? '').includes('tests-unlocked')) {
    deny(`Only the human unlocks tests; ${UNLOCK_FILE} is off-limits for the agent.`);
  }
} else {
  const rel = relativeToProject(dir, editedPath(input));
  if (rel === UNLOCK_FILE) {
    deny(`Only the human unlocks tests; ${UNLOCK_FILE} is off-limits for the agent.`);
  } else if (rel && isTestFile(rel) && !isUnlocked(dir, rel) && isCommitted(dir, rel)) {
    deny(
      `${rel} is an approved test (committed in HEAD) and must not be changed to get green. ` +
        `If the test itself is wrong, stop and explain why; the human can create ` +
        `${UNLOCK_FILE} to allow the change.`,
    );
  }
}
