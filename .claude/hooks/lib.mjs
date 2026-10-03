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

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
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

export function bin(dir, name) {
  return path.join(dir, 'node_modules', '.bin', name);
}

/** Runs a command and resolves with its exit code and combined output. */
export function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, FORCE_COLOR: '0' } });
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    child.on('error', (error) => resolve({ code: 1, output: String(error) }));
    child.on('close', (code) => resolve({ code, output }));
  });
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
