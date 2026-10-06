// UserPromptSubmit / SessionStart: the human unlocks approved tests by
// starting a message with "unlock tests" (any case), or "unlock tests: <paths>"
// for only those files. Only the start counts, because the event also fires on
// turns Claude Code starts itself, and those messages begin with a harness
// header. Such a turn (a subagent hand-back, a task notification) leaves the
// unlock as it is: it neither ends nor widens it. Any other prompt, so the
// human's next typed message, and a new session lock again. Stop doesn't, so
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
const text = input.prompt_text ?? input.prompt ?? '';

// Locks the session's work tree and the launch checkout, in case the session
// moved between them since the unlock.
function lock() {
  for (const root of new Set([dir, process.env.CLAUDE_PROJECT_DIR].filter(Boolean))) {
    fs.rmSync(path.join(root, UNLOCK_FILE), { force: true });
  }
}

function tell(additionalContext) {
  respond({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });
}

function isExistingTest(rel) {
  if (!rel || !isTestFile(rel)) return false;
  try {
    return fs.statSync(path.join(dir, rel)).isFile();
  } catch {
    // Missing, too long, a NUL byte: not a test file either way.
    return false;
  }
}

// The headers of turns Claude Code starts itself, line by line from the first,
// as they appear in real transcripts. Anything else, even a near miss, is
// treated as the human's message and locks.
const HARNESS_HEADERS = [
  // A subagent's hand-back.
  [
    /^Another Claude session sent a message:$/,
    /^<agent-message from="[0-9a-z]+">$/,
    /^\[Subagent hand-back\] /,
  ],
  // A background command or agent finished.
  [/^<task-notification>$/, /^<task-id>[0-9a-z]+<\/task-id>$/],
];

function isHarnessTurn(prompt) {
  const lines = prompt.split(/\r?\n/);
  return HARNESS_HEADERS.some((header) =>
    header.every((pattern, index) => pattern.test(lines[index] ?? '')),
  );
}

if (input.hook_event_name === 'SessionStart') {
  lock();
} else if (input.hook_event_name === 'UserPromptSubmit' && !isHarnessTurn(text)) {
  const firstLine = text.trimStart().split(/\r?\n/)[0];
  const match = firstLine.match(/^unlock tests\b(.*)$/i);
  const list = match?.[1].match(/^\s*:(.*)$/);
  // Lock first, so an unlock that fails half way never leaves an older one.
  lock();
  if (match && !list) {
    ensureStateDir(dir);
    fs.writeFileSync(marker, '');
    tell('Tests unlocked by the human until their next message: all approved tests.');
  } else if (list) {
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
      tell(
        `Tests unlocked by the human until their next message: ${unlocked.join(', ')}.${ignoredNote}`,
      );
    } else if (ignored.length) {
      tell(`Nothing unlocked, no tests were listed.${ignoredNote}`);
    }
  }
}
