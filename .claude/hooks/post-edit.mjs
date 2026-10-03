// PostToolUse on Edit/Write: format, lint and typecheck right after each edit,
// and rebuild the database after a migration edit, so problems come back to
// the agent within the same turn.
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
