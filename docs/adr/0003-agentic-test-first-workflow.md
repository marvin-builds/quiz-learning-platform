# ADR 0003 — Test-gated agentic workflow with Claude Code

- **Status:** Accepted (2026-10-03, planning), amended 2026-10-03 (see below)
- **Context:** quiz learning platform, how the MVP is built day to day
- **Deciders:** me, with Claude as the planning assistant
- Overview: [overview](../plan/overview.md) · Details: [MVP implementation plan](../plan/mvp-implementation-plan.md)

## Context and problem

There is one developer, working full time, and the MVP covers phases 0–3
(learner, admin and accounts, released on the web). Claude Code is meant to do
most of the implementation. The question is how much autonomy it gets, and what
keeps its output correct, especially the row-level security that hides the
correct answers from learners.

An agent left on its own tends to:

- declare work done before it's verified
- write tests that mirror its own code, or weaken tests to get them green
- loop on a problem and waste tokens instead of stopping
- drift from the intent once a session gets long

## Decision drivers

- Correctness and security first: a leaked `is_correct` or an open write
  policy is the worst failure
- High throughput for one person: the human should spend time on intent and
  review, not on typing
- Feedback in seconds, not at PR time
- Predictable cost
- The workflow lives in the repo and is versioned like the code
- I keep learning the codebase, not only approving it

## Options considered

- **Agent as assistant only** (chat and autocomplete, the human writes the code):
  - Full control and the most learning
  - Gives up most of the speed that makes one developer feasible
- **Fully autonomous agent** (the agent runs spec to PR, the human only merges,
  plus Claude in GitHub fixing issues and CI failures):
  - Fastest on paper
  - Tests the agent writes and grades itself are a weak safety net, and the
    human only sees intent mismatches at the end. More API usage that's harder
    to predict.
- **Heavy spec-driven framework** (long spec, plan and task documents before
  each feature):
  - Good traceability
  - Too much ceremony for small vertical slices and one developer, and the
    documents go stale faster than tests do
- **Test-gated agentic loop with two human gates** (chosen):
  - Acceptance criteria become failing tests, which the human approves
  - The agent iterates on its own under automatic checks, and the human
    approves the merge

## Decision

**Claude Code builds each vertical slice in a test-gated loop with two human
gates, running locally only.**

1. **One slice = one GitHub issue**, with a user story and Given/When/Then
   acceptance criteria.
2. **Tests first, written in a separate context.** A `test-writer` subagent
   turns the criteria into failing tests. **Gate 1:** I approve the tests.
   From then on they are the spec.
3. **The implementation loop runs automatically:**
   - An `implementer` subagent iterates until everything is green.
   - Hooks in `.claude/settings.json` run format, lint, typecheck and the
     tests that cover the change after every edit. Migrations trigger
     `supabase db reset` and pgTAP.
   - A `Stop` hook refuses to end the turn while tests are red.
   - A `PreToolUse` hook blocks edits to approved tests.
4. **Verification beyond unit tests:**
   - Property-based tests and mutation testing (Stryker) for domain logic
   - A positive and a negative pgTAP test per role for every RLS policy
   - Playwright end-to-end tests with an accessibility check
   - A `ui-verifier` subagent checks screenshots at phone and desktop widths
5. **Bounded review loop:** a read-only `reviewer` subagent and `/code-review`,
   at most 2–3 fix rounds. The agent commits verified work on the slice
   branch. **Gate 2:** I approve the push, the PR and the merge.
6. **Every loop has a cap:**
   - About 10 rounds to get to green, 2–3 review rounds
   - When the cap is hit, the agent stops and writes down what it tried,
     instead of guessing further
7. **Local only:**
   - No Claude GitHub Action
   - CI runs the same checks as my machine, without an agent
   - The agent has no credentials for the hosted Supabase project, and deploys
     run only through CI
8. **Parallelism:**
   - One slice at a time through phase 1
   - Then up to two git worktree sessions, each with its own local Supabase
     stack
9. **In the repo:**
   - A short `CLAUDE.md` with the rules and the definition of done
   - The procedures as project skills in `.claude/skills/`
   - The subagents in `.claude/agents/`

Phase 0 proves the workflow on the scoring function before features depend on
it.

### Amendment (2026-10-03)

- **Gate 2 moved to push.** The agent commits on its own and I approve push,
  PR and merge, in line with my general commit rule. Commits on a local
  branch are cheap to review and undo; pushing is the step that publishes.
- **The harness grows when needed.** Phase 0 builds only `CLAUDE.md`, the
  post-edit and Stop hooks, the protected-tests hook, the `test-writer` and
  `reviewer` subagents and the `feature-slice` skill. The `implementer`, the
  `ui-verifier`, the other skills and the Playwright MCP server are added by
  the first slice that needs them. A harness built before any slice has run
  would be guessed, not measured.
- **The harness lives in this repo.** After phase 1, the parts that proved
  generic (hooks, slice skill, generic agents) move to my personal Claude Code
  plugin, configured per project. Project-specific rules stay here.
- **Approved means committed** (issue #5). A test is approved once it is
  committed, after gate 1. The protected-tests hook locks committed tests, and
  the Stop hook lets new, uncommitted tests be red, so the agent can stop at
  gate 1 without a separate "waiting for approval" switch the agent could flip
  itself.
- **The Stop hook checks the whole branch** (issue #5): Jest runs the tests
  related to changes since `origin/main`, not just uncommitted ones
  (`--onlyChanged`), because the agent commits during the slice and a
  committed regression must still block. After the cap it demands an
  escalation note, and releases a few stops later even without one.
- **The test-writer is fenced by its own hook**, not by an exemption in the
  protected-tests hook: it may only write test files, and changing an
  approved test still needs my unlock.
- **I unlock from the chat** (issue #26). A message of mine that starts with
  "unlock tests" (any case) lifts the lock, "unlock tests: <paths>" only for
  those files. Any other prompt, including turns Claude Code starts itself,
  and a new session lock again. Stop doesn't: background agents keep working
  after the turn ends, and a stop the Stop hook blocks must not lose the
  unlock. Creating the marker in a separate terminal and deleting it later
  was two manual steps outside the conversation. Only the start of a message
  counts, because text quoted in an agent's report must not unlock. A
  compaction doesn't lock again (it can happen mid-turn). The marker is per
  checkout, not per session: another session in the same checkout could edit
  approved tests while it exists. Accepted, since one session works per
  worktree.

## Consequences

**Positive:**

- My review effort goes where it matters most: what the tests demand, and the
  final diff
- The agent gets feedback while it writes code, so whole classes of errors
  never reach a PR
- Tests weakened to get green, and endless loops, are blocked mechanically,
  not just by instructions
- Security rules are proven per role by tests, not by reading the code
- Costs are predictable: no agent runs in CI, and every loop is capped

**Negative, accepted:**

- **Phase 0 takes longer.** Hooks, skills, subagents and CI are real work before
  the first feature.
- **Approving tests is a bottleneck.** A slice waits for me at gate 1. Keeping
  slices small keeps this short.
- **Hooks slow down every edit.** The checks after each edit have to stay fast
  (incremental typecheck, only the affected tests), or they get in the way.
- **Mutation testing is slow.** It's limited to `src/domain/`.
- **Parallel worktrees add overhead:** migration ordering, separate ports, more
  resource use. They're deferred until phase 2 for that reason.
- **The workflow can drift.** Changes to hooks, subagents or gates are made
  deliberately, by updating or replacing this ADR.

## Review

After phase 1, check the time per slice, how often loops hit their caps,
whether bugs got past the gates, and the token cost. Then decide whether to
loosen gate 1 for low-risk slices, or to tighten the checks.
