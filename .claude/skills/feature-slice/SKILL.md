---
name: feature-slice
description: The full loop for one GitHub issue (a vertical slice) in this repo, from spec to failing tests, gate 1, green, refactor, verify, review and commit, up to gate 2 and the cleanup after the merge. Use when starting or continuing work on an issue, or when asked which step comes next.
---

# Feature slice

One issue = one slice = one branch `<issue-number>-<short-slug>` in its own
worktree, branched from an up-to-date `origin/main`. The hooks in
`.claude/settings.json` run the inner loop; this skill is the outer one.

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
that turn: changes to approved tests go through the `test-writer` agent
within it.

Cap: about 10 attempts. When the stop gate asks for an escalation note, write
`.claude/state/escalation.md` (what you tried, what you observed, where you
are stuck), summarise it for the human and stop.

## 4. Refactor

Run `/simplify` on the change. Tests stay green, and nothing new is added.

## 5. Verify

`npm run -s check`, plus `npx supabase db reset && npx supabase test db` if
the slice touches the database, plus `npm run db:types` after schema changes.
Look at UI changes in the running app (`npx expo start --web`) at phone and
desktop width.

## 6. Review

Delegate to the `reviewer` agent. Fix confirmed findings, then re-check. At
most 3 review-and-fix rounds; after that, list what remains open.

## 7. Commit and gate 2

Commit verified work by concern. Update `CLAUDE.md`, the plan or an ADR in the
same branch when a decision changed.

**Gate 2:** report the commits, the verification output and any open points,
and draft the PR description (it closes the issue). Push, open the PR and
merge only after the human's go-ahead; then check that CI is green.

## 8. Clean up after the merge

GitHub deletes the remote branch on merge. Remove the local branch and its
worktree as soon as the PR is merged; this step is the go-ahead for it, but
only when every check passes:

1. `gh pr view <n> --json state,headRefOid` says `MERGED`.
2. `git status --short` in the slice worktree is empty, and
   `git rev-parse <branch>` equals `headRefOid`, so nothing local is lost.
   Otherwise stop and ask.
3. From the main checkout:

   ```sh
   git switch main && git pull --ff-only && git fetch --prune
   git worktree remove ../quiz-learning-platform.worktrees/<branch>
   git branch -D <branch>
   ```

   `-D`, because a squash merge leaves the branch unmerged in git's eyes;
   step 2 already proved it is safe.

A session running inside that worktree cannot run git in the main checkout.
Then leave the commands from step 3 for the human to run in a normal terminal.
