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
  labels?: { name: string }[];
};

const issue = (
  number: number,
  title: string,
  body = '',
  state: Issue['state'] = 'OPEN',
): Issue => ({
  number,
  title,
  milestone: { number: 2, title: 'Phase 2' },
  body,
  state,
  labels: [],
});

// Like the real `gh`, this fake returns only the fields named in `--json`.
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

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-dependencies-')));
  readonly app = path.join(this.root, 'app');
  private readonly bin = path.join(this.root, 'bin');
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
    fs.writeFileSync(path.join(this.bin, 'gh'), FAKE_GH, { mode: 0o755 });
  }

  git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  ready(): {
    ready: { number: number }[];
    waiting: { number: number; reason: string }[];
  } {
    const result = spawnSync('node', [SCRIPT, '--ready'], {
      cwd: this.app,
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_PUSH_AUTHORITY: undefined,
        PATH: `${this.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_ISSUES: this.issuesFile,
      },
    });
    if (result.status !== 0) throw new Error(`slice --ready: ${result.stderr}`);
    return JSON.parse(result.stdout);
  }

  remove() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** What `--ready` says about issue #100, the one under test. */
const verdict = (issues: Issue[]) => {
  const box = new Sandbox(issues);
  try {
    const { ready, waiting } = box.ready();
    if (ready.some((i) => i.number === 100)) return 'ready';
    return waiting.find((i) => i.number === 100)?.reason;
  } finally {
    box.remove();
  }
};

describe('slice launcher dependencies: only the "Depends on" list counts', () => {
  it('takes every issue of a comma-separated list', () => {
    expect(
      verdict([
        issue(100, 'Under test', 'Phase 2, item 2. Depends on #79, #76.'),
        issue(79, 'Seventy-nine'),
        issue(76, 'Seventy-six'),
      ]),
    ).toBe('waits for #79, #76');
  });

  it('ends the list at a semicolon, so a "blocks" issue after it does not block', () => {
    expect(
      verdict([
        issue(100, 'Under test', 'Found in review. Start it early. Depends on #79; blocks #80.'),
        issue(79, 'Seventy-nine', '', 'CLOSED'),
        issue(80, 'Eighty', 'Depends on #100.'),
      ]),
    ).toBe('ready');
  });

  it('takes issues joined by "and"', () => {
    expect(
      verdict([
        issue(100, 'Under test', 'Depends on #2 and #4.'),
        issue(2, 'Two'),
        issue(4, 'Four'),
      ]),
    ).toBe('waits for #2, #4');
  });

  it('ignores issue numbers before "Depends on" on the same line', () => {
    expect(
      verdict([
        issue(100, 'Under test', 'See #12 for context. Depends on #4.'),
        issue(12, 'Twelve'),
        issue(4, 'Four'),
      ]),
    ).toBe('waits for #4');
  });

  it('takes the lists of several "Depends on" phrases on separate lines', () => {
    expect(
      verdict([
        issue(100, 'Under test', 'Depends on #2.\nIt also depends on #4.'),
        issue(2, 'Two'),
        issue(4, 'Four'),
      ]),
    ).toBe('waits for #2, #4');
  });
});
