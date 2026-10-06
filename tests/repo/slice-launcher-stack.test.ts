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

const ISSUES = [
  { number: 4, title: '1.4 Anonymous attempts', milestone: null, body: '', state: 'OPEN' },
  { number: 10, title: '2.0 Admin editor', milestone: null, body: '', state: 'OPEN' },
];

// The same fakes as in slice-launcher.test.ts: `gh` answers from a file,
// `npm` and `claude` log their calls. `claude` also logs whether the worktree
// already had its stack settings when the session started.
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
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  tool: '${name}',
  cwd: process.cwd(),
  args: process.argv.slice(2),
  stack: fs.existsSync('supabase/.env.local') && fs.existsSync('.env.local'),
}) + '\\n');
`;

function parseEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return env;
}

// Every `port` / `*_port` key outside [remotes.*], as SUPABASE_<SECTION>_<KEY>.
function portKeys(toml: string): { name: string; port: number }[] {
  const keys: { name: string; port: number }[] = [];
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

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-stack-')));
  readonly app = path.join(this.root, 'app');
  readonly worktrees = path.join(this.root, 'app.worktrees');
  private readonly bin = path.join(this.root, 'bin');
  private readonly log = path.join(this.root, 'log.jsonl');
  private readonly issuesFile = path.join(this.root, 'issues.json');

  constructor() {
    const origin = path.join(this.root, 'origin.git');
    this.git(this.root, 'init', '-q', '--bare', '-b', 'main', origin);
    this.git(this.root, 'clone', '-q', origin, this.app);
    this.git(this.app, 'config', 'user.email', 'fixture@example.com');
    this.git(this.app, 'config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(this.app, 'README.md'), 'app\n');
    fs.writeFileSync(path.join(this.app, '.gitignore'), 'node_modules/\n.env*.local\n');
    fs.mkdirSync(path.join(this.app, 'supabase'));
    fs.writeFileSync(path.join(this.app, 'supabase', 'config.toml'), CONFIG);
    this.git(this.app, 'add', '-A');
    this.git(this.app, 'commit', '-q', '-m', 'Initial commit');
    this.git(this.app, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(this.issuesFile, JSON.stringify(ISSUES));
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

  run(args: string[]) {
    return spawnSync('node', [SCRIPT, ...args], {
      cwd: this.app,
      input: '',
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${this.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_ISSUES: this.issuesFile,
        FAKE_LOG: this.log,
      },
    });
  }

  calls(tool: string): { cwd: string; args: string[]; stack: boolean }[] {
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

describe('slice launcher and the worktree stack', () => {
  let box: Sandbox;

  beforeEach(() => {
    box = new Sandbox();
  });

  afterEach(() => box.remove());

  function expectStackSettings(worktree: string) {
    const supabaseEnv = path.join(worktree, 'supabase', '.env.local');
    const rootEnv = path.join(worktree, '.env.local');
    expect(fs.existsSync(supabaseEnv)).toBe(true);
    expect(fs.existsSync(rootEnv)).toBe(true);
    const stack = parseEnv(supabaseEnv);
    expect(stack.SUPABASE_PROJECT_ID).toBe(`quiz-learning-platform-${path.basename(worktree)}`);
    const api = Number(stack.SUPABASE_API_PORT);
    expect(api).toBeGreaterThan(54321);
    expect(parseEnv(rootEnv).EXPO_PUBLIC_SUPABASE_URL).toBe(`http://127.0.0.1:${api}`);
    return { stack, root: parseEnv(rootEnv) };
  }

  it('gives a new worktree its own stack settings before the session starts', () => {
    const result = box.run(['10']);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const worktree = path.join(box.worktrees, '10-admin-editor');
    expectStackSettings(worktree);
    // The committed config that CI and main use stays as it is.
    expect(box.git(worktree, 'status', '--porcelain', '--', 'supabase')).toBe('');
    expect(box.calls('claude')).toEqual([
      {
        tool: 'claude',
        cwd: worktree,
        args: ['-n', '10-admin-editor', '/semi-auto-workflow 10'],
        stack: true,
      },
    ]);
  });

  it('gives an existing worktree without stack settings its settings on reuse', () => {
    const worktree = path.join(box.worktrees, '4-anonymous-attempts');
    box.git(box.app, 'worktree', 'add', '-q', '-b', '4-anonymous-attempts', worktree);
    fs.mkdirSync(path.join(worktree, 'node_modules'));

    const result = box.run(['4']);

    expect(result.status).toBe(0);
    expectStackSettings(worktree);
    expect(box.calls('claude')).toEqual([expect.objectContaining({ cwd: worktree, stack: true })]);
  });

  it('keeps the slot of an existing worktree on reuse', () => {
    const worktree = path.join(box.worktrees, '4-anonymous-attempts');
    box.git(box.app, 'worktree', 'add', '-q', '-b', '4-anonymous-attempts', worktree);
    fs.mkdirSync(path.join(worktree, 'node_modules'));
    // Slot 3, as an earlier run of the stack script would have written it.
    const slot3 = [
      'SUPABASE_PROJECT_ID=quiz-learning-platform-4-anonymous-attempts',
      ...portKeys(CONFIG).map(({ name, port }) => `${name}=${port + 300}`),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(worktree, 'supabase', '.env.local'), slot3);

    const result = box.run(['4']);

    expect(result.status).toBe(0);
    const { stack, root } = expectStackSettings(worktree);
    expect(stack.SUPABASE_API_PORT).toBe('54621');
    expect(stack.SUPABASE_DB_PORT).toBe('54622');
    expect(root.QUIZ_E2E_PORT).toBe('4473');
  });
});
