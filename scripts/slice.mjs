#!/usr/bin/env node
// Starts a Claude Code session for one issue inside its worktree, so the
// session never has to switch directories (and ask for that) mid-run.
//
//   npm run -s slice            pick the next issue, confirm, start it
//   npm run -s slice -- <n>     start or resume issue <n>
//   npm run -s slice -- --pick  print the next issue as JSON, change nothing
//
// For the orchestrator (#17):
//   npm run -s slice -- --orchestrate   start the orchestrator session in the
//                                       main checkout, with push authority for
//                                       the branches it sets up
//   npm run -s slice -- --ready         print every issue that can start, and
//                                       why the others wait, as JSON
//   npm run -s slice -- --no-session <n> [--parent <branch>]
//       set up issue <n>'s worktree without a session and print it as JSON;
//       a new branch starts from <branch> (a stacked child) instead of main
//
// The pick: open issues by milestone, then number; skip one that has a
// `<n>-*` branch (local or on origin), is labelled `manual`, or whose
// "Depends on #n" issues are still open. Worktrees go to `<main checkout>.worktrees/<n>-<slug>`, where
// GitKraken puts them too.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

const git = (...args) => run('git', args);
const gh = (...args) => JSON.parse(run('gh', args));

const FIELDS = 'number,title,milestone,body,labels';
const FILLER = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

function slug(title) {
  const words = title
    .replace(/^\d+(\.\d+)*\s+/, '')
    .split(':')[0]
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  while (words.length > 1 && FILLER.has(words.at(-1))) words.pop();
  return words.join('-');
}

// The issues right after "Depends on", joined by commas, "and" or spaces; the
// list ends at anything else, so "Depends on #79; blocks #80" names only #79.
const DEPENDS_ON = /depends on((?:[\s,]*(?:and\s+)?#\d+)+)/gi;

function dependencies(issue) {
  return [...issue.body.matchAll(DEPENDS_ON)].flatMap((list) =>
    [...list[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
  );
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

const isManual = (issue) => (issue.labels ?? []).some((label) => label.name === 'manual');

/** Every open issue in pick order, as ready or waiting (with the reason). */
function survey() {
  const open = gh('issue', 'list', '--state', 'open', '--limit', '200', '--json', FIELDS);
  const openNumbers = new Set(open.map((issue) => issue.number));
  const existing = branches();
  const ready = [];
  const waiting = [];
  const sorted = [...open].sort(
    (a, b) =>
      (a.milestone?.number ?? Infinity) - (b.milestone?.number ?? Infinity) || a.number - b.number,
  );
  for (const issue of sorted) {
    const branch = ownBranch(existing, issue.number);
    const blockers = dependencies(issue).filter((n) => openNumbers.has(n));
    let reason;
    if (branch) reason = `in progress (branch ${branch})`;
    else if (isManual(issue)) reason = 'manual';
    else if (blockers.length) reason = `waits for ${blockers.map((n) => `#${n}`).join(', ')}`;
    if (reason) waiting.push({ issue, reason });
    else ready.push(issue);
  }
  return { ready, waiting };
}

function pick() {
  const { ready, waiting } = survey();
  return {
    issue: ready[0],
    waits: waiting.map(({ issue, reason }) => `#${issue.number}: ${reason}`),
  };
}

// The issue's worktree: an existing one, one for its existing branch, or a
// new branch from origin/main without an upstream, so a bare `git push` can
// never target main.
function worktreeFor(issue, root, parent) {
  const found = worktrees().find((w) => w.branch?.startsWith(`${issue.number}-`));
  if (found) return found.path;
  const local = ownBranch(git('branch', '--format=%(refname:short)').split('\n'), issue.number);
  const branch =
    local ?? ownBranch(branches(), issue.number) ?? `${issue.number}-${slug(issue.title)}`;
  const dir = path.join(`${root}.worktrees`, branch);
  if (local) git('worktree', 'add', '-q', dir, branch);
  else {
    const remote = ownBranch(branches(), issue.number) ? `origin/${branch}` : baseOf(parent);
    git('worktree', 'add', '-q', '--no-track', '-b', branch, dir, remote);
  }
  return dir;
}

// A stacked child starts from its parent's branch: the pushed one if there
// is one, else the local one.
function baseOf(parent) {
  if (!parent) return 'origin/main';
  const remote = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/remotes/origin/${parent}`]);
  return remote.status === 0 ? `origin/${parent}` : parent;
}

// The personal push guard lets an orchestrator session push the branches
// listed here (one per line, in the git common dir).
function allowPush(branch) {
  const file = path.join(
    git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    'ai-push-branches',
  );
  const listed = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    : [];
  if (!listed.includes(branch)) fs.writeFileSync(file, [...listed, branch, ''].join('\n'));
}

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
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
  if (args[0] === '--orchestrate') {
    const session = spawnSync('claude', ['-n', 'orchestrator', '/orchestrator'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, AI_PUSH_AUTHORITY: 'orchestrator' },
    });
    return session.status ?? 1;
  }
  git('fetch', '-q', 'origin');

  if (args[0] === '--ready') {
    const { ready, waiting } = survey();
    const brief = (issue) => ({
      number: issue.number,
      title: issue.title,
      branch: `${issue.number}-${slug(issue.title)}`,
    });
    console.log(
      JSON.stringify({
        ready: ready.map(brief),
        waiting: waiting.map(({ issue, reason }) => ({ number: issue.number, reason })),
      }),
    );
    return 0;
  }

  // Without a session, stdout carries only the JSON line for the orchestrator.
  const noSession = args[0] === '--no-session';
  if (noSession) args = args.slice(1);
  const say = noSession ? console.error : console.log;
  const quiet = noSession ? ['inherit', process.stderr, 'inherit'] : 'inherit';

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

  const dir = worktreeFor(issue, root, noSession ? option(args, '--parent') : undefined);
  say(`Worktree: ${dir}`);
  // Its own Supabase stack settings; the script next to this one, since an
  // older worktree may predate it.
  run(process.execPath, [path.join(import.meta.dirname, 'stack.mjs'), dir], { stdio: quiet });
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    run('npm', ['ci'], { cwd: dir, stdio: quiet });
  }
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  if (noSession) {
    allowPush(branch);
    console.log(
      JSON.stringify({ number: issue.number, title: issue.title, branch, worktree: dir }),
    );
    return 0;
  }
  // Named after the branch, so the terminal title and /resume show the issue.
  // AI_PUSH_AUTHORITY lets the personal push guard allow pushes of this
  // session's own branch (never main) without a prompt.
  const session = spawnSync('claude', ['-n', branch, `/semi-auto-workflow ${issue.number}`], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, AI_PUSH_AUTHORITY: '1' },
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
