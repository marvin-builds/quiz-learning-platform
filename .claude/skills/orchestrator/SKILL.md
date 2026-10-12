---
name: orchestrator
description: Run several issues at once from the main checkout, each slice as a `slice` workflow in its own worktree, with batched gate 1, pushes, PRs, CI, rebases and stacked branches, within the machine's resources. Use when I ask to orchestrate, run slices in parallel, or invoke /orchestrator.
---

# Orchestrator

Invoking this skill is my go-ahead for what `semi-auto-workflow` allows, for
every slice it starts: gate 1 by the agent's test review (database security
still stops), commits, pushes, PRs and rebases of the slice branches. **Never
merge**; that stays mine. It is also my opt-in for the Workflow tool. The rules
of `CLAUDE.md`, `feature-slice` and `semi-auto-workflow` apply to each slice;
this skill only adds the outer loop. ADR 0003 → Amendment 2 says why.

Run it from the main checkout on an up-to-date `main`, started with the
orchestrator launcher (push authority, below). Its own context stays small:
each slice runs as a workflow and comes back as a short structured report.

## State

Everything a new orchestrator session needs to resume is in
`.claude/state/orchestrator/` of the main checkout (ignored by git):

- `log.md`: one line per event, appended as it happens: time, issue, what
  (started, gate 1, report, pushed, PR #, CI, rebased, stopped, merged), and
  for a stacked child the parent branch and the parent's tip it started from
  (needed for `rebase --onto`).
- `slices.json`: the slices in progress,
  `{ "<branch>": { issue, worktree, base, parent?, status, pr? } }`.
- `resources.json`: learned costs per slice kind (`scripts/capacity.mjs`).

On start, read them and reconcile with git and GitHub (`git worktree list`,
`gh pr list --author @me`, `claude agents --json`); git and GitHub win.

## The loop

Repeat until nothing is ready and nothing is running, then report (below).

1. **Pick.** `node scripts/slice.mjs --ready` lists the startable issues in
   order (milestone, number) and why the others wait; it skips issues labelled
   `manual` and blocked ones. Check what the script can't: conditions in
   prose ("start it only after …") and external ones (an upstream release).
   **Stacked:** an issue that waits only for one open issue whose slice has
   approved tests and a finished review (status `ready` or `pr`) may start
   as a child of that branch, one level deep (never a child of a child).
2. **Capacity.** Before each start, `node scripts/capacity.mjs --kind <k>`
   (`db` when the issue touches `supabase/`, else `app`). Exit 2: don't
   start; wait for a slice to finish or to wait on me, and stop that one's
   stack first. Never start a slice just because a number allows it; the
   script measures what is free now.
3. **Worktree.** `node scripts/slice.mjs --no-session <n>`, plus `--parent
<branch>` for a stacked child. It prints `{number, title, branch,
worktree}`. Never use workflow `isolation: 'worktree'`. Add the slice to
   `slices.json` and the log.
4. **Launch** the `slice` workflow (`.claude/workflows/slice.js`) with
   `{issue, worktree, branch, base, phase: 'all', ports: {web}, criteria}`;
   `base` is `origin/main`, or `origin/<parent>` for a child; `web` is the
   worktree's `QUIZ_E2E_PORT` (in its `.env.local`) + 1, free per worktree;
   `criteria` is the issue's acceptance criteria as text, for the
   ui-verifier, which can't read the issue itself.
   Launch every ready slice that fits, then wait for the reports (the
   notification), never poll the workflows.
5. **Report in.** By the report's `status`:
   - `ready`: rebase and push (below), open the PR.
   - `gate1` (database security): collect it. Stop the slice's stack
     (`npx supabase stop --workdir <wt>`, volumes kept).
   - `needs-human` or `stuck`: stop that slice (and its stack), tell me
     why, keep the others running.
     Log it, update `slices.json`.
6. **Batch gate 1.** When no other slice is about to report, present all
   collected gate-1 slices together: per slice the file → behaviors table,
   design choices, the test review findings and their triage. My answer
   resumes each approved slice with `phase: 'green'`, the red report's `ui`,
   and, in `notes`, my answer plus the red run's design choices and review
   triage (the test-writer can't write the decision log); start its stack
   again first. A rejected one gets my notes as `notes` and `phase: 'red'`.
7. **Escalations.** Between reports, check each worktree's
   `.claude/state/escalation.md`; one that exists stops that slice.

## Push and PR

For each `ready` slice, from the main checkout:

1. `git -C <wt> fetch origin` and `git -C <wt> rebase origin/main` (a child:
   `git -C <wt> rebase origin/<parent>`). If anything came in, rerun
   `npm run -s check` there (and `npm ci` when `package-lock.json`
   changed). A conflict stops the slice and asks me.
2. `cd <wt> && node scripts/migration-order.mjs --fix origin/main`; commit a
   rename on its own (`Move <name> after main's newest migration`), then
   rerun pgTAP. Children check against `origin/main` too, since that is
   where they end up.
3. `git -C <wt> push -u origin <branch>` (after a rebase:
   `--force-with-lease`).
4. `gh pr create --head <branch> --base main` (a child: `--base <parent>`)
   with the body `semi-auto-workflow` step 5 asks for, from the report and the
   worktree's `.claude/state/decisions.md`.
5. `gh pr view <pr> --json mergeable`; `CONFLICTING` means rebase again.
6. `gh pr checks <pr> --watch` in the background. Red CI: one fix attempt
   (a `slice` run with `phase: 'green'` and the failure as `notes`, which
   starts from green), then stop the slice and tell me.
7. Once the PR waits for my merge, stop the slice's stack.

When `main` moves, rebase the open PRs that fall behind (steps 1 to 3 and
6), one at a time. Never merge `main` into a branch.

## Stacked branches

- A child starts from its parent's branch only after the parent's review is
  done; its PR targets the parent branch.
- When the parent merges: `git -C <wt> fetch origin`,
  `git -C <wt> rebase --onto origin/main <parent tip from log.md>`, then the
  migration-order fix, push with `--force-with-lease`, and
  `gh pr edit <pr> --base main`.
- A re-spec of the parent (changed approved tests) pauses the child: stop
  it and log why; resume it once the parent's tests are approved again.

## Resources

- `scripts/capacity.mjs` decides each start from free RAM, disk and load
  against the slice kind's learned cost. After a slice's verify, record its
  stack's peak: `docker stats --no-stream` for the containers of its
  `SUPABASE_PROJECT_ID`, summed, then `node scripts/capacity.mjs --record
<kind> --ram <GB>`.
- One e2e run at a time across all worktrees: `npm run test:e2e` waits for
  the lock under the main checkout's `.claude/state/e2e.lock` by itself.
- A slice waiting for me (gate 1, merge, a question) has its stack stopped,
  volumes kept, and started again when it continues.
- Stale worktrees (no commits beyond `main`, no running session) are
  reported to me at the start; I decide whether to remove them.

## Push authority

Start the orchestrator with `npm run -s slice -- --orchestrate`: it starts
this session in the main checkout with `AI_PUSH_AUTHORITY=orchestrator`.
The personal push guard then allows pushing a branch that is checked out in
a linked worktree of this repo and listed in `ai-push-branches` in the git
common dir (`slice.mjs --no-session` adds each branch it sets up), under its
own name, never the default branch, with force at most `--force-with-lease`.
Everything else asks. Push with `git -C <wt> push …`, never `cd … && git
push` (the guard can't follow a `cd`).

## Report

When nothing runs any more, stop with a report that starts with **Decisions
to check** (every medium or low confidence entry of every slice's decision
log, with options, reason and reversal cost), then per slice: the PR link,
status, CI, open points, and which issues its merge unblocks. Then wait for
my merges; after "merged", run `feature-slice` step 8 for that slice from
the main checkout, remove its branch from `ai-push-branches`, and move its
children onto `main` (Stacked branches); a child without commits of its own
yet simply becomes a slice on `main`.
