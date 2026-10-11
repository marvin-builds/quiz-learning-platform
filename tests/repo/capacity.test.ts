/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const SCRIPT = path.join(process.cwd(), 'scripts', 'capacity.mjs');
const SEED = { ramGB: 1.6, diskGB: 1.2 };

type Measured = { memAvailableGB: number; diskFreeGB: number; load1: number; cores: number };

// Plenty of everything: 16 GB RAM free, 100 GB disk free, load 1 on 8 cores.
const AMPLE: Measured = { memAvailableGB: 16, diskFreeGB: 100, load1: 1, cores: 8 };

class Sandbox {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-')));
  readonly app = path.join(this.root, 'app');
  readonly worktree = path.join(this.root, 'app.worktrees', '17-orchestrator');
  readonly resources = path.join(this.app, '.claude', 'state', 'orchestrator', 'resources.json');

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

  store(kinds: Record<string, { ramGB: number; diskGB: number }>) {
    fs.mkdirSync(path.dirname(this.resources), { recursive: true });
    fs.writeFileSync(this.resources, JSON.stringify({ kinds }));
  }

  stored() {
    return JSON.parse(fs.readFileSync(this.resources, 'utf8'));
  }

  run(args: string[], measured: Measured | null = AMPLE, cwd = this.app) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CAPACITY_MEASURE;
    if (measured) env.CAPACITY_MEASURE = JSON.stringify(measured);
    const result = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', env });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }

  check(measured: Measured, args: string[] = []) {
    const result = this.run(args, measured);
    return { status: result.status, out: JSON.parse(result.stdout) };
  }

  remove() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

describe('capacity', () => {
  let box: Sandbox;

  beforeEach(() => {
    box = new Sandbox();
  });

  afterEach(() => box.remove());

  describe('check', () => {
    it('allows a start with ample resources and reports the seed cost of a slice', () => {
      const { status, out } = box.check(AMPLE);

      expect(status).toBe(0);
      expect(out).toEqual({
        canStart: true,
        reasons: [],
        kind: 'slice',
        cost: SEED,
        measured: AMPLE,
      });
    });

    it('refuses when the RAM left after the start would be below 4 GB', () => {
      const { status, out } = box.check({ ...AMPLE, memAvailableGB: 5.5 });

      expect(status).toBe(2);
      expect(out.canStart).toBe(false);
      expect(out.reasons).toEqual([expect.stringContaining('RAM')]);
    });

    it('refuses when the disk left after the start would be below 10 GB', () => {
      const { status, out } = box.check({ ...AMPLE, diskFreeGB: 11 });

      expect(status).toBe(2);
      expect(out.canStart).toBe(false);
      expect(out.reasons).toEqual([expect.stringContaining('disk')]);
    });

    it('refuses when the load is not below the core count', () => {
      const { status, out } = box.check({ ...AMPLE, load1: 8, cores: 8 });

      expect(status).toBe(2);
      expect(out.canStart).toBe(false);
      expect(out.reasons).toEqual([expect.stringContaining('load')]);
    });

    it('gives one reason per failing resource', () => {
      const { status, out } = box.check({ memAvailableGB: 2, diskFreeGB: 5, load1: 9, cores: 4 });

      expect(status).toBe(2);
      expect(out.reasons).toHaveLength(3);
      expect(out.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('RAM'),
          expect.stringContaining('disk'),
          expect.stringContaining('load'),
        ]),
      );
    });

    it('allows a start that leaves exactly 4 GB RAM and 10 GB disk', () => {
      box.store({ e2e: { ramGB: 2, diskGB: 3 } });

      const { status, out } = box.check(
        { memAvailableGB: 6, diskFreeGB: 13, load1: 3.99, cores: 4 },
        ['--kind', 'e2e'],
      );

      expect(out.reasons).toEqual([]);
      expect(out.canStart).toBe(true);
      expect(status).toBe(0);
    });

    it('costs a kind what the resources file records for it', () => {
      box.store({ e2e: { ramGB: 6, diskGB: 3 } });

      const { status, out } = box.check({ ...AMPLE, memAvailableGB: 9 }, ['--kind', 'e2e']);

      expect(out.kind).toBe('e2e');
      expect(out.cost).toEqual({ ramGB: 6, diskGB: 3 });
      expect(out.reasons).toEqual([expect.stringContaining('RAM')]);
      expect(status).toBe(2);
    });

    it('costs a kind missing from the resources file the seed', () => {
      box.store({ e2e: { ramGB: 6, diskGB: 3 } });

      const { out } = box.check(AMPLE, ['--kind', 'review']);

      expect(out.kind).toBe('review');
      expect(out.cost).toEqual(SEED);
    });

    it('reads the resources file of the main checkout from a linked worktree', () => {
      box.store({ slice: { ramGB: 3, diskGB: 2 } });

      const result = box.run([], AMPLE, box.worktree);

      expect(JSON.parse(result.stdout).cost).toEqual({ ramGB: 3, diskGB: 2 });
    });

    it('measures the machine when no measurement is given', () => {
      const result = box.run([], null);

      expect([0, 2]).toContain(result.status);
      const out = JSON.parse(result.stdout);
      expect(out).toEqual({
        canStart: result.status === 0,
        reasons: expect.any(Array),
        kind: 'slice',
        cost: SEED,
        measured: {
          memAvailableGB: expect.any(Number),
          diskFreeGB: expect.any(Number),
          load1: expect.any(Number),
          cores: expect.any(Number),
        },
      });
      expect(out.measured.memAvailableGB).toBeGreaterThan(0);
      expect(out.measured.diskFreeGB).toBeGreaterThan(0);
      expect(out.measured.cores).toBeGreaterThanOrEqual(1);
    });
  });

  describe('--record', () => {
    it('creates the resources file with the new kind, raised to at least the seed', () => {
      const result = box.run(['--record', 'e2e', '--ram', '3']);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ ramGB: 3, diskGB: 1.2 }));
      expect(box.stored()).toEqual({ kinds: { e2e: { ramGB: 3, diskGB: 1.2 } } });
    });

    it('keeps the seed when the recorded value is below it', () => {
      box.run(['--record', 'e2e', '--ram', '1', '--disk', '0.5']);

      expect(box.stored().kinds.e2e).toEqual(SEED);
    });

    it('keeps a stored disk value above the seed when no disk is recorded', () => {
      box.store({ slice: { ramGB: 2, diskGB: 5 } });

      box.run(['--record', 'slice', '--ram', '3']);

      expect(box.stored().kinds.slice).toEqual({ ramGB: 3, diskGB: 5 });
    });

    it('writes the resources file of the main checkout from a linked worktree', () => {
      const result = box.run(['--record', 'e2e', '--ram', '3'], AMPLE, box.worktree);

      expect(result.status).toBe(0);
      expect(box.stored()).toEqual({ kinds: { e2e: { ramGB: 3, diskGB: 1.2 } } });
      expect(
        fs.existsSync(
          path.join(box.worktree, '.claude', 'state', 'orchestrator', 'resources.json'),
        ),
      ).toBe(false);
    });

    it('keeps the larger of the stored and the recorded value per field', () => {
      box.store({ slice: { ramGB: 5, diskGB: 2 }, e2e: { ramGB: 7, diskGB: 4 } });

      const result = box.run(['--record', 'slice', '--ram', '3', '--disk', '4.5']);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ ramGB: 5, diskGB: 4.5 }));
      expect(box.stored()).toEqual({
        kinds: { slice: { ramGB: 5, diskGB: 4.5 }, e2e: { ramGB: 7, diskGB: 4 } },
      });
    });
  });
});
