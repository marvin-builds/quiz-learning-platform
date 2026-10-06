// PostToolUse on Edit/Write: format, lint and typecheck right after each edit,
// and rebuild the database after a migration edit, so problems come back to
// the agent within the same turn.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  bin,
  block,
  editedPath,
  ensureStateDir,
  failure,
  projectDir,
  readInput,
  relativeToProject,
  run,
  tscArgs,
} from './lib.mjs';

const input = await readInput();
const dir = projectDir(input);
const rel = relativeToProject(dir, editedPath(input));

if (rel && !rel.startsWith('node_modules/') && fs.existsSync(path.join(dir, rel))) {
  const problems = /^supabase\/migrations\/.+\.sql$/.test(rel)
    ? await checkMigration()
    : /\.[cm]?[jt]sx?$/.test(rel)
      ? await checkCode()
      : await format();
  if (problems.length > 0) {
    block(`Problems after editing ${rel}:\n\n${problems.join('\n\n')}`);
  }
}

async function checkCode() {
  ensureStateDir(dir);
  const checks = [run(bin(dir, 'eslint'), ['--fix', '--no-warn-ignored', rel], dir)];
  if (/\.tsx?$/.test(rel) && fs.existsSync(path.join(dir, 'tsconfig.json'))) {
    checks.push(run(bin(dir, 'tsc'), tscArgs(dir), dir));
  }
  const [lint, types] = await Promise.all(checks);
  const problems = [];
  if (lint.code !== 0) problems.push(failure('ESLint', lint));
  if (types && types.code !== 0) problems.push(failure('TypeScript', types));
  return problems;
}

async function format() {
  const result = await run(
    bin(dir, 'prettier'),
    ['--write', '--ignore-unknown', '--log-level', 'warn', rel],
    dir,
  );
  return result.code === 0 ? [] : [failure('Prettier', result)];
}

async function checkMigration() {
  // Without its own settings a worktree's CLI falls back to the default ports,
  // which belong to the main checkout's stack: never reset that one.
  if (isLinkedWorktree() && !fs.existsSync(path.join(dir, 'supabase', '.env.local'))) {
    return [
      'This worktree has no Supabase stack of its own (supabase/.env.local), so a reset ' +
        "would hit the main checkout's database. Run `node scripts/stack.mjs`, then " +
        '`npx supabase start`, and edit the migration again.',
    ];
  }
  const reset = await run(bin(dir, 'supabase'), ['db', 'reset'], dir);
  if (reset.setup) return [reset.output];
  if (reset.code !== 0) {
    return [
      `supabase db reset failed (is the stack running? npx supabase start):\n${reset.output.trim()}`,
    ];
  }
  const tests = await run(bin(dir, 'supabase'), ['test', 'db'], dir);
  return tests.code === 0 ? [] : [failure('pgTAP (supabase test db)', tests)];
}

function isLinkedWorktree() {
  const [gitDir, commonDir] = ['--git-dir', '--git-common-dir'].map((flag) =>
    spawnSync('git', ['rev-parse', '--path-format=absolute', flag], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim(),
  );
  return Boolean(gitDir) && gitDir !== commonDir;
}
