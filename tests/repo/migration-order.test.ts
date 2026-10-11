/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const SCRIPT = path.join(process.cwd(), 'scripts', 'migration-order.mjs');
const DIR = 'supabase/migrations';

// A repo with a bare origin. `main` gets migrations, the slice branch forks
// from it, and main moves on, the way a slice falls behind while others merge.
class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-order-')));
  readonly app = path.join(this.root, 'app');

  constructor() {
    const origin = path.join(this.root, 'origin.git');
    this.git(this.root, 'init', '-q', '--bare', '-b', 'main', origin);
    this.git(this.root, 'clone', '-q', origin, this.app);
    this.git(this.app, 'config', 'user.email', 'fixture@example.com');
    this.git(this.app, 'config', 'user.name', 'Fixture');
    this.git(this.app, 'checkout', '-q', '-b', 'main');
    this.commit({ 'README.md': 'app\n' });
    this.git(this.app, 'push', '-q', 'origin', 'main');
  }

  git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Commits the files (paths relative to the repo) on the current branch. */
  commit(files: Record<string, string | Buffer>) {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(this.app, file)), { recursive: true });
      fs.writeFileSync(path.join(this.app, file), content);
    }
    this.git(this.app, 'add', '-A');
    this.git(this.app, 'commit', '-q', '-m', `Add ${Object.keys(files).join(', ')}`);
  }

  /** Main moves on by these files after the slice forked, on origin only. */
  advanceMain(files: Record<string, string>) {
    const branch = this.git(this.app, 'rev-parse', '--abbrev-ref', 'HEAD');
    this.git(this.app, 'checkout', '-q', 'main');
    this.commit(files);
    this.git(this.app, 'push', '-q', 'origin', 'main');
    this.git(this.app, 'reset', '-q', '--hard', 'HEAD~1');
    this.git(this.app, 'checkout', '-q', branch);
  }

  /** A local `release` branch: the fork point plus these files, not on origin/main. */
  release(files: Record<string, string>) {
    const branch = this.git(this.app, 'rev-parse', '--abbrev-ref', 'HEAD');
    this.git(this.app, 'checkout', '-q', '-b', 'release', 'main');
    this.commit(files);
    this.git(this.app, 'checkout', '-q', branch);
  }

  slice() {
    this.git(this.app, 'checkout', '-q', '-b', '42-slice');
  }

  run(...args: string[]) {
    return spawnSync('node', [SCRIPT, ...args], { cwd: this.app, encoding: 'utf8' });
  }

  migrations(): string[] {
    return fs.readdirSync(path.join(this.app, DIR)).sort();
  }

  remove() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const m = (name: string) => `${DIR}/${name}`;
const lines = (out: string) => out.trim().split('\n').filter(Boolean);

describe('migration order', () => {
  let box: Sandbox;

  beforeEach(() => {
    box = new Sandbox();
    box.commit({ [m('20260101120000_content_schema.sql')]: 'create table quizzes ();\n' });
    box.git(box.app, 'push', '-q', 'origin', 'main');
  });

  afterEach(() => box.remove());

  describe('check', () => {
    it('lists branch migrations not newer than the newest on origin/main and exits 1', () => {
      box.slice();
      box.commit({ [m('20260108000000_attempts.sql')]: 'create table attempts ();\n' });
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      const result = box.run();

      expect(result.status).toBe(1);
      expect(lines(result.stdout)).toEqual([m('20260108000000_attempts.sql')]);
    });

    it('lists a branch migration with the same timestamp as the newest on origin/main', () => {
      box.slice();
      box.commit({ [m('20260110093000_attempts.sql')]: 'create table attempts ();\n' });
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      const result = box.run();

      expect(result.status).toBe(1);
      expect(lines(result.stdout)).toEqual([m('20260110093000_attempts.sql')]);
    });

    it('exits 0 without output when all branch migrations are newer', () => {
      box.slice();
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });
      box.commit({ [m('20260111000000_attempts.sql')]: 'create table attempts ();\n' });

      const result = box.run();

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('exits 0 when the branch adds no migration', () => {
      box.slice();
      box.commit({ 'notes.md': 'no schema change\n' });
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      const result = box.run();

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('ignores older migrations the branch only modifies', () => {
      box.slice();
      box.commit({ [m('20260101120000_content_schema.sql')]: 'create table quizzes (id int);\n' });
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      const result = box.run();

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('exits 0 when the base has no migrations', () => {
      box.remove();
      box = new Sandbox();
      box.slice();
      box.commit({ [m('20260108000000_attempts.sql')]: 'create table attempts ();\n' });

      const result = box.run();

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('compares against the base ref given as argument', () => {
      box.slice();
      box.commit({ [m('20260108000000_attempts.sql')]: 'create table attempts ();\n' });
      box.release({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      expect(box.run().status).toBe(0);
      const result = box.run('release');

      expect(result.status).toBe(1);
      expect(lines(result.stdout)).toEqual([m('20260108000000_attempts.sql')]);
    });

    it('ignores files without a timestamp on both sides', () => {
      box.slice();
      box.commit({
        [m('.gitkeep')]: '',
        [m('20260108000000_attempts.sql')]: 'create table attempts ();\n',
        [m('20260111000000_scores.sql')]: 'create view scores as select 1;\n',
      });
      box.advanceMain({
        [m('.gitkeep')]: '',
        [m('README.md')]: 'Migrations, oldest first.\n',
        [m('20260110093000_answers.sql')]: 'create table answers ();\n',
      });

      const result = box.run();

      expect(result.status).toBe(1);
      expect(lines(result.stdout)).toEqual([m('20260108000000_attempts.sql')]);
    });
  });

  describe('--fix with nothing stale', () => {
    it('exits 0, prints nothing and stages nothing', () => {
      box.slice();
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });
      box.commit({ [m('20260111000000_attempts.sql')]: 'create table attempts ();\n' });

      const result = box.run('--fix');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(box.git(box.app, 'status', '--porcelain')).toBe('');
    });
  });

  describe('--fix with a base ref', () => {
    it('follows the base ref given after --fix', () => {
      box.slice();
      box.commit({ [m('20260108000000_attempts.sql')]: 'create table attempts ();\n' });
      box.release({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      const result = box.run('--fix', 'release');

      expect(result.status).toBe(0);
      expect(box.migrations()).toEqual([
        '20260101120000_content_schema.sql',
        '20260110093001_attempts.sql',
      ]);
    });

    it('accepts origin/main named explicitly after --fix', () => {
      box.slice();
      box.commit({ [m('20260108000000_attempts.sql')]: 'create table attempts ();\n' });
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      const result = box.run('--fix', 'origin/main');

      expect(result.status).toBe(0);
      expect(box.migrations()).toEqual([
        '20260101120000_content_schema.sql',
        '20260110093001_attempts.sql',
      ]);
    });
  });

  describe('--fix', () => {
    // No trailing newline and non-ASCII text: a rename must not touch either.
    const ATTEMPTS = '-- Versuche für Gäste\ncreate table attempts ();';
    const SUBMIT = 'create function submit_answer() returns void as $$ $$;\n';

    beforeEach(() => {
      box.slice();
      box.commit({
        [m('20260108000000_attempts.sql')]: ATTEMPTS,
        [m('20260109120000_submit_answer.sql')]: SUBMIT,
      });
      box.advanceMain({ [m('20261231235959_answers.sql')]: 'create table answers ();\n' });
    });

    it('renames the stale migrations to follow the newest base one, across a calendar rollover', () => {
      const result = box.run('--fix');

      expect(result.status).toBe(0);
      expect(box.migrations()).toEqual([
        '20260101120000_content_schema.sql',
        '20270101000000_attempts.sql',
        '20270101000001_submit_answer.sql',
      ]);
    });

    it('keeps the content of renamed migrations byte for byte', () => {
      const read = (name: string) => fs.readFileSync(path.join(box.app, m(name)));
      const attempts = read('20260108000000_attempts.sql');
      const submit = read('20260109120000_submit_answer.sql');

      box.run('--fix');

      expect(read('20270101000000_attempts.sql')).toEqual(attempts);
      expect(read('20270101000001_submit_answer.sql')).toEqual(submit);
    });

    it('stages the renames as renames without committing them', () => {
      const head = box.git(box.app, 'rev-parse', 'HEAD');

      box.run('--fix');

      expect(box.git(box.app, 'rev-parse', 'HEAD')).toBe(head);
      expect(lines(box.git(box.app, 'diff', '--cached', '-M', '--name-status'))).toEqual([
        `R100\t${m('20260108000000_attempts.sql')}\t${m('20270101000000_attempts.sql')}`,
        `R100\t${m('20260109120000_submit_answer.sql')}\t${m('20270101000001_submit_answer.sql')}`,
      ]);
      expect(box.git(box.app, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(
        /^.[MD?]/m,
      );
    });

    it('prints each rename as old → new', () => {
      const result = box.run('--fix');

      const printed = lines(result.stdout);
      expect(printed).toHaveLength(2);
      expect(printed[0]).toMatch(/20260108000000_attempts\.sql → .*20270101000000_attempts\.sql$/);
      expect(printed[1]).toMatch(
        /20260109120000_submit_answer\.sql → .*20270101000001_submit_answer\.sql$/,
      );
    });

    it('leaves nothing for the check to report once the renames are committed', () => {
      box.run('--fix');
      box.git(box.app, 'commit', '-q', '-m', 'Move migrations after main');

      const result = box.run();

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });
  });

  describe('--fix with newer branch migrations', () => {
    it('moves a newer branch migration only when a renamed one would reach it', () => {
      box.slice();
      box.commit({
        [m('20260108000000_attempts.sql')]: 'create table attempts ();\n',
        [m('20260110093001_policies.sql')]: 'alter table attempts enable row level security;\n',
        [m('20260120000000_scores.sql')]: 'create view scores as select 1;\n',
      });
      box.advanceMain({ [m('20260110093000_answers.sql')]: 'create table answers ();\n' });

      const result = box.run('--fix');

      expect(result.status).toBe(0);
      expect(box.migrations()).toEqual([
        '20260101120000_content_schema.sql',
        '20260110093001_attempts.sql',
        '20260110093002_policies.sql',
        '20260120000000_scores.sql',
      ]);
      expect(lines(result.stdout)).toHaveLength(2);
    });
  });
});
