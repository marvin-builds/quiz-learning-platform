// Shared helpers for the hook scripts. Every hook reads its event as JSON on
// stdin, reports through JSON on stdout and exits 0; a non-zero exit is a
// crash, never a decision.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const STATE_DIR = '.claude/state';
export const UNLOCK_FILE = `${STATE_DIR}/tests-unlocked`;

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

/**
 * Whether the human unlocked this test: no marker means locked, an empty
 * marker unlocks every test, otherwise only the paths it lists.
 */
export function isUnlocked(dir, rel) {
  let content;
  try {
    content = fs.readFileSync(path.join(dir, UNLOCK_FILE), 'utf8');
  } catch {
    return false;
  }
  const paths = content.split(/\s+/).filter(Boolean);
  return paths.length === 0 || paths.includes(rel);
}

/** Committed tests count as approved: they passed gate 1. */
export function isCommitted(dir, rel) {
  return spawnSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: dir }).status === 0;
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
