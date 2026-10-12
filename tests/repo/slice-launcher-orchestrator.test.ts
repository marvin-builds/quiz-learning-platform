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

const issue = (
  number: number,
  title: string,
  milestone: number | null,
  body = '',
  extra: Partial<Issue> = {},
): Issue => ({
  number,
  title,
  milestone: milestone === null ? null : { number: milestone, title: `Phase ${milestone}` },
  body,
  state: 'OPEN',
  ...extra,
});

// Like the real `gh`, this fake returns only the fields named in `--json`, so
// a launcher that never asks for `labels` never sees them. `npm` and `claude`
// log their calls.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
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
// `npm` also talks on stdout, as the real `npm ci` does.
const FAKE_LOGGER = (name: string, says = '') => `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: '${name}', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
process.stdout.write(${JSON.stringify(says)});
`;

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-orchestrator-')));
  readonly app = path.join(this.root, 'app');
  readonly worktrees = path.join(this.root, 'app.worktrees');
  private readonly bin = path.join(this.root, 'bin');
  private readonly log = path.join(this.root, 'log.jsonl');
  private readonly issuesFile = path.join(this.root, 'issues.json');

  constructor(issues: Issue[]) {
    const origin = path.join(this.root, 'origin.git');
    this.git(this.root, 'init', '-q', '--bare', '-b', 'main', origin);
    this.git(this.root, 'clone', '-q', origin, this.app);
    this.git(this.app, 'config', 'user.email', 'fixture@example.com');
    this.git(this.app, 'config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(this.app, 'README.md'), 'app\n');
    fs.writeFileSync(path.join(this.app, '.gitignore'), 'node_modules/\n.env*.local\n');
    // The real config, so stack.mjs gives a new worktree its slot and says so.
    fs.mkdirSync(path.join(this.app, 'supabase'));
    fs.writeFileSync(path.join(this.app, 'supabase', 'config.toml'), CONFIG);
    this.git(this.app, 'add', '-A');
    this.git(this.app, 'commit', '-q', '-m', 'Initial commit');
    this.git(this.app, 'push', '-q', 'origin', 'HEAD:main');
    this.setIssues(issues);
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

  setIssues(issues: Issue[]) {
    fs.writeFileSync(this.issuesFile, JSON.stringify(issues));
  }

  git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A branch with one commit on top of main, without checking it out. */
  branchWithCommit(name: string): string {
    const tree = this.git(this.app, 'rev-parse', 'HEAD^{tree}');
    const commit = this.git(this.app, 'commit-tree', tree, '-p', 'HEAD', '-m', `Work on ${name}`);
    this.git(this.app, 'branch', name, commit);
    return commit;
  }

  run(args: string[], input = '') {
    return spawnSync('node', [SCRIPT, ...args], {
      cwd: this.app,
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_PUSH_AUTHORITY: undefined,
        PATH: `${this.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_ISSUES: this.issuesFile,
        FAKE_LOG: this.log,
      },
    });
  }

  calls(tool: string): { cwd: string; args: string[] }[] {
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

const MANUAL = { labels: [{ name: 'manual' }] };

// #3 has no `labels` field at all, the others an empty or filled list.
const ISSUES = [
  issue(3, 'Upgrade to Expo SDK 58 when it is stable', null),
  issue(4, '1.4 Anonymous attempts', 1, '', { labels: [] }),
  issue(5, '1.5 Submit answer', 1, 'Phase 1, item 5. Depends on #2, #4.', { labels: [] }),
  issue(2, '1.2 Content schema', 1, '', { state: 'CLOSED', labels: [] }),
  issue(7, '1.7 Quiz player: single and multiple choice', 1, 'Depends on #2.', {
    labels: [{ name: 'enhancement' }],
  }),
  issue(8, '1.8 Images in questions and answers', 1, '', MANUAL),
  issue(10, '2.0 Admin editor', 2, '', { labels: [] }),
  issue(9, '1.9 Answer feedback, result screen and E2E flow A', 1, 'Depends on #7.', {
    labels: [],
  }),
];

describe('slice launcher for the orchestrator', () => {
  let box: Sandbox;

  beforeEach(() => {
    box = new Sandbox(ISSUES);
    // #4 is in progress: its branch exists.
    box.git(box.app, 'branch', '4-anonymous-attempts');
  });

  afterEach(() => box.remove());

  describe('--no-session', () => {
    it('creates the worktree, installs, starts no session and prints the issue as one JSON line', () => {
      const result = box.run(['--no-session', '10']);

      expect(result.status).toBe(0);
      const worktree = path.join(box.worktrees, '10-admin-editor');
      expect(JSON.parse(result.stdout)).toEqual({
        number: 10,
        title: '2.0 Admin editor',
        branch: '10-admin-editor',
        worktree,
      });
      // stack.mjs and npm ci ran (and talked), yet stdout holds only the JSON line.
      expect(fs.existsSync(path.join(worktree, 'supabase', '.env.local'))).toBe(true);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(box.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('10-admin-editor');
      expect(box.git(worktree, 'rev-parse', 'HEAD')).toBe(
        box.git(box.app, 'rev-parse', 'origin/main'),
      );
      expect(() => box.git(worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
      expect(box.calls('npm')).toEqual([{ tool: 'npm', cwd: worktree, args: ['ci'] }]);
      expect(box.calls('claude')).toEqual([]);
    });

    it('reuses an existing worktree without reinstalling', () => {
      const worktree = path.join(box.worktrees, '4-anonymous-attempts');
      box.git(box.app, 'worktree', 'add', '-q', worktree, '4-anonymous-attempts');
      fs.mkdirSync(path.join(worktree, 'node_modules'));

      const result = box.run(['--no-session', '4']);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        number: 4,
        title: '1.4 Anonymous attempts',
        branch: '4-anonymous-attempts',
        worktree,
      });
      expect(box.git(box.app, 'worktree', 'list').split('\n')).toHaveLength(2);
      expect(box.calls('npm')).toEqual([]);
      expect(box.calls('claude')).toEqual([]);
    });

    it('gives an existing branch without a worktree its worktree back', () => {
      const result = box.run(['--no-session', '4']);

      expect(result.status).toBe(0);
      const worktree = path.join(box.worktrees, '4-anonymous-attempts');
      expect(JSON.parse(result.stdout).worktree).toBe(worktree);
      expect(box.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('4-anonymous-attempts');
      expect(box.calls('claude')).toEqual([]);
    });

    it('refuses a closed issue and creates nothing', () => {
      const result = box.run(['--no-session', '2']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('#2 is closed.');
      expect(result.stdout).toBe('');
      expect(fs.existsSync(box.worktrees)).toBe(false);
      expect(box.calls('claude')).toEqual([]);
    });
  });

  describe('--no-session --parent', () => {
    it('starts a new branch from the parent branch on origin, without upstream', () => {
      const parent = box.branchWithCommit('7-quiz-player');
      box.git(box.app, 'push', '-q', 'origin', '7-quiz-player');
      // The local branch moves on; origin's state is the one to start from.
      box.git(box.app, 'branch', '-f', '7-quiz-player', 'main');

      const result = box.run(['--no-session', '9', '--parent', '7-quiz-player']);

      expect(result.status).toBe(0);
      const worktree = path.join(box.worktrees, '9-answer-feedback-result-screen');
      expect(JSON.parse(result.stdout).worktree).toBe(worktree);
      expect(box.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
        '9-answer-feedback-result-screen',
      );
      expect(box.git(worktree, 'rev-parse', 'HEAD')).toBe(parent);
      expect(() => box.git(worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
      expect(box.calls('claude')).toEqual([]);
    });

    it('starts a new branch from the local parent branch when origin has none', () => {
      const parent = box.branchWithCommit('7-quiz-player');

      const result = box.run(['--no-session', '9', '--parent', '7-quiz-player']);

      expect(result.status).toBe(0);
      const worktree = path.join(box.worktrees, '9-answer-feedback-result-screen');
      expect(box.git(worktree, 'rev-parse', 'HEAD')).toBe(parent);
      expect(() => box.git(worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    });

    it('reuses an existing branch unchanged and ignores the parent', () => {
      const own = box.git(box.app, 'rev-parse', '4-anonymous-attempts');
      box.branchWithCommit('7-quiz-player');

      const result = box.run(['--no-session', '4', '--parent', '7-quiz-player']);

      expect(result.status).toBe(0);
      const worktree = path.join(box.worktrees, '4-anonymous-attempts');
      expect(JSON.parse(result.stdout).worktree).toBe(worktree);
      expect(box.git(worktree, 'rev-parse', 'HEAD')).toBe(own);
    });
  });

  describe('--ready', () => {
    it('lists the issues that can start and why the others wait, in pick order', () => {
      const result = box.run(['--ready']);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ready: [
          {
            number: 7,
            title: '1.7 Quiz player: single and multiple choice',
            branch: '7-quiz-player',
          },
          { number: 10, title: '2.0 Admin editor', branch: '10-admin-editor' },
          {
            number: 3,
            title: 'Upgrade to Expo SDK 58 when it is stable',
            branch: '3-upgrade-to-expo-sdk',
          },
        ],
        waiting: [
          { number: 4, reason: 'in progress (branch 4-anonymous-attempts)' },
          { number: 5, reason: 'waits for #4' },
          { number: 8, reason: 'manual' },
          { number: 9, reason: 'waits for #7' },
        ],
      });
    });

    it('counts a branch that exists only on origin as in progress', () => {
      box.git(box.app, 'push', '-q', 'origin', 'HEAD:refs/heads/10-admin-editor');

      const result = box.run(['--ready']);

      expect(result.status).toBe(0);
      const { ready, waiting } = JSON.parse(result.stdout);
      expect(waiting).toContainEqual({
        number: 10,
        reason: 'in progress (branch 10-admin-editor)',
      });
      expect(ready.map((i: { number: number }) => i.number)).not.toContain(10);
    });

    it('changes nothing', () => {
      const branchesBefore = box.git(box.app, 'branch', '--list');

      const result = box.run(['--ready']);

      expect(result.status).toBe(0);
      expect(fs.existsSync(box.worktrees)).toBe(false);
      expect(box.git(box.app, 'branch', '--list')).toBe(branchesBefore);
      expect(box.calls('npm')).toEqual([]);
      expect(box.calls('claude')).toEqual([]);
    });
  });

  describe('manual issues', () => {
    // #7 becomes manual, so the next pick after it is #10 (#9 still waits for #7).
    beforeEach(() => box.setIssues(ISSUES.map((i) => (i.number === 7 ? { ...i, ...MANUAL } : i))));

    it('are skipped by --pick', () => {
      const result = box.run(['--pick']);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).number).toBe(10);
    });

    it('are skipped by the plain pick', () => {
      const result = box.run([], 'n\n');

      expect(result.stdout).toContain('Next issue: #10');
      expect(result.stdout).not.toContain('#7');
      expect(box.calls('claude')).toEqual([]);
    });
  });
});
