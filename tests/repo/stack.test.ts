/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const STACK = path.join(process.cwd(), 'scripts', 'stack.mjs');
const REAL_CONFIG = fs.readFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'utf8');

type PortKey = { name: string; port: number };

// Every uncommented `port` or `*_port` key outside [remotes.*], named the way
// the Supabase CLI reads overrides from the environment.
function portKeys(toml: string): PortKey[] {
  const keys: PortKey[] = [];
  let section = '';
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[([^\]]+)\]/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!section || section === 'remotes' || section.startsWith('remotes.')) continue;
    const key = line.match(/^([a-z0-9_]*_port|port)\s*=\s*(\d+)/);
    if (key) {
      const prefix = section.replace(/[.-]/g, '_').toUpperCase();
      keys.push({ name: `SUPABASE_${prefix}_${key[1].toUpperCase()}`, port: Number(key[2]) });
    }
  }
  return keys;
}

function parseEnv(content: string): Map<string, string[]> {
  const env = new Map<string, string[]>();
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match)
      env.set(match[1], [...(env.get(match[1]) ?? []), match[2].replace(/^"(.*)"$/, '$1')]);
  }
  return env;
}

const single = (env: Map<string, string[]>, key: string) => {
  expect(env.get(key)).toHaveLength(1);
  return env.get(key)![0];
};

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * The slots (k >= 1) whose config.toml ports are all free on this machine,
 * lowest first, so the expectations hold even while real worktree stacks are
 * running. On an idle machine this is [1, 2, 3, ...]. Only the config.toml
 * ports count; QUIZ_E2E_PORT is not probed.
 */
async function freeSlots(defaults: number[], count: number): Promise<number[]> {
  const slots: number[] = [];
  for (let k = 1; slots.length < count && k < 60; k += 1) {
    const free = await Promise.all(defaults.map((port) => portFree(port + 100 * k)));
    if (free.every(Boolean)) slots.push(k);
  }
  if (slots.length < count) throw new Error('not enough free port slots on this machine');
  return slots;
}

/** The lowest slot whose config.toml ports are free, leaving out `excluded`. */
async function lowestFreeSlot(defaults: number[], excluded: number[] = []): Promise<number> {
  const slots = await freeSlots(defaults, excluded.length + 1);
  return slots.find((k) => !excluded.includes(k))!;
}

/**
 * Other test files and other worktrees probe the same ports at the same time,
 * so a slot can change hands while a test runs. The chosen slot must be at
 * least 1, none of the `excluded` (claimed or held) slots, and the lowest free
 * slot according to a probe taken before or one taken after the run.
 */
async function expectLowestFreeSlot(
  actual: number,
  before: number,
  defaults: number[],
  excluded: number[] = [],
) {
  expect(Number.isInteger(actual)).toBe(true);
  expect(actual).toBeGreaterThanOrEqual(1);
  for (const slot of excluded) expect(actual).not.toBe(slot);
  if (actual !== before) {
    expect(actual).toBe(await lowestFreeSlot(defaults, excluded));
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds a port, retrying a few times while a concurrent probe has it open. */
async function listen(port: number): Promise<net.Server> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await new Promise<net.Server>((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 10) throw error;
      await delay(50 * attempt);
    }
  }
}

class Repo {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-')));
  readonly main = path.join(this.root, 'app');
  private branches = 0;

  /** `config: null` stands for a repo without supabase/config.toml. */
  constructor(readonly config: string | null = REAL_CONFIG) {
    fs.mkdirSync(path.join(this.main, 'supabase'), { recursive: true });
    this.git(this.main, 'init', '-q', '-b', 'main');
    this.git(this.main, 'config', 'user.email', 'fixture@example.com');
    this.git(this.main, 'config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(this.main, '.gitignore'), '.env*.local\n');
    if (config === null) fs.writeFileSync(path.join(this.main, 'supabase', '.gitkeep'), '');
    else fs.writeFileSync(path.join(this.main, 'supabase', 'config.toml'), config);
    this.git(this.main, 'add', '-A');
    this.git(this.main, 'commit', '-q', '-m', 'Initial commit');
  }

  git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  addWorktree(name: string): string {
    const dir = path.join(this.root, 'app.worktrees', name);
    this.branches += 1;
    this.git(this.main, 'worktree', 'add', '-q', '-b', `branch-${this.branches}`, dir);
    return dir;
  }

  stack(dir: string, { cwd = this.root, args = [dir] }: { cwd?: string; args?: string[] } = {}) {
    const result = spawnSync('node', [STACK, ...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`stack.mjs exited with ${result.status}: ${result.stderr}`);
    }
    return result;
  }

  supabaseEnv(dir: string): Map<string, string[]> {
    return parseEnv(fs.readFileSync(path.join(dir, 'supabase', '.env.local'), 'utf8'));
  }

  rootEnv(dir: string): Map<string, string[]> {
    return parseEnv(fs.readFileSync(path.join(dir, '.env.local'), 'utf8'));
  }

  /** The slot k a worktree got, read from its API port. */
  slot(dir: string): number {
    const api = Number(single(this.supabaseEnv(dir), 'SUPABASE_API_PORT'));
    return (api - 54321) / 100;
  }

  remove() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const DEFAULT_PORTS = portKeys(REAL_CONFIG).map((key) => key.port);

describe('scripts/stack.mjs', () => {
  let repo: Repo;

  afterEach(() => repo?.remove());

  it('finds the ports in the real config.toml, so the checks below cannot pass vacuously', () => {
    const names = portKeys(REAL_CONFIG).map((key) => key.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'SUPABASE_API_PORT',
        'SUPABASE_DB_PORT',
        'SUPABASE_DB_SHADOW_PORT',
        'SUPABASE_DB_POOLER_PORT',
        'SUPABASE_STUDIO_PORT',
        'SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT',
      ]),
    );
  });

  it('leaves the main checkout on the default ports and writes nothing there', () => {
    repo = new Repo();

    repo.stack(repo.main);

    expect(fs.existsSync(path.join(repo.main, 'supabase', '.env.local'))).toBe(false);
    expect(fs.existsSync(path.join(repo.main, '.env.local'))).toBe(false);
  });

  it('gives a linked worktree its own project_id and a block of every config.toml port, shifted by 100 per slot', async () => {
    repo = new Repo();
    const before = await lowestFreeSlot(DEFAULT_PORTS);
    const worktree = repo.addWorktree('12-Fancy.Name+X');

    repo.stack(worktree);

    const k = repo.slot(worktree);
    await expectLowestFreeSlot(k, before, DEFAULT_PORTS);
    const env = repo.supabaseEnv(worktree);
    expect(single(env, 'SUPABASE_PROJECT_ID')).toBe('quiz-learning-platform-12-fancy-name-x');
    for (const { name, port } of portKeys(REAL_CONFIG)) {
      expect([name, single(env, name)]).toEqual([name, String(port + 100 * k)]);
    }
    const written = [...env.keys()].filter((key) => /_PORT$/.test(key)).sort();
    expect(written).toEqual(
      portKeys(REAL_CONFIG)
        .map((key) => key.name)
        .sort(),
    );
    // The committed config that CI and main use stays as it is.
    expect(repo.git(worktree, 'status', '--porcelain', '--', 'supabase/config.toml')).toBe('');
  });

  it('reads project_id and ports from config.toml generically, including newly uncommented ones and without [remotes.*]', async () => {
    const config =
      REAL_CONFIG.replace(/^project_id = .*$/m, 'project_id = "other-app"').replace(
        /^# smtp_port = (\d+)$/m,
        'smtp_port = $1',
      ) + '\n[remotes.staging.api]\nport = 6543\n';
    expect(config).toMatch(/^smtp_port = 54325$/m);
    repo = new Repo(config);
    const ports = portKeys(config).map((key) => key.port);
    const before = await lowestFreeSlot(ports);
    const worktree = repo.addWorktree('7-quiz-player');

    repo.stack(worktree);

    const k = repo.slot(worktree);
    await expectLowestFreeSlot(k, before, ports);
    const env = repo.supabaseEnv(worktree);
    expect(single(env, 'SUPABASE_PROJECT_ID')).toBe('other-app-7-quiz-player');
    expect(single(env, 'SUPABASE_LOCAL_SMTP_SMTP_PORT')).toBe(String(54325 + 100 * k));
    for (const { name, port } of portKeys(config)) {
      expect([name, single(env, name)]).toEqual([name, String(port + 100 * k)]);
    }
    expect([...env.values()].flat()).not.toContain(String(6543 + 100 * k));
    expect(env.has('SUPABASE_REMOTES_STAGING_API_PORT')).toBe(false);
  });

  it('points the app and the e2e tests at the worktree stack through the root .env.local', async () => {
    repo = new Repo();
    const worktree = repo.addWorktree('7-quiz-player');

    repo.stack(worktree);

    const k = repo.slot(worktree);
    expect(k).toBeGreaterThanOrEqual(1);
    const env = repo.rootEnv(worktree);
    expect(single(env, 'EXPO_PUBLIC_SUPABASE_URL')).toBe(`http://127.0.0.1:${54321 + 100 * k}`);
    expect(single(env, 'QUIZ_E2E_PORT')).toBe(String(4173 + 100 * k));
  });

  it('keeps other lines of an existing root .env.local and replaces its own keys instead of duplicating them', async () => {
    repo = new Repo();
    const worktree = repo.addWorktree('7-quiz-player');
    fs.writeFileSync(
      path.join(worktree, '.env.local'),
      '# my own settings\nEXPO_PUBLIC_FEATURE=on\nEXPO_PUBLIC_SUPABASE_URL=http://old.example:1\n',
    );

    repo.stack(worktree);
    const first = fs.readFileSync(path.join(worktree, '.env.local'), 'utf8');
    repo.stack(worktree);
    const second = fs.readFileSync(path.join(worktree, '.env.local'), 'utf8');

    expect(second).toBe(first);
    expect(second).toContain('# my own settings');
    const k = repo.slot(worktree);
    expect(k).toBeGreaterThanOrEqual(1);
    const env = repo.rootEnv(worktree);
    expect(single(env, 'EXPO_PUBLIC_FEATURE')).toBe('on');
    expect(single(env, 'EXPO_PUBLIC_SUPABASE_URL')).toBe(`http://127.0.0.1:${54321 + 100 * k}`);
    expect(single(env, 'QUIZ_E2E_PORT')).toBe(String(4173 + 100 * k));
  });

  it('works on the git top level of the current directory when no directory is given', async () => {
    repo = new Repo();
    const worktree = repo.addWorktree('7-quiz-player');

    repo.stack(worktree, { cwd: path.join(worktree, 'supabase'), args: [] });

    expect(single(repo.supabaseEnv(worktree), 'SUPABASE_PROJECT_ID')).toBe(
      'quiz-learning-platform-7-quiz-player',
    );
    expect(fs.existsSync(path.join(worktree, 'supabase', 'supabase'))).toBe(false);
  });

  it('gives a second worktree the next slot, since the first worktree claimed its slot', async () => {
    repo = new Repo();
    const first = repo.addWorktree('7-quiz-player');
    const second = repo.addWorktree('10-admin-editor');
    repo.stack(first);
    const k1 = repo.slot(first);
    const before = await lowestFreeSlot(DEFAULT_PORTS, [k1]);

    repo.stack(second);

    const k2 = repo.slot(second);
    await expectLowestFreeSlot(k2, before, DEFAULT_PORTS, [k1]);
    expect(single(repo.rootEnv(second), 'QUIZ_E2E_PORT')).toBe(String(4173 + 100 * k2));
  });

  it('keeps a worktree on its slot when run again', async () => {
    repo = new Repo();
    const first = repo.addWorktree('7-quiz-player');
    const second = repo.addWorktree('10-admin-editor');
    repo.stack(first);
    repo.stack(second);
    const k1 = repo.slot(first);
    expect(k1).toBeGreaterThanOrEqual(1);
    const before = fs.readFileSync(path.join(first, 'supabase', '.env.local'), 'utf8');

    repo.stack(first);

    expect(repo.slot(first)).toBe(k1);
    expect(fs.readFileSync(path.join(first, 'supabase', '.env.local'), 'utf8')).toBe(before);
  });

  it('keeps a worktree on its slot when a lower slot became free again', async () => {
    repo = new Repo();
    const first = repo.addWorktree('7-quiz-player');
    const second = repo.addWorktree('10-admin-editor');
    repo.stack(first);
    repo.stack(second);
    const k2 = repo.slot(second);
    expect(k2).not.toBe(repo.slot(first));
    repo.git(repo.main, 'worktree', 'remove', '--force', first);

    repo.stack(second);

    expect(repo.slot(second)).toBe(k2);
  });

  it('keeps a worktree on its slot while its own stack holds the ports', async () => {
    repo = new Repo();
    const worktree = repo.addWorktree('7-quiz-player');
    repo.stack(worktree);
    const k1 = repo.slot(worktree);
    expect(k1).toBeGreaterThanOrEqual(1);
    const server = await listen(54321 + 100 * k1);

    try {
      repo.stack(worktree);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(repo.slot(worktree)).toBe(k1);
  });

  it('skips a slot whose ports something else is using', async () => {
    repo = new Repo();
    const held = await lowestFreeSlot(DEFAULT_PORTS);
    const worktree = repo.addWorktree('7-quiz-player');
    const server = await listen(54321 + 100 * held);

    let before = 0;
    try {
      before = await lowestFreeSlot(DEFAULT_PORTS, [held]);
      repo.stack(worktree);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    await expectLowestFreeSlot(repo.slot(worktree), before, DEFAULT_PORTS, [held]);
  });

  it('does nothing in a linked worktree of a repo without supabase/config.toml', () => {
    repo = new Repo(null);
    const worktree = repo.addWorktree('7-quiz-player');

    const result = repo.stack(worktree);

    expect(result.stderr).toBe('');
    expect(fs.existsSync(path.join(worktree, 'supabase', '.env.local'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, '.env.local'))).toBe(false);
  });

  it('never picks slot 0, the default ports of the main checkout', async () => {
    repo = new Repo();
    const worktree = repo.addWorktree('7-quiz-player');

    repo.stack(worktree);

    expect(repo.slot(worktree)).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(repo.slot(worktree))).toBe(true);
  });
});
