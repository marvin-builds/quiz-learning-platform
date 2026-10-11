#!/usr/bin/env node
// Says whether the machine can take one more slice now, from what is free
// and what a slice of that kind has cost before. The orchestrator asks it
// before every start, instead of a fixed number of parallel slices (#17).
//
//   node scripts/capacity.mjs [--kind <k>]
//       prints {canStart, reasons, kind, cost, measured}; exit 0 when the
//       slice fits, 2 when it doesn't
//   node scripts/capacity.mjs --record <kind> --ram <GB> [--disk <GB>]
//       remembers a measured peak; each field keeps the largest value seen
//
// Costs live in `.claude/state/orchestrator/resources.json` of the main
// checkout, shared by its worktrees. A kind not recorded yet costs the seed:
// an idle Supabase stack (1.6 GB) and a worktree's node_modules (1.1 GB),
// measured on 2026-10-11. CAPACITY_MEASURE (JSON) replaces the measurement
// in tests.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEED = { ramGB: 1.6, diskGB: 1.2 };
// What must stay free after the slice: room for the editor, browser and an
// e2e peak, and for disk growth (Docker volumes, builds).
const RESERVE = { ramGB: 4, diskGB: 10 };
const GB = 1024 ** 3;

function mainCheckout() {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`not in a git repository:\n${result.stderr}`);
  return path.dirname(result.stdout.trim());
}

const resourcesFile = () =>
  path.join(mainCheckout(), '.claude', 'state', 'orchestrator', 'resources.json');

function readKinds(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).kinds ?? {};
  } catch {
    return {};
  }
}

function memAvailableGB() {
  try {
    const kb = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
    if (kb) return (Number(kb) * 1024) / GB;
  } catch {
    // not Linux
  }
  return os.freemem() / GB;
}

function measure() {
  if (process.env.CAPACITY_MEASURE) return JSON.parse(process.env.CAPACITY_MEASURE);
  const disk = fs.statfsSync(process.cwd());
  return {
    memAvailableGB: memAvailableGB(),
    diskFreeGB: (disk.bavail * disk.bsize) / GB,
    load1: os.loadavg()[0],
    cores: os.availableParallelism?.() ?? os.cpus().length,
  };
}

// Rounded, so 5.6 − 1.6 counts as the 4 it is.
const left = (free, cost) => Math.round((free - cost) * 1e6) / 1e6;

function check(kind) {
  const cost = { ...SEED, ...readKinds(resourcesFile())[kind] };
  const measured = measure();
  const reasons = [];
  if (left(measured.memAvailableGB, cost.ramGB) < RESERVE.ramGB) {
    reasons.push(
      `RAM: ${measured.memAvailableGB.toFixed(1)} GB available, the slice needs ${cost.ramGB} GB plus ${RESERVE.ramGB} GB reserve`,
    );
  }
  if (left(measured.diskFreeGB, cost.diskGB) < RESERVE.diskGB) {
    reasons.push(
      `disk: ${measured.diskFreeGB.toFixed(1)} GB free, the slice needs ${cost.diskGB} GB plus ${RESERVE.diskGB} GB reserve`,
    );
  }
  if (measured.load1 >= measured.cores) {
    reasons.push(`load: ${measured.load1.toFixed(2)} on ${measured.cores} cores`);
  }
  const canStart = reasons.length === 0;
  console.log(JSON.stringify({ canStart, reasons, kind, cost, measured }));
  return canStart ? 0 : 2;
}

function record(kind, ram, disk) {
  if (!kind || !(ram >= 0)) throw new Error('usage: --record <kind> --ram <GB> [--disk <GB>]');
  const file = resourcesFile();
  const kinds = readKinds(file);
  const stored = { ...SEED, ...kinds[kind] };
  kinds[kind] = {
    ramGB: Math.max(stored.ramGB, ram),
    diskGB: Math.max(stored.diskGB, disk ?? 0),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ kinds }, null, 2)}\n`);
  console.log(JSON.stringify({ kind, ...kinds[kind] }));
  return 0;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function main(args) {
  const recorded = option(args, '--record');
  if (args.includes('--record')) {
    const disk = option(args, '--disk');
    return record(
      recorded,
      Number(option(args, '--ram')),
      disk === undefined ? undefined : Number(disk),
    );
  }
  return check(option(args, '--kind') ?? 'slice');
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
