// Shared helpers for the hook scripts. Every hook reads its event as JSON on
// stdin, reports through JSON on stdout and exits 0; a non-zero exit is a
// crash, never a decision.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const STATE_DIR = '.claude/state';

// Feedback longer than this is cut, so a flood of errors doesn't fill the
// agent's context; the first errors are the ones to fix anyway.
const MAX_FEEDBACK = 6000;

export async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

/**
 * The work tree the session works in: the git top level of the event's cwd.
 * CLAUDE_PROJECT_DIR stays the launch directory when a session moves into
 * another worktree, so it is only the fallback, as is the process directory.
 */
export function projectDir(input) {
  if (input.cwd) {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: input.cwd,
      encoding: 'utf8',
    });
    if (top.status === 0 && top.stdout.trim()) return top.stdout.trim();
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** The git top level of the repo that contains `dir`, or undefined. */
function gitTopLevel(dir) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : undefined;
}

/**
 * The work tree of the edited file: a workflow agent keeps the orchestrator's
 * checkout as cwd and edits a slice worktree by absolute path. The nearest
 * existing directory decides, since a new test may open a new directory.
 * Without an edited file, or outside any repo, it is projectDir().
 */
export function editedWorkTree(input) {
  const filePath = editedPath(input);
  if (filePath) {
    let dir = path.dirname(path.resolve(input.cwd ?? process.cwd(), filePath));
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const top = gitTopLevel(dir);
    if (top) return top;
  }
  return projectDir(input);
}

const SLICE_MARKER = /^\s*Slice worktree: (.+?)\s*$/m;
// The Workflow tool's agents start with two harness entries: the human's
// request, relayed, then the script's prompt, each line indented.
const RELAYED_REQUEST = '[Workflow harness — user request]';
const COMPUTED_TASK = '[Workflow harness — computed task]';

function entryText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * The work tree named by a `Slice worktree: <absolute path>` line in the
 * agent's task: its first user entry, or for a workflow agent the computed
 * task that follows the relayed request. The orchestrator's workflow puts the
 * line at the top of every agent prompt. Undefined when the transcript can't
 * be read, names nothing, or names no git repo; the relayed request and later
 * entries never count, so neither the human's words nor a quoted marker can
 * redirect the check.
 */
export function markedWorkTree(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return undefined;
  }
  let relayed = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (entry.type !== 'user') continue;
    const text = entryText(entry.message?.content);
    if (!relayed && text.startsWith(RELAYED_REQUEST)) {
      relayed = true;
      continue;
    }
    if (relayed && !text.startsWith(COMPUTED_TASK)) return undefined;
    const named = text.match(SLICE_MARKER)?.[1];
    if (!named || !path.isAbsolute(named) || !fs.existsSync(named)) return undefined;
    return gitTopLevel(named);
  }
  return undefined;
}

/** The path relative to the project, or undefined when it lies outside. */
export function relativeToProject(dir, filePath) {
  if (!filePath) return undefined;
  const rel = path.relative(dir, path.resolve(dir, filePath)).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return undefined;
  return rel;
}

export function editedPath(input) {
  return input.tool_input?.file_path ?? input.tool_input?.notebook_path;
}

const TEST_PATTERNS = [
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[^/]+$/,
  /^supabase\/tests\//,
  /^e2e\//,
  /^tests\//,
];

export function isTestFile(rel) {
  return TEST_PATTERNS.some((pattern) => pattern.test(rel));
}

/** Committed tests count as approved: they passed gate 1. */
export function isCommitted(dir, rel) {
  return spawnSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: dir }).status === 0;
}

/**
 * True when the file on disk, which is what Jest and tsc read, differs in
 * content from `HEAD`. Whitespace and the file mode don't count, and neither
 * does the index: they change no test, so they must not excuse a red one.
 */
export function hasUncommittedChanges(dir, rel) {
  const committed = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: dir, encoding: 'utf8' });
  if (committed.status !== 0) return false;
  let current;
  try {
    current = fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return false;
  }
  const content = (text) => text.replace(/\s+/g, '');
  return content(committed.stdout) !== content(current);
}

export function bin(dir, name) {
  return path.join(dir, 'node_modules', '.bin', name);
}

/**
 * Runs a command and resolves with its exit code and combined output. A
 * command that can't be started resolves with `setup: true` and a message
 * that names the directory, since that is not a test or type failure.
 */
export function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, FORCE_COLOR: '0' } });
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    child.on('error', (error) =>
      resolve({
        code: 1,
        setup: true,
        output:
          `Setup problem: ${path.basename(command)} could not be started in ${cwd} ` +
          `(${error.message}). Run npm ci there.`,
      }),
    );
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** A failed run as feedback: setup problems as they are, others under a label. */
export function failure(label, result) {
  return result.setup ? result.output : `${label}:\n${result.output.trim()}`;
}

export function truncate(text) {
  return text.length > MAX_FEEDBACK
    ? `${text.slice(0, MAX_FEEDBACK)}\n… (${text.length - MAX_FEEDBACK} more characters cut)`
    : text;
}

export function respond(output) {
  process.stdout.write(JSON.stringify(output));
}

export function deny(reason) {
  respond({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

export function block(reason) {
  respond({ decision: 'block', reason: truncate(reason) });
}

export function ensureStateDir(dir) {
  fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
}

/** Errors from `tsc --pretty false`, each with the file it points at, if any. */
export function parseTscErrors(output) {
  return output
    .split('\n')
    .filter((line) => /error TS\d+/.test(line))
    .map((line) => ({ line, file: line.match(/^(.+?)\(\d+,\d+\): error/)?.[1] }));
}

export function tscArgs(dir) {
  return [
    '--noEmit',
    '--pretty',
    'false',
    '--incremental',
    '--tsBuildInfoFile',
    path.join(dir, STATE_DIR, 'tsbuildinfo'),
  ];
}
