/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const SCRIPT = path.join(process.cwd(), 'scripts', 'slice.mjs');
const CONFIG = fs.readFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'utf8');

type Issue = {
  number: number;
  title: string;
  milestone: { number: number; title: string } | null;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels?: { name: string }[];
};

const issue = (number: number, title: string, milestone: number | null): Issue => ({
  number,
  title,
  milestone: milestone === null ? null : { number: milestone, title: `Phase ${milestone}` },
  body: '',
  state: 'OPEN',
  labels: [],
});

// Like the real `gh`, this fake returns only the fields named in `--json`.
// It logs its calls too, so a run that must not pick can be checked.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'gh', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const issues = JSON.parse(fs.readFileSync(process.env.FAKE_ISSUES, 'utf8'));
const args = process.argv.slice(2);
const [cmd, sub, n] = args;
const json = args.indexOf('--json');
const fields = json === -1 ? null : args[json + 1].split(',');
const only = (i) => fields ? Object.fromEntries(fields.filter((f) => f in i).map((f) => [f, i[f]])) : i;
if (cmd === 'issue' && sub === 'list') {
  process.stdout.write(JSON.stringify(issues.filter((i) => i.state === 'OPEN').map(only)));
} else if (cmd === 'issue' && sub === 'view') {
  const found = issues.find((i) => String(i.number) === n);
  if (!found) { process.stderr.write('no issue ' + n); process.exit(1); }
  process.stdout.write(JSON.stringify(only(found)));
} else { process.stderr.write('unexpected gh ' + args.join(' ')); process.exit(2); }
`;
// `npm` and `claude` log their calls, including the push authority they got;
// `claude` exits with FAKE_CLAUDE_EXIT.
const FAKE_LOGGER = (name: string, says = '') => `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  tool: '${name}',
  cwd: process.cwd(),
  args: process.argv.slice(2),
  pushAuthority: process.env.AI_PUSH_AUTHORITY ?? null,
}) + '\\n');
process.stdout.write(${JSON.stringify(says)});
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
`;

type Call = { tool: string; cwd: string; args: string[]; pushAuthority?: string | null };

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-orchestrate-')));
  readonly app = path.join(this.root, 'app');
  readonly origin = path.join(this.root, 'origin.git');
  readonly worktrees = path.join(this.root, 'app.worktrees');
  private readonly bin = path.join(this.root, 'bin');
  private readonly log = path.join(this.root, 'log.jsonl');
  private readonly issuesFile = path.join(this.root, 'issues.json');

  constructor(issues: Issue[]) {
    this.git(this.root, 'init', '-q', '--bare', '-b', 'main', this.origin);
    this.git(this.root, 'clone', '-q', this.origin, this.app);
    this.git(this.app, 'config', 'user.email', 'fixture@example.com');
    this.git(this.app, 'config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(this.app, 'README.md'), 'app\n');
    fs.writeFileSync(path.join(this.app, '.gitignore'), 'node_modules/\n.env*.local\n');
    fs.mkdirSync(path.join(this.app, 'supabase'));
    fs.writeFileSync(path.join(this.app, 'supabase', 'config.toml'), CONFIG);
    this.git(this.app, 'add', '-A');
    this.git(this.app, 'commit', '-q', '-m', 'Initial commit');
    this.git(this.app, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(this.issuesFile, JSON.stringify(issues));
    fs.mkdirSync(this.bin);
    const tools: Record<string, string> = {
      gh: FAKE_GH,
      npm: FAKE_LOGGER('npm', 'added 1234 packages in 9s\n'),
      claude: FAKE_LOGGER('claude'),
    };
    for (const [name, source] of Object.entries(tools)) {
      fs.writeFileSync(path.join(this.bin, name), source, { mode: 0o755 });
    }
  }

  git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** The file the personal push guard reads: one branch per line. */
  get pushBranchesFile(): string {
    const common = this.git(this.app, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return path.join(common, 'ai-push-branches');
  }

  pushBranches(): string[] {
    return fs.readFileSync(this.pushBranchesFile, 'utf8').split('\n').filter(Boolean);
  }

  /** A linked worktree of the main checkout, on its own new branch. */
  linkedWorktree(branch: string): string {
    const dir = path.join(this.worktrees, branch);
    this.git(this.app, 'worktree', 'add', '-q', '-b', branch, dir, 'main');
    return dir;
  }

  run(args: string[], { cwd = this.app, input = '', claudeExit = 0 } = {}) {
    return spawnSync('node', [SCRIPT, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_PUSH_AUTHORITY: undefined,
        PATH: `${this.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_ISSUES: this.issuesFile,
        FAKE_LOG: this.log,
        FAKE_CLAUDE_EXIT: String(claudeExit),
      },
    });
  }

  calls(tool: string): Call[] {
    if (!fs.existsSync(this.log)) return [];
    return fs
      .readFileSync(this.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((call) => call.tool === tool);
  }

  remove() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const ISSUES = [issue(10, '2.0 Admin editor', 2), issue(7, '1.7 Quiz player', 1)];

describe('slice launcher, orchestrated runs', () => {
  let box: Sandbox;

  beforeEach(() => {
    box = new Sandbox(ISSUES);
  });

  afterEach(() => box.remove());

  describe('--no-session grants push authority for the slice branch', () => {
    it('adds the branch to ai-push-branches in the git common dir, creating the file', () => {
      expect(fs.existsSync(box.pushBranchesFile)).toBe(false);

      const result = box.run(['--no-session', '10']);

      expect(result.status).toBe(0);
      expect(box.pushBranches()).toEqual(['10-admin-editor']);
    });

    it('keeps the other branches already listed', () => {
      fs.writeFileSync(box.pushBranchesFile, '7-quiz-player\n');

      const result = box.run(['--no-session', '10']);

      expect(result.status).toBe(0);
      expect(box.pushBranches()).toEqual(['7-quiz-player', '10-admin-editor']);
    });

    it('does not list a branch twice', () => {
      fs.writeFileSync(box.pushBranchesFile, '10-admin-editor\n7-quiz-player\n');

      const result = box.run(['--no-session', '10']);

      expect(result.status).toBe(0);
      expect(box.pushBranches()).toEqual(['10-admin-editor', '7-quiz-player']);
    });

    it("writes the common dir's file when run from a linked worktree", () => {
      const linked = box.linkedWorktree('7-quiz-player');

      const result = box.run(['--no-session', '10'], { cwd: linked });

      expect(result.status).toBe(0);
      expect(box.pushBranches()).toEqual(['10-admin-editor']);
      // Not a per-worktree file next to the linked worktree's own git dir.
      const ownGitDir = box.git(linked, 'rev-parse', '--path-format=absolute', '--git-dir');
      expect(fs.existsSync(path.join(ownGitDir, 'ai-push-branches'))).toBe(false);
    });

    it('is not written by the plain session start', () => {
      const result = box.run(['10']);

      expect(result.status).toBe(0);
      expect(box.calls('claude')).toHaveLength(1);
      expect(fs.existsSync(box.pushBranchesFile)).toBe(false);
    });
  });

  describe('--orchestrate', () => {
    it('starts the orchestrator session in the main checkout with orchestrator push authority', () => {
      const result = box.run(['--orchestrate']);

      expect(result.status).toBe(0);
      expect(box.calls('claude')).toEqual([
        {
          tool: 'claude',
          cwd: box.app,
          args: ['-n', 'orchestrator', '/orchestrator'],
          pushAuthority: 'orchestrator',
        },
      ]);
    });

    it('starts it in the main checkout when run from a linked worktree', () => {
      const linked = box.linkedWorktree('7-quiz-player');

      const result = box.run(['--orchestrate'], { cwd: linked });

      expect(result.status).toBe(0);
      expect(box.calls('claude').map((call) => call.cwd)).toEqual([box.app]);
    });

    it('creates no worktree, runs no npm, picks nothing and asks nothing', () => {
      const result = box.run(['--orchestrate'], { input: 'n\n' });

      expect(result.status).toBe(0);
      expect(fs.existsSync(box.worktrees)).toBe(false);
      expect(box.git(box.app, 'worktree', 'list').split('\n')).toHaveLength(1);
      expect(box.calls('npm')).toEqual([]);
      expect(box.calls('gh')).toEqual([]);
      expect(result.stdout).not.toContain('Next issue');
      expect(result.stdout).not.toContain('Start it?');
      expect(box.calls('claude')).toHaveLength(1);
    });

    it('does not fetch from origin', () => {
      // A branch that reaches origin from elsewhere; a fetch would bring it in.
      const tree = box.git(box.app, 'rev-parse', 'HEAD^{tree}');
      const commit = box.git(box.app, 'commit-tree', tree, '-p', 'HEAD', '-m', 'Elsewhere');
      box.git(box.app, 'push', '-q', 'origin', `${commit}:refs/heads/12-elsewhere`);
      // The push updated the local tracking ref; forget it, as if pushed from elsewhere.
      box.git(box.app, 'update-ref', '-d', 'refs/remotes/origin/12-elsewhere');
      expect(box.git(box.app, 'branch', '-r')).not.toContain('origin/12-elsewhere');

      const result = box.run(['--orchestrate']);

      expect(result.status).toBe(0);
      expect(box.calls('claude')).toHaveLength(1);
      expect(box.git(box.app, 'branch', '-r')).not.toContain('origin/12-elsewhere');
    });

    it("exits with the orchestrator session's exit code", () => {
      const result = box.run(['--orchestrate'], { claudeExit: 7 });

      expect(box.calls('claude')).toHaveLength(1);
      expect(result.status).toBe(7);
    });
  });
});
