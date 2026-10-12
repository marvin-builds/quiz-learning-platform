/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const STACK = path.join(process.cwd(), 'scripts', 'stack.mjs');
const REAL_CONFIG = fs.readFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'utf8');

// The Supabase CLI cuts the project id to this many characters for container
// names and hostnames (e.g. `supabase_db_<id>`).
const CLI_ID_LIMIT = 40;

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

class Repo {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-id-')));
  readonly main = path.join(this.root, 'app');
  private branches = 0;

  constructor(readonly config: string = REAL_CONFIG) {
    fs.mkdirSync(path.join(this.main, 'supabase'), { recursive: true });
    this.git(this.main, 'init', '-q', '-b', 'main');
    this.git(this.main, 'config', 'user.email', 'fixture@example.com');
    this.git(this.main, 'config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(this.main, '.gitignore'), '.env*.local\n');
    fs.writeFileSync(path.join(this.main, 'supabase', 'config.toml'), config);
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

  stack(dir: string) {
    const result = spawnSync('node', [STACK, dir], { cwd: this.root, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`stack.mjs exited with ${result.status}: ${result.stderr}`);
    }
    return result;
  }

  supabaseEnv(dir: string): Map<string, string[]> {
    return parseEnv(fs.readFileSync(path.join(dir, 'supabase', '.env.local'), 'utf8'));
  }

  projectId(dir: string): string {
    return single(this.supabaseEnv(dir), 'SUPABASE_PROJECT_ID');
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

/** A valid hostname label as the CLI builds it: at most 40 characters, ending in a letter or digit. */
function expectUsableId(id: string) {
  expect(id.length).toBeLessThanOrEqual(CLI_ID_LIMIT);
  expect(id).toMatch(/[a-z0-9]$/);
}

describe('scripts/stack.mjs project id', () => {
  let repo: Repo;

  afterEach(() => repo?.remove());

  it('removes the trailing dash left after cutting a long worktree name to 40 characters', () => {
    repo = new Repo();
    const worktree = repo.addWorktree('80-category-crud-with-publish');

    repo.stack(worktree);

    const id = repo.projectId(worktree);
    expect(id).toBe('quiz-learning-platform-80-category-crud');
    expectUsableId(id);
  });

  it('removes every trailing dash and underscore left after cutting, not only one', () => {
    repo = new Repo();
    // Sanitised to `80-category-cru_-x`; the first 40 characters end in `_-`.
    const worktree = repo.addWorktree('80-category-cru_+x');

    repo.stack(worktree);

    const id = repo.projectId(worktree);
    expect(id).toBe('quiz-learning-platform-80-category-cru');
    expectUsableId(id);
  });

  it('removes a trailing dot of the project_id left after cutting', () => {
    const config = REAL_CONFIG.replace(
      /^project_id = .*$/m,
      // 39 characters ending in a dot, so the cut leaves `...app.`.
      'project_id = "a-very-long-project-identifier-for-app."',
    );
    expect(config).toMatch(/^project_id = "a-very-long-project-identifier-for-app\."$/m);
    repo = new Repo(config);
    const worktree = repo.addWorktree('7-quiz-player');

    repo.stack(worktree);

    const id = repo.projectId(worktree);
    expect(id).toBe('a-very-long-project-identifier-for-app');
    expectUsableId(id);
  });

  it('keeps an id of exactly 40 characters as the CLI already used it, so existing stacks keep their names', () => {
    repo = new Repo();
    const worktree = repo.addWorktree('76-snapshot-or-refuse-solutions');

    repo.stack(worktree);

    const id = repo.projectId(worktree);
    expect(id).toBe('quiz-learning-platform-76-snapshot-or-re');
    expect(id).toHaveLength(CLI_ID_LIMIT);
  });

  it('leaves a short id unchanged', () => {
    repo = new Repo();
    const worktree = repo.addWorktree('spike-103');

    repo.stack(worktree);

    expect(repo.projectId(worktree)).toBe('quiz-learning-platform-spike-103');
  });

  it('keeps the slot and writes the same cut id when run again on a long worktree name', () => {
    repo = new Repo();
    const worktree = repo.addWorktree('80-category-crud-with-publish');
    repo.stack(worktree);
    const k = repo.slot(worktree);
    expect(k).toBeGreaterThanOrEqual(1);
    const before = fs.readFileSync(path.join(worktree, 'supabase', '.env.local'), 'utf8');

    repo.stack(worktree);

    expect(repo.slot(worktree)).toBe(k);
    expect(repo.projectId(worktree)).toBe('quiz-learning-platform-80-category-crud');
    expect(fs.readFileSync(path.join(worktree, 'supabase', '.env.local'), 'utf8')).toBe(before);
  });
});
