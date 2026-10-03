// UserPromptSubmit / SessionStart: the human unlocks approved tests by
// starting a message with "unlock tests" (any case), or "unlock tests: <paths>"
// for only those files. Only the start counts, because the event also fires on
// turns Claude Code starts itself, and those messages begin with a harness
// header. Any other prompt, and a new session, locks again. Stop doesn't, so
// background agents and a blocked stop keep the unlock.
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

function lock() {
  fs.rmSync(marker, { force: true });
}

function tell(additionalContext) {
  respond({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });
}

function isExistingTest(rel) {
  return (
    Boolean(rel) &&
    isTestFile(rel) &&
    fs.statSync(path.join(dir, rel), { throwIfNoEntry: false })?.isFile()
  );
}

if (input.hook_event_name === 'SessionStart') {
  lock();
} else if (input.hook_event_name === 'UserPromptSubmit') {
  const text = input.prompt_text ?? input.prompt ?? '';
  const firstLine = text.trimStart().split(/\r?\n/)[0];
  const match = firstLine.match(/^unlock tests\b(.*)$/i);
  const list = match?.[1].match(/^\s*:(.*)$/);
  if (!match) {
    lock();
  } else if (!list) {
    ensureStateDir(dir);
    fs.writeFileSync(marker, '');
    tell('Tests unlocked for this turn by the human: all approved tests.');
  } else {
    const entries = list[1]
      .split(/\s+/)
      .map((entry) => entry.replace(/^[,;`]+|[,;`]+$/g, ''))
      .filter(Boolean);
    const unlocked = [];
    const ignored = [];
    for (const entry of entries) {
      const rel = relativeToProject(dir, entry);
      if (isExistingTest(rel)) unlocked.push(rel);
      else ignored.push(entry);
    }
    const ignoredNote = ignored.length
      ? ` Ignored (not an existing test file): ${ignored.join(', ')}.`
      : '';
    if (unlocked.length) {
      ensureStateDir(dir);
      fs.writeFileSync(marker, unlocked.map((rel) => `${rel}\n`).join(''));
      tell(`Tests unlocked for this turn by the human: ${unlocked.join(', ')}.${ignoredNote}`);
    } else {
      lock();
      if (ignored.length) tell(`Nothing unlocked, no tests were listed.${ignoredNote}`);
    }
  }
}
