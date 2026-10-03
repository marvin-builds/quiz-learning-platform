---
name: semi-auto-workflow
description: Runs one issue end to end without stopping at the gates - picks the next unblocked issue (or the one given), reviews its spec, works the feature-slice loop on its own, pushes, opens the PR and watches CI, then stops before the merge with a report of the decisions to check. On "merged", cleans up. Use when I invoke it or ask to "continue with the next issue" on my own.
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

Once the issue is picked, give me a short summary of it before the worktree,
then carry on without waiting for an answer:

- **For the user:** what changes from the perspective of the people who use
  the app (anonymous player, learner, admin): what they can do or see
  afterwards that they couldn't before, and how it feels in use.
- **Technical details,** where they help to follow the run: the tables,
  functions, policies or screens it adds or changes, what it builds on and
  which issues it unblocks.

Base it on the issue and the docs it links; it is a briefing, not the spec
review (step 4).

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

## 3. Decision log

Every judgment call that the issue, the docs or the tests don't settle goes
into `.claude/state/decisions.md` in the worktree (ignored by git, so it
survives a context compaction without ending up in a commit). Record it when
you make it, not afterwards:

- **Decision**, and where it lands (file, test, column, message);
- **Options** considered, and why this one;
- **Confidence**: high, medium or low;
- **Reversal cost**: what changing it later would take (a migration, a locked
  test, a public API).

Typical entries: a conservative reading of an ambiguous criterion, a design
choice the tests pin down, a review finding rejected or deferred, a deviation
from the issue or the plan. Medium and low confidence entries are the ones I
want to see; never drop them from the report.

## 4. Work the slice

Follow `feature-slice` steps 1 to 6, with these differences.

### Spec review, before any test

The tests make the spec binding, so first check that the spec is right, not
only clear. Delegate a read-only review to the `reviewer` agent: the issue,
the docs it links (overview, plan, ADRs) and the code it builds on, with this
lens:

- does each criterion serve the issue's goal and the use case in
  `docs/plan/overview.md` (who uses it, how), or does it build something the
  user doesn't need, or miss something they do;
- does it contradict the plan, an ADR, a never-break rule in `CLAUDE.md`, or
  an earlier slice's code;
- is it complete: edge cases, roles, error paths, what the next slices will
  need from it;
- is each criterion testable and unambiguous.

Triage the findings:

- **A conflict with the goal, the plan or an ADR, or a criterion that would
  build the wrong thing:** stop and ask me before writing tests. That is a
  question about direction, which is mine.
- **An ambiguity or a gap with a reasonable answer:** take the most
  conservative reading, tell the `test-writer`, and log it (step 3).
- **Nothing found:** note "spec review: PASS" for the report.

### Gate 1 doesn't stop, but the tests get the review I would give them

Once committed they are locked, and only I can unlock them, so review them
while they are still new, following `quality-review-loop`:

1. Run the `test-writer`'s tests yourself and confirm each fails for the
   right reason (a missing table or function, not a typo or a broken
   fixture).
2. Delegate a review of the uncommitted test files to the `reviewer` agent,
   with the reviewed spec (including the readings from the spec review) as
   the contract and this lens: every criterion is covered; each policy has a
   positive and a negative test per role (`anon`, learner, admin, plus an
   anonymous user where the issue names one); a test can't pass for the
   wrong reason (vacuous assertions, fixtures that hide the case); no test
   pins behavior the spec doesn't ask for, unless it is logged as a design
   choice; the tests can pass at all once implemented.
3. Triage every finding (accept, reject with a reason, defer) and log the
   rejected and deferred ones. Fixes go through the `test-writer` while the
   files are uncommitted; rerun them and confirm they still fail for the
   right reason. One fix pass; if a fresh review still finds a blocker, stop
   and ask me.
4. Log the design choices the tests pin down, then commit the tests on their
   own (`Add failing tests for …`).

### During green, refactor and review

- **A test that looks wrong** still stops the run: explain why and ask me to
  unlock, as in `feature-slice` step 3.
- **Review findings** that would need a change to a locked test become open
  points in the PR, not fixes.
- Log implementation choices that go beyond the tests (a helper vs. a
  subquery, an extra constraint, a deviation from a doc).

## 5. Verify, push, PR

1. `npm run -s check`; pgTAP (`npx supabase db reset && npx supabase test db`)
   and `npm run db:types` when the database changed; `npm run test:e2e` when
   the app or the e2e setup changed; the `ui-verifier` for UI changes, as in
   `feature-slice` step 5. After `EnterWorktree` the Playwright MCP server
   still runs in the main checkout, so its screenshots land there, under
   `.claude/state/ui-verifier/`. Commit by concern.
2. `git fetch origin` and `git rebase origin/main`. If anything came in, run
   `npm ci` when `package-lock.json` changed, then repeat the verification.
3. `git push -u origin <branch>`, then `gh pr create` with a body that
   `Closes #<n>` and lists: what changed, the gate-1 table (file →
   behaviors), the spec review result, every entry of the decision log
   (uncertain ones first), the verification output, and open points.
4. `gh pr view <n> --json mergeable`; `CONFLICTING` means rebase again.
5. `gh pr checks <n> --watch`. Fix red CI (that counts toward the caps). When
   `supabase/config.toml` changed, read the "Hosted config diff" job's output
   and confirm it shows only the intended changes.

## 6. Report and wait

Stop with a report that always starts with **Decisions to check**: every
medium or low confidence entry of the decision log, each with the options,
the reason and the reversal cost, or the line "none: every decision was
settled by the issue or made with high confidence". Then: the PR link, the
commits, the verification and CI results, the spec and test review results,
open points, and which issue the merge unblocks. Then wait for my merge.

## 7. After "merged"

Run `feature-slice` step 8. Its checks (`MERGED`, a clean worktree, the
local branch at `headRefOid`) are the go-ahead. To reach the main checkout,
leave the worktree with `ExitWorktree` (`keep`), then run step 8's commands
there. Finish by naming the next unblocked issue and asking whether to start
it; don't start it on your own.
