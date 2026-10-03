/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const SCRIPT = path.join(process.cwd(), 'scripts', 'slice.mjs');

type Issue = {
  number: number;
  title: string;
  milestone: { number: number; title: string } | null;
  body: string;
  state: 'OPEN' | 'CLOSED';
};

const issue = (
  number: number,
  title: string,
  milestone: number | null,
  body = '',
  state: Issue['state'] = 'OPEN',
): Issue => ({
  number,
  title,
  milestone: milestone === null ? null : { number: milestone, title: `Phase ${milestone}` },
  body,
  state,
});

// `gh issue list/view`, `npm ci` and `claude` are fakes that answer from or
// log to files, so the launcher runs against a real git repo (with a bare
// origin) and nothing else.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const issues = JSON.parse(fs.readFileSync(process.env.FAKE_ISSUES, 'utf8'));
const [cmd, sub, n] = process.argv.slice(2);
if (cmd === 'issue' && sub === 'list') {
  process.stdout.write(JSON.stringify(issues.filter((i) => i.state === 'OPEN')));
} else if (cmd === 'issue' && sub === 'view') {
  const found = issues.find((i) => String(i.number) === n);
  if (!found) { process.stderr.write('no issue ' + n); process.exit(1); }
  process.stdout.write(JSON.stringify(found));
} else { process.stderr.write('unexpected gh ' + process.argv.slice(2).join(' ')); process.exit(2); }
`;
const FAKE_LOGGER = (name: string) => `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: '${name}', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
`;

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-launcher-')));
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
    this.git(this.app, 'add', '-A');
    this.git(this.app, 'commit', '-q', '-m', 'Initial commit');
    this.git(this.app, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(this.issuesFile, JSON.stringify(issues));
    fs.mkdirSync(this.bin);
    const tools: Record<string, string> = {
      gh: FAKE_GH,
      npm: FAKE_LOGGER('npm'),
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

  run(args: string[], input = '') {
    return spawnSync('node', [SCRIPT, ...args], {
      cwd: this.app,
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
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

const ISSUES = [
  issue(3, 'Upgrade to Expo SDK 58 when it is stable', null),
  issue(4, '1.4 Anonymous attempts', 1),
  issue(5, '1.5 Submit answer', 1, 'Phase 1, item 5. Depends on #2, #4.'),
  issue(2, '1.2 Content schema', 1, '', 'CLOSED'),
  issue(7, '1.7 Quiz player: single and multiple choice', 1, 'Depends on #2.'),
  issue(10, '2.0 Admin editor', 2),
  issue(9, '1.9 Answer feedback, result screen and E2E flow A', 1, 'Depends on #7.'),
];

describe('slice launcher', () => {
  let box: Sandbox;

  beforeEach(() => {
    box = new Sandbox(ISSUES);
    // #4 is in progress: its branch exists.
    box.git(box.app, 'branch', '4-anonymous-attempts');
  });

  afterEach(() => box.remove());

  it('picks the next unblocked issue that has no branch yet and starts a session in its new worktree', () => {
    const result = box.run([], 'y\n');

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#7');
    const worktree = path.join(box.worktrees, '7-quiz-player');
    expect(box.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('7-quiz-player');
    expect(box.git(worktree, 'rev-parse', 'HEAD')).toBe(
      box.git(box.app, 'rev-parse', 'origin/main'),
    );
    // No upstream, so a bare `git push` can never target main.
    expect(() => box.git(worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    expect(box.calls('npm')).toEqual([{ tool: 'npm', cwd: worktree, args: ['ci'] }]);
    expect(box.calls('claude')).toEqual([
      {
        tool: 'claude',
        cwd: worktree,
        args: ['-n', '7-quiz-player', '/semi-auto-workflow 7'],
      },
    ]);
  });

  it('shows start conditions it cannot check before asking', () => {
    const conditional = issue(
      6,
      '1.6 Autopilot',
      1,
      'Phase 1, item 6.\nStart it only if the phase review shows that slices are routine.',
    );
    box.remove();
    box = new Sandbox([...ISSUES, conditional]);
    box.git(box.app, 'branch', '4-anonymous-attempts');

    const result = box.run([], 'n\n');

    expect(result.stdout).toContain('#6');
    expect(result.stdout).toContain(
      'Start it only if the phase review shows that slices are routine.',
    );
  });

  it('creates nothing when I decline the pick', () => {
    const result = box.run([], 'n\n');

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(box.worktrees)).toBe(false);
    expect(box.calls('claude')).toEqual([]);
  });

  it('starts the issue I name without asking, even when it is not the next one', () => {
    const result = box.run(['10']);

    expect(result.status).toBe(0);
    const worktree = path.join(box.worktrees, '10-admin-editor');
    expect(box.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('10-admin-editor');
    expect(box.calls('claude')).toEqual([
      {
        tool: 'claude',
        cwd: worktree,
        args: ['-n', '10-admin-editor', '/semi-auto-workflow 10'],
      },
    ]);
  });

  it('resumes an issue in its existing worktree without reinstalling', () => {
    const worktree = path.join(box.worktrees, '4-anonymous-attempts');
    box.git(box.app, 'worktree', 'add', '-q', worktree, '4-anonymous-attempts');
    fs.mkdirSync(path.join(worktree, 'node_modules'));

    const result = box.run(['4']);

    expect(result.status).toBe(0);
    expect(box.git(box.app, 'worktree', 'list').split('\n')).toHaveLength(2);
    expect(box.calls('npm')).toEqual([]);
    expect(box.calls('claude')).toEqual([
      {
        tool: 'claude',
        cwd: worktree,
        args: ['-n', '4-anonymous-attempts', '/semi-auto-workflow 4'],
      },
    ]);
  });

  it('gives an existing branch without a worktree its worktree back', () => {
    const result = box.run(['4']);

    expect(result.status).toBe(0);
    const worktree = path.join(box.worktrees, '4-anonymous-attempts');
    expect(box.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('4-anonymous-attempts');
    expect(box.calls('npm')).toEqual([{ tool: 'npm', cwd: worktree, args: ['ci'] }]);
  });

  it('prints the pick with --pick and creates nothing', () => {
    const result = box.run(['--pick']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      number: 7,
      title: '1.7 Quiz player: single and multiple choice',
      branch: '7-quiz-player',
    });
    expect(fs.existsSync(box.worktrees)).toBe(false);
    expect(box.calls('claude')).toEqual([]);
  });

  it('keeps branch names short: title prefix numbers and punctuation dropped, at most four words', () => {
    box.git(box.app, 'branch', '7-quiz-player');
    box.git(box.app, 'branch', '10-admin-editor');
    // #9 waits for #7, so close #7 to make #9 the next pick.
    fs.writeFileSync(
      path.join(box.root, 'issues.json'),
      JSON.stringify(ISSUES.map((i) => (i.number === 7 ? { ...i, state: 'CLOSED' } : i))),
    );

    const result = box.run(['--pick']);

    expect(JSON.parse(result.stdout).branch).toBe('9-answer-feedback-result-screen');
  });

  it('skips issues whose branch exists only on origin', () => {
    box.git(box.app, 'push', '-q', 'origin', 'HEAD:refs/heads/7-quiz-player');
    box.git(box.app, 'fetch', '-q', 'origin');

    const result = box.run(['--pick']);

    expect(JSON.parse(result.stdout).number).toBe(10);
  });

  it('reports what each open issue waits for when none qualifies', () => {
    box.git(box.app, 'branch', '7-quiz-player');
    box.git(box.app, 'branch', '10-admin-editor');
    box.git(box.app, 'branch', '3-upgrade-to-expo-sdk');

    const result = box.run([]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/#5.*#4/);
    expect(result.stderr).toMatch(/#9.*#7/);
    expect(result.stderr).toMatch(/#4.*in progress/);
    expect(box.calls('claude')).toEqual([]);
  });
});
