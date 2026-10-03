---
name: semi-auto-workflow
description: Runs one issue end to end without stopping at the gates - picks the next unblocked issue (or the one given), works the feature-slice loop on its own, pushes, opens the PR and watches CI, then stops before the merge. On "merged", cleans up. Use when I invoke it or ask to "continue with the next issue" on my own.
argument-hint: '[issue-number]'
---

# Semi-auto workflow

Invoking this skill is my go-ahead for everything up to the merge of one
issue: gate 1 (the tests), commits, push, PR and rebases of the slice's own
branch. **Never merge**; that stays mine. Everything else in `feature-slice`
and `CLAUDE.md` applies unchanged: the hooks, the caps, the locked tests and
the never-break rules. The approval covers this one issue; the next one needs
a new invocation.

## 1. Pick the issue

With an issue number as argument, take that one, but check its dependencies
first (below). Without one, run the session-start check from `CLAUDE.md` →
Workflow, then take the first open issue (lowest open milestone, then lowest
number) that:

- has no `<n>-*` branch or worktree yet (in progress, maybe in another
  session);
- isn't blocked: every issue named in its body as "Depends on #n" is closed,
  and an issue that says "start it only after …" has those closed too;
- isn't waiting on an external condition stated in its body (e.g. an
  upstream release; check it, such as `npm view <pkg> dist-tags`).

If none qualifies, stop and report a table of issue → what it waits for. Do
not start a blocked issue.

## 2. Worktree

Create it per `working-in-worktrees`, without tracking `origin/main`, so a
bare `git push` can never target `main`:

```sh
git fetch origin
git worktree add --no-track -b <n>-<slug> ../quiz-learning-platform.worktrees/<n>-<slug> origin/main
```

Enter it with `EnterWorktree`, then `npm ci` there. Inside the worktree,
run git as plain, separate commands (no `cd … &&` chains, no `-C`): the
worktree guard refuses commands it can't verify.

## 3. Work the slice

Follow `feature-slice` steps 1 to 6, with these differences:

- **Spec:** an ambiguous criterion gets the most conservative reading; note
  it for the PR description instead of asking.
- **Gate 1 doesn't stop.** Run the `test-writer`'s tests yourself and confirm
  they fail for the right reason. Then read them before committing: once
  committed they are locked, and only I can unlock them. Commit them on their
  own (`Add failing tests for …`); the gate-1 table goes into the PR.
- **A test that looks wrong** still stops the run: explain why and ask me to
  unlock, as in `feature-slice` step 3.
- **Review findings** that would need a change to a locked test become open
  points in the PR, not fixes.

## 4. Verify, push, PR

1. `npm run -s check`; pgTAP (`npx supabase db reset && npx supabase test db`)
   and `npm run db:types` when the database changed; `npm run test:e2e` when
   the app or the e2e setup changed. Commit by concern.
2. `git fetch origin` and `git rebase origin/main`. If anything came in, run
   `npm ci` when `package-lock.json` changed, then repeat the verification.
3. `git push -u origin <branch>`, then `gh pr create` with a body that
   `Closes #<n>` and lists: what changed, the design choices the tests pin
   down, the assumptions from the spec, the verification output, and open
   points.
4. `gh pr view <n> --json mergeable`; `CONFLICTING` means rebase again.
5. `gh pr checks <n> --watch`. Fix red CI (that counts toward the caps). When
   `supabase/config.toml` changed, read the "Hosted config diff" job's output
   and confirm it shows only the intended changes.

## 5. Report and wait

Stop with: the PR link, the commits, the verification and CI results, the
design choices and assumptions, open points, and which issue becomes
unblocked by the merge. Then wait for my merge.

## 6. After "merged"

Run `feature-slice` step 8. Its checks (`MERGED`, a clean worktree, the
local branch at `headRefOid`) are the go-ahead. To reach the main checkout,
leave the worktree with `ExitWorktree` (`keep`), then run step 8's commands
there. Finish by naming the next unblocked issue and asking whether to start
it; don't start it on your own.
