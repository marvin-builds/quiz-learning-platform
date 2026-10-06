#!/usr/bin/env node
// Gives a linked worktree its own local Supabase stack, so parallel slices
// never reset or read each other's database.
//
//   node scripts/stack.mjs [<dir>]   configure the worktree that contains <dir>
//                                    (default: the current directory)
//
// It writes two git-ignored files and leaves the committed config.toml alone:
// - `supabase/.env.local`, which the Supabase CLI loads by itself: its own
//   SUPABASE_PROJECT_ID and every port of config.toml moved by 100 per slot,
//   so every `npx supabase …` in the worktree (the hooks, `npm run db:types`)
//   talks to the worktree's stack;
// - `.env.local`, which Expo loads over `.env`: the app's API URL, and the
//   port the e2e tests serve the web export on.
// Slot 0 (the default ports) belongs to the main checkout, which stays as it
// is. A worktree keeps its slot; a new one gets the lowest slot that no other
// worktree claims and whose ports are free.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const E2E_PORT = 4173;
const STEP = 100;
const MAX_SLOT = 100;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function readEnv(file) {
  const env = new Map();
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) env.set(match[1], match[2]);
  }
  return env;
}

/**
 * project_id and every uncommented `port` / `*_port` key outside [remotes.*],
 * named as the Supabase CLI reads overrides: [db.pooler] port becomes
 * SUPABASE_DB_POOLER_PORT.
 */
function readConfig(toml) {
  const ports = [];
  let projectId;
  let section = '';
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[([^\]]+)\]/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!section) {
      projectId ??= line.match(/^project_id\s*=\s*"([^"]*)"/)?.[1];
      continue;
    }
    if (section === 'remotes' || section.startsWith('remotes.')) continue;
    const key = line.match(/^([a-z0-9_]*_port|port)\s*=\s*(\d+)/);
    if (key) {
      const prefix = section.replace(/[.-]/g, '_').toUpperCase();
      ports.push({ name: `SUPABASE_${prefix}_${key[1].toUpperCase()}`, port: Number(key[2]) });
    }
  }
  return { projectId, ports };
}

/** The slot a worktree's `supabase/.env.local` claims, if any. */
function claimedSlot(file, ports) {
  const env = readEnv(file);
  for (const { name, port } of ports) {
    const value = Number(env.get(name));
    if (Number.isInteger(value) && value > port && (value - port) % STEP === 0) {
      return (value - port) / STEP;
    }
  }
  return undefined;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function pickSlot(top, ports) {
  const own = claimedSlot(path.join(top, 'supabase', '.env.local'), ports);
  if (own) return own;
  const claimed = new Set(
    git(top, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .filter((dir) => path.resolve(dir) !== path.resolve(top))
      .map((dir) => claimedSlot(path.join(dir, 'supabase', '.env.local'), ports)),
  );
  for (let slot = 1; slot <= MAX_SLOT; slot += 1) {
    if (claimed.has(slot)) continue;
    const free = await Promise.all(ports.map(({ port }) => portFree(port + STEP * slot)));
    if (free.every(Boolean)) return slot;
  }
  throw new Error(`No free port slot up to ${MAX_SLOT}.`);
}

/** Sets `values` in an env file: replaces those keys in place, appends the rest. */
function writeEnv(file, header, values) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [header];
  if (lines.at(-1) === '') lines.pop();
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${updated.join('\n')}\n`);
}

async function main(args) {
  const top = git(path.resolve(args[0] ?? '.'), 'rev-parse', '--show-toplevel');
  const config = path.join(top, 'supabase', 'config.toml');
  if (!fs.existsSync(config)) return;
  const gitDir = git(top, 'rev-parse', '--path-format=absolute', '--git-dir');
  const commonDir = git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (gitDir === commonDir) {
    console.log('Main checkout: keeps the default ports from supabase/config.toml.');
    return;
  }

  const { projectId = 'supabase', ports } = readConfig(fs.readFileSync(config, 'utf8'));
  const slot = await pickSlot(top, ports);
  const name = path
    .basename(top)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  const header = '# Written by scripts/stack.mjs: this worktree runs its own local Supabase stack.';

  const stack = { SUPABASE_PROJECT_ID: `${projectId}-${name}` };
  for (const { name: key, port } of ports) stack[key] = port + STEP * slot;
  writeEnv(path.join(top, 'supabase', '.env.local'), header, stack);

  const api = stack.SUPABASE_API_PORT;
  const app = { QUIZ_E2E_PORT: E2E_PORT + STEP * slot };
  if (api) app.EXPO_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${api}`;
  writeEnv(path.join(top, '.env.local'), header, app);

  console.log(
    `Stack ${stack.SUPABASE_PROJECT_ID}: slot ${slot}, API ${api}, DB ${stack.SUPABASE_DB_PORT}.`,
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
