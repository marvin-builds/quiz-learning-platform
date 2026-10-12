#!/usr/bin/env node
// Keeps a branch's migrations after the base's newest one. CI on main runs
// `supabase db push` without `--include-all`, which refuses a migration older
// than the newest one already applied; a branch that waited (a stacked child,
// a long review) can fall behind main's migrations.
//
//   node scripts/migration-order.mjs [<base>]        list the branch's
//       migrations not newer than <base>'s newest (default origin/main);
//       exit 1 when there are any
//   node scripts/migration-order.mjs --fix [<base>]  rename them with git mv
//       to <base>'s newest + 1 s, + 2 s, …, in their order; a later branch
//       migration moves along when a renamed one would reach it. Content
//       stays as it is; the renames are staged, not committed.
//
// The branch's migrations are the files added under supabase/migrations/
// since the merge base with <base>.
import { spawnSync } from 'node:child_process';

const DIR = 'supabase/migrations/';
const NAME = /^(\d{14})_.+\.sql$/;

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

const timestamp = (file) => file.slice(DIR.length).match(NAME)?.[1];
const migrations = (list) => list.split('\n').filter((file) => timestamp(file));

function nextSecond(stamp) {
  const [, y, mo, d, h, mi, s] = stamp.match(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/).map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d, h, mi, s + 1));
  return next.toISOString().replace(/\D/g, '').slice(0, 14);
}

function main(args) {
  const fix = args.includes('--fix');
  const base = args.find((arg) => arg !== '--fix') ?? 'origin/main';
  const newest = migrations(git('ls-tree', '-r', '--name-only', base, '--', DIR))
    .map(timestamp)
    .sort()
    .at(-1);
  if (!newest) return 0;
  const fork = git('merge-base', base, 'HEAD');
  const added = migrations(
    git('diff', '--name-only', '--diff-filter=A', fork, 'HEAD', '--', DIR),
  ).sort();

  if (!fix) {
    const stale = added.filter((file) => timestamp(file) <= newest);
    for (const file of stale) console.log(file);
    return stale.length ? 1 : 0;
  }
  let last = newest;
  for (const file of added) {
    if (timestamp(file) > last) {
      last = timestamp(file);
      continue;
    }
    last = nextSecond(last);
    const renamed = `${DIR}${last}${file.slice(DIR.length + 14)}`;
    git('mv', file, renamed);
    console.log(`${file} → ${renamed}`);
  }
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
