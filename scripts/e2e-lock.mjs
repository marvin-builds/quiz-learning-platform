#!/usr/bin/env node
// Runs a command while holding the machine-wide e2e lock, so parallel slices
// never run their e2e tests (the CPU peak) at the same time.
//
//   node scripts/e2e-lock.mjs <command> [args…]
//
// The lock is `.claude/state/e2e.lock` in the main checkout, shared by all of
// its worktrees: JSON with the holder's pid, its cwd and when it started. A
// live holder is waited for; a dead one's lock is taken over. The command's
// exit code is passed on, and the lock is removed when it ends.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const POLL_MS = 500;

function mainCheckout() {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`not in a git repository:\n${result.stderr}`);
  return path.dirname(result.stdout.trim());
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function holder(lock) {
  try {
    return JSON.parse(fs.readFileSync(lock, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock if it is free: the content is written to a file of our own
 * first and then hard-linked into place, which fails when the lock exists, so
 * two starters never both win and nobody reads a half-written lock.
 */
function tryLock(lock) {
  const mine = `${lock}.${process.pid}`;
  fs.writeFileSync(
    mine,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), started: new Date().toISOString() }),
  );
  try {
    fs.linkSync(mine, lock);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

async function acquire(lock) {
  let waiting = false;
  for (;;) {
    if (tryLock(lock)) return;
    const held = holder(lock);
    if (!held || !alive(held.pid)) {
      // A dead holder's lock (or an unreadable one): take it over.
      if (holder(lock)?.pid === held?.pid) fs.rmSync(lock, { force: true });
      continue;
    }
    if (!waiting) {
      console.error(`e2e lock held by pid ${held.pid} in ${held.cwd}; waiting …`);
      waiting = true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function main([command, ...args]) {
  if (!command) {
    console.error('usage: node scripts/e2e-lock.mjs <command> [args…]');
    return 1;
  }
  const lock = path.join(mainCheckout(), '.claude', 'state', 'e2e.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  await acquire(lock);
  const release = () => {
    if (holder(lock)?.pid === process.pid) fs.rmSync(lock, { force: true });
  };
  process.on('exit', release);
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  return new Promise((resolve) => {
    child.on('error', (error) => {
      console.error(`${command} could not be started: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
