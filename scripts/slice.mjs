#!/usr/bin/env node
// Starts a Claude Code session for one issue inside its worktree, so the
// session never has to switch directories (and ask for that) mid-run.
//
//   npm run -s slice            pick the next issue, confirm, start it
//   npm run -s slice -- <n>     start or resume issue <n>
//   npm run -s slice -- --pick  print the next issue as JSON, change nothing
//
// The pick: open issues by milestone, then number; skip one that has a
// `<n>-*` branch (local or on origin) or whose "Depends on #n" issues are
// still open. Worktrees go to `<main checkout>.worktrees/<n>-<slug>`, where
// GitKraken puts them too.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

const git = (...args) => run('git', args);
const gh = (...args) => JSON.parse(run('gh', args));

const FIELDS = 'number,title,milestone,body';

function slug(title) {
  const words = title
    .replace(/^\d+(\.\d+)*\s+/, '')
    .split(':')[0]
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.slice(0, 4).join('-');
}

function dependencies(issue) {
  return issue.body
    .split('\n')
    .filter((line) => /depends on/i.test(line))
    .flatMap((line) => [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
}

function branches() {
  return git('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin')
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.replace(/^origin\//, ''));
}

function worktrees() {
  return git('worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((entry) => ({
      path: entry.match(/^worktree (.+)$/m)?.[1],
      branch: entry.match(/^branch refs\/heads\/(.+)$/m)?.[1],
    }));
}

const ownBranch = (names, number) => names.find((name) => name.startsWith(`${number}-`));

function pick() {
  const open = gh('issue', 'list', '--state', 'open', '--limit', '200', '--json', FIELDS);
  const openNumbers = new Set(open.map((issue) => issue.number));
  const existing = branches();
  const waits = [];
  const sorted = [...open].sort(
    (a, b) =>
      (a.milestone?.number ?? Infinity) - (b.milestone?.number ?? Infinity) || a.number - b.number,
  );
  for (const issue of sorted) {
    const branch = ownBranch(existing, issue.number);
    const blockers = dependencies(issue).filter((n) => openNumbers.has(n));
    if (branch) waits.push(`#${issue.number}: in progress (branch ${branch})`);
    else if (blockers.length) {
      waits.push(`#${issue.number}: waits for ${blockers.map((n) => `#${n}`).join(', ')}`);
    } else return { issue, waits };
  }
  return { issue: undefined, waits };
}

// The issue's worktree: an existing one, one for its existing branch, or a
// new branch from origin/main without an upstream, so a bare `git push` can
// never target main.
function worktreeFor(issue, root) {
  const found = worktrees().find((w) => w.branch?.startsWith(`${issue.number}-`));
  if (found) return found.path;
  const local = ownBranch(git('branch', '--format=%(refname:short)').split('\n'), issue.number);
  const branch =
    local ?? ownBranch(branches(), issue.number) ?? `${issue.number}-${slug(issue.title)}`;
  const dir = path.join(`${root}.worktrees`, branch);
  if (local) git('worktree', 'add', '-q', dir, branch);
  else {
    const remote = ownBranch(branches(), issue.number) ? `origin/${branch}` : 'origin/main';
    git('worktree', 'add', '-q', '--no-track', '-b', branch, dir, remote);
  }
  return dir;
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise((resolve) => rl.once('close', () => resolve('')));
  const answer = await Promise.race([rl.question(question), closed]);
  rl.close();
  return !/^n/i.test(answer.trim());
}

async function main(args) {
  const root = path.dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  git('fetch', '-q', 'origin');

  let issue;
  if (args[0] && args[0] !== '--pick') {
    issue = gh('issue', 'view', args[0], '--json', `${FIELDS},state`);
    if (issue.state !== 'OPEN') {
      console.error(`#${issue.number} is ${issue.state.toLowerCase()}.`);
      return 1;
    }
  } else {
    const result = pick();
    if (!result.issue) {
      console.error(['No open issue can start now:', ...result.waits].join('\n'));
      return 1;
    }
    issue = result.issue;
    if (args[0] === '--pick') {
      const branch = `${issue.number}-${slug(issue.title)}`;
      console.log(JSON.stringify({ number: issue.number, title: issue.title, branch }));
      return 0;
    }
    const milestone = issue.milestone ? ` (${issue.milestone.title})` : '';
    console.log(`Next issue: #${issue.number} ${issue.title}${milestone}`);
    // Conditions in prose ("start it only if …") are mine to judge.
    for (const line of issue.body.split('\n')) {
      if (/start it only/i.test(line)) console.log(`  ${line.trim()}`);
    }
    if (!(await confirm('Start it? [Y/n] '))) {
      console.log('Nothing started.');
      return 1;
    }
  }

  const dir = worktreeFor(issue, root);
  console.log(`Worktree: ${dir}`);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    run('npm', ['ci'], { cwd: dir, stdio: 'inherit' });
  }
  const session = spawnSync('claude', [`/semi-auto-workflow ${issue.number}`], {
    cwd: dir,
    stdio: 'inherit',
  });
  return session.status ?? 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
