// UserPromptSubmit / Stop: the human unlocks approved tests by starting a
// message with "unlock tests" (any case), or "unlock tests: <paths>" for only
// those files. Only the start counts, because the event also fires on turns
// Claude Code starts itself, and those messages begin with a harness header.
// The main agent's Stop removes the marker, so an unlock lasts one turn.
import fs from 'node:fs';
import path from 'node:path';
import {
  UNLOCK_FILE,
  ensureStateDir,
  isTestFile,
  projectDir,
  readInput,
  relativeToProject,
  respond,
} from './lib.mjs';

const input = await readInput();
const dir = projectDir(input);
const marker = path.join(dir, UNLOCK_FILE);

if (input.hook_event_name === 'Stop') {
  fs.rmSync(marker, { force: true });
} else if (input.hook_event_name === 'UserPromptSubmit') {
  const text = input.prompt_text ?? input.prompt ?? '';
  const firstLine = text.trimStart().split(/\r?\n/)[0];
  const match = firstLine.match(/^unlock tests\b(.*)$/i);
  if (match) {
    const list = match[1].match(/^\s*:(.*)$/);
    const paths = list
      ? list[1]
          .split(/\s+/)
          .map((entry) => relativeToProject(dir, entry))
          .filter((rel) => rel && isTestFile(rel))
      : [];
    if (!list || paths.length > 0) {
      ensureStateDir(dir);
      fs.writeFileSync(marker, paths.map((rel) => `${rel}\n`).join(''));
      respond({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            `Tests unlocked for this turn by the human: ` +
            `${list ? paths.join(', ') : 'all approved tests'}.`,
        },
      });
    }
  }
}
