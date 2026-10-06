---
name: feature-slice
description: The full loop for one GitHub issue (a vertical slice) in this repo, from spec to failing tests, gate 1, green, refactor, verify, review and commit, up to gate 2 and the cleanup after the merge. Use when starting or continuing work on an issue, or when asked which step comes next.
---

# Feature slice

One issue = one slice = one branch `<issue-number>-<short-slug>` in its own
worktree, branched from an up-to-date `origin/main`. The hooks in
`.claude/settings.json` run the inner loop; this skill is the outer one.

## Resume

An issue with a `<n>-*` branch or worktree is in progress: enter its
worktree instead of creating a new one. The step comes from git and GitHub,
checked in this order (first match wins):

| Signal                                                                       | Step                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `.claude/state/escalation.md` exists                                         | Stuck: summarise it and wait                      |
| Merged PR for the branch (`gh pr list --head <branch> --state all`)          | 8, clean up                                       |
| Open PR for the branch                                                       | 7, gate 2 / CI                                    |
| Commits beyond `origin/main` (a slice starts with `Add failing tests for …`) | 3 to 7, by what the commits and `git status` show |
| Uncommitted test files only                                                  | Gate 1: present the tests again                   |
| Nothing yet                                                                  | 1, spec                                           |

Before resuming, check `claude agents --json`: it lists the running local
sessions with their `cwd`. If one works inside that worktree, say so and let
the human decide; two sessions in one worktree get in each other's way.

## 1. Spec

Read the issue (`gh issue view <n>`) and the docs it links. If an acceptance
criterion is ambiguous or untestable, ask before writing tests.

## 2. Red

Delegate to the `test-writer` agent with the issue number. Run its tests
yourself and confirm each fails for the right reason. Lint and typecheck the
test files.

**Gate 1:** stop and present the tests: a table of file → behaviors covered,
plus any design choice the tests pin down. Do not commit them yet; the stop
gate lets you end the turn because only new tests are red.

After approval, commit the tests on their own (`Add failing tests for …`).
From now on they are approved: the protect-tests hook blocks edits to them.

## 3. Green

Write the least code that makes the tests pass. The post-edit hook reports
lint and type errors after every edit, and pgTAP results after a migration
edit; fix them as they come. The stop gate won't let the turn end while
approved tests or the typecheck are red.

If a test looks wrong, do not work around it: stop and explain. Only the human
can unlock tests, by starting a message with "unlock tests" (or
"unlock tests: <paths>"); ask them to, naming the files. The unlock lasts
until their next typed message, through subagent hand-backs and task
notifications: changes to approved tests go through the `test-writer` agent
before then, with Edit/Write only: the protect-tests hook
records those edits, and the stop gate excuses a changed approved test only
when it is recorded. Changed approved tests are gate 1 again: the stop gate
lets a recorded file be red while uncommitted, so stop and let the human
approve them, then commit them on their own before changing the code.

A branch that changes only Markdown, `docs/` or `.github/` passes the stop
gate without running Jest or tsc.

Cap: about 10 attempts. When the stop gate asks for an escalation note, write
`.claude/state/escalation.md` (what you tried, what you observed, where you
are stuck), summarise it for the human and stop.

## 4. Refactor

Run `/simplify` on the change. Tests stay green, and nothing new is added.

## 5. Verify

`npm run -s check`, plus `npx supabase db reset && npx supabase test db` if
the slice touches the database (on the worktree's own stack: `npx supabase
start` there first), plus `npm run db:types` after schema changes.
For UI changes, start the app in the background on a port no other worktree
uses (`npx expo start --web --port <port>`) and delegate to the `ui-verifier`
agent with the URL and the issue's acceptance criteria: it checks phone and
desktop width in the browser and saves screenshots under
`.claude/state/ui-verifier/`. Fix what it finds before the review, then stop
the server. New or changed e2e specs follow the `e2e-flow` skill.

The Playwright MCP server (`.mcp.json`) needs approving once when Claude Code
asks, and its own browser, separate from the e2e tests' one:
`npx -y @playwright/mcp@0.0.83 install-browser chrome-for-testing` (the
version pinned in `.mcp.json`). It runs from the directory the session
started in and writes screenshots there, so start the session in the
slice's worktree; after `EnterWorktree` they land in the main checkout.

## 6. Review

Delegate to the `reviewer` agent. Fix confirmed findings, then re-check. At
most 3 review-and-fix rounds; after that, list what remains open.

## 7. Commit and gate 2

Commit verified work by concern. Update `CLAUDE.md`, the plan or an ADR in the
same branch when a decision changed.

**Gate 2:** report the commits, the verification output and any open points,
and draft the PR description (it closes the issue). Push, open the PR and
merge only after the human's go-ahead; then check that CI is green.

Other sessions merge to `main` in parallel, so right before every push run
`git fetch origin && git rebase origin/main`, then `npm run -s check` again
if anything came in. After opening the PR, check
`gh pr view <n> --json mergeable` (it may say `UNKNOWN` for a few seconds):
`CONFLICTING` means rebase again, not wait for CI.

When the PR is behind `main` ("head branch is not up to date"), rebase it;
this rebase of the slice's own unmerged branch needs no extra go-ahead:

```sh
git fetch origin && git rebase origin/main && git push --force-with-lease
```

Or on the server: the GraphQL `updatePullRequestBranch` mutation with
`updateMethod: REBASE`. Never merge `main` into the branch, and never use the
REST `pulls/<n>/update-branch` or GitHub's "Update branch" merge button: both
create a merge commit, and CI fails a PR that contains one. If the rebase
conflicts, stop and ask. Wait for CI again before merging.

## 8. Clean up after the merge

GitHub deletes the remote branch on merge. Remove the local branch and its
worktree as soon as the PR is merged; this step is the go-ahead for it, but
only when every check passes:

1. `gh pr view <n> --json state,headRefOid` says `MERGED`.
2. `git status --short` in the slice worktree is empty, and
   `git rev-parse <branch>` equals `headRefOid`, so nothing local is lost.
   Otherwise stop and ask.
3. From the main checkout, stop the worktree's own Supabase stack and delete
   its volumes, then remove the worktree. `--workdir` makes the CLI read that
   worktree's `supabase/.env.local`; a worktree without one has no stack of
   its own, and the stop would hit main's, so the `test -f` skips it:

   ```sh
   git switch main && git pull --ff-only && git fetch --prune
   wt=../quiz-learning-platform.worktrees/<branch>
   test -f $wt/supabase/.env.local && npx supabase stop --no-backup --workdir $wt
   git worktree remove $wt
   git branch -D <branch>
   ```

   `-D`, because a squash merge leaves the branch unmerged in git's eyes;
   step 2 already proved it is safe.

A session running inside that worktree cannot run git in the main checkout.
Then leave the commands from step 3 for the human to run in a normal terminal.

The cleanup ends the session's work. A session launched in the removed
worktree loads its hooks from there, so from now on none of them runs: no
locked tests, no post-edit checks, no stop gate. Don't edit anything more in
it; the next issue, or any other change, starts in a new session.
