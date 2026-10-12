/**
 * @jest-environment node
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const SCRIPT = path.join(process.cwd(), 'scripts', 'e2e-lock.mjs');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

// The locked command: records when it ran, its parent pid (the lock script)
// and the lock file as it saw it, prints a marker and exits with the code it
// is given.
const COMMAND = `
const fs = require('fs');
const [record, lock, code] = process.argv.slice(1);
fs.writeFileSync(record, JSON.stringify({
  at: Date.now(),
  ppid: process.ppid,
  lock: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null,
}));
process.stdout.write('locked command ran\\n');
process.exit(Number(code));
`;

// For the race: logs when it started and ended around a 300 ms sleep.
const SLEEPER = `
const fs = require('fs');
const [log, tag] = process.argv.slice(1);
const start = Date.now();
setTimeout(() => {
  fs.appendFileSync(log, JSON.stringify({ tag, start, end: Date.now() }) + '\\n');
}, 300);
`;

type Record = { at: number; ppid: number; lock: string | null };

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lock-')));
  readonly app = path.join(this.root, 'app');
  readonly worktree = path.join(this.root, 'app.worktrees', '17-orchestrator');
  readonly lock = path.join(this.app, '.claude', 'state', 'e2e.lock');
  readonly record = path.join(this.root, 'record.json');
  readonly intervals = path.join(this.root, 'intervals.jsonl');
  private readonly children: ChildProcess[] = [];

  constructor() {
    this.git(this.root, 'init', '-q', '-b', 'main', this.app);
    this.git(
      this.app,
      '-c',
      'user.email=f@example.com',
      '-c',
      'user.name=F',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'Initial',
    );
    this.git(this.app, 'worktree', 'add', '-q', '-b', '17-orchestrator', this.worktree);
  }

  git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  args(code = 0): string[] {
    return [SCRIPT, process.execPath, '-e', COMMAND, this.record, this.lock, String(code)];
  }

  run(cwd: string, code = 0) {
    return spawnSync('node', this.args(code), { cwd, encoding: 'utf8', timeout: 20_000 });
  }

  /** Runs without blocking the test, so the test can release a held lock meanwhile. */
  start(cwd: string, args = this.args(0)) {
    const child = spawn('node', args, { cwd });
    this.children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.resume();
    const done = new Promise<{ status: number | null; stderr: string }>((resolve) =>
      child.on('close', (status) => resolve({ status, stderr })),
    );
    return { done, stderr: () => stderr };
  }

  ran(): Record | null {
    return fs.existsSync(this.record) ? JSON.parse(fs.readFileSync(this.record, 'utf8')) : null;
  }

  hold(pid: number, cwd: string) {
    fs.mkdirSync(path.dirname(this.lock), { recursive: true });
    fs.writeFileSync(this.lock, JSON.stringify({ pid, cwd }));
  }

  sleeper(tag: string): string[] {
    return [SCRIPT, process.execPath, '-e', SLEEPER, this.intervals, tag];
  }

  remove() {
    for (const child of this.children) child.kill();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const HOLDER = '/home/dev/other.worktrees/12-other-slice';

/** Polls until `condition` holds, failing after `ms` with `what`. */
async function until(condition: () => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('e2e lock', () => {
  let box: Sandbox;

  beforeEach(() => {
    box = new Sandbox();
  });

  afterEach(() => box.remove());

  it('runs the command while holding the lock file of the main checkout', () => {
    const result = box.run(box.app);

    expect(result.status).toBe(0);
    const ran = box.ran();
    expect(ran).not.toBeNull();
    expect(JSON.parse(ran!.lock!)).toEqual(
      expect.objectContaining({ pid: ran!.ppid, cwd: box.app }),
    );
  });

  it('uses the main checkout lock file when run from a linked worktree', () => {
    const result = box.run(box.worktree);

    expect(result.status).toBe(0);
    expect(JSON.parse(box.ran()!.lock!)).toEqual(expect.objectContaining({ cwd: box.worktree }));
    expect(fs.existsSync(path.join(box.worktree, '.claude', 'state', 'e2e.lock'))).toBe(false);
  });

  it("passes the command's output through", () => {
    const result = box.run(box.app);

    expect(result.stdout).toContain('locked command ran');
  });

  it('removes the lock when the command ends', () => {
    box.run(box.app);

    expect(box.ran()?.lock).toEqual(expect.any(String));
    expect(fs.existsSync(box.lock)).toBe(false);
  });

  it("exits with the command's non-zero exit code and still removes the lock", () => {
    const result = box.run(box.app, 3);

    expect(box.ran()).not.toBeNull();
    expect(result.status).toBe(3);
    expect(fs.existsSync(box.lock)).toBe(false);
  });

  it('waits for a lock held by a live process and runs once it is released', async () => {
    box.hold(process.pid, HOLDER);

    const run = box.start(box.app);
    await until(() => run.stderr().includes(HOLDER), 'the lock script reports that it waits');
    expect(box.ran()).toBeNull();
    const released = Date.now();
    fs.rmSync(box.lock);
    const { status } = await run.done;

    expect(status).toBe(0);
    expect(box.ran()!.at).toBeGreaterThanOrEqual(released);
  });

  it('names the holder of the lock while it waits', async () => {
    box.hold(process.pid, HOLDER);

    const run = box.start(box.app);
    await until(() => run.stderr().includes(HOLDER), 'stderr names the holder');
    fs.rmSync(box.lock);
    await run.done;

    expect(run.stderr()).toContain(HOLDER);
  });

  it('lets only one of two concurrent runs hold the lock at a time', async () => {
    const first = box.start(box.app, box.sleeper('first'));
    const second = box.start(box.worktree, box.sleeper('second'));
    const results = await Promise.all([first.done, second.done]);

    expect(results.map((r) => r.status)).toEqual([0, 0]);
    const [a, b] = fs
      .readFileSync(box.intervals, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { start: number; end: number })
      .sort((x, y) => x.start - y.start);
    expect(b.start).toBeGreaterThanOrEqual(a.end);
  });

  it('takes over a lock left by a dead process', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    box.hold(dead, '/home/dev/other.worktrees/12-other-slice');

    const result = box.run(box.app);

    expect(result.status).toBe(0);
    const ran = box.ran();
    expect(ran).not.toBeNull();
    expect(JSON.parse(ran!.lock!)).toEqual(
      expect.objectContaining({ pid: ran!.ppid, cwd: box.app }),
    );
  });

  it('wraps the test:e2e script', () => {
    expect(PACKAGE.scripts['test:e2e']).toBe('node scripts/e2e-lock.mjs playwright test');
  });
});
