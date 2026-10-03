---
name: feature-slice
description: The full loop for one GitHub issue (a vertical slice) in this repo, from spec to failing tests, gate 1, green, refactor, verify, review and commit, up to gate 2. Use when starting or continuing work on an issue, or when asked which step comes next.
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
can unlock tests (`.claude/state/tests-unlocked`); after an unlock, changes to
approved tests go through the `test-writer` agent.

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
