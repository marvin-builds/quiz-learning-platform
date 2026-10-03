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
  itself. Issue #29 widens "new" to committed tests with uncommitted content
  changes (see below).
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
- **A changed approved test is gate 1 again** (issue #29). The Stop hook lets
  a committed test file with uncommitted content changes (the file on disk,
  which Jest and tsc read, differs from `HEAD`, ignoring whitespace, file mode
  and the index) be red, like a
  new test, so the agent can stop for my approval of a re-spec before it
  implements. The whole file is exempt until committed, so the changed tests
  are committed before any code changes. Once committed, the file is guarded
  as before.
- **Only an unlocked edit excuses a changed approved test** (issue #30). The
  protected-tests hook records each Edit or Write it allows on an unlocked
  committed test in `.claude/state/unlocked-edits`, and the Stop hook excuses
  a changed committed test only if it is listed there. The record outlives the
  unlock, so a re-spec stays excused at gate 1 until it is committed; the Stop
  hook drops an entry once the file matches `HEAD` again. A test changed any
  other way, for example by a shell command, blocks while red. The agent may
  not write the record, through Edit/Write or a shell command naming it.
- **Docs-only branches skip the Stop hook's checks** (issue #30). When every
  file changed since `origin/main`, committed, uncommitted or untracked, is
  Markdown or lies under `docs/` or `.github/`, the change isn't expected to
  affect Jest or tsc, so they don't run, and a worktree without
  `node_modules` isn't held up. CI still runs everything. It is an allowlist:
  any other file, including JSON and config, runs the checks as before, and
  so does a branch without an `origin/main` to compare to.
- **Known harness gaps are accepted, not chased** (issue #30). The review of
  #30 found gaps that only an agent deliberately breaking the rules, or files
  the repo doesn't have, would expose: the record of unlocked edits is pruned
  only at a stop, so a shell change in the same turn, after the re-spec was
  committed or after an allowed Edit that never ran, is still excused; the
  record can be forged by obfuscating its name in a shell command, through
  symlinked paths or on a case-insensitive file system (as the unlock marker
  can); concurrent hooks can lose an entry, which only blocks wrongly; and a
  code file under `docs/` or `.github/` would skip the local checks. My diff
  review, the reviewer agent and CI catch all of them. Rule: a harness
  finding that needs deliberate evasion, or that diff review or CI already
  catch, is recorded here as accepted risk rather than fixed, unless it bites
  in practice. The #26, #29 and #30 follow-ups showed that each review finds
  a narrower edge, while the product waits.
- **PR branches are rebased, never merged with `main`.** Branch protection
  wants a PR up to date before it merges. Bringing it up to date by merging
  `main` into the branch (GitHub's REST update-branch does exactly that) put
  "Merge branch 'main' into …" commits on `main` in #28 and #32, and `main` was
  rewritten to remove them. A PR branch that is behind is rebased onto `main`
  and force-pushed with lease; the agent may do that rebase without asking,
  since the branch is its own and unmerged. CI fails a PR whose branch
  contains a merge commit, in the required lint and test job, so a back-merge
  can't reach `main` again. `main` keeps its PR merge commits. Since slices
  now run in parallel sessions, the agent also rebases right before every
  push and checks that the new PR is mergeable: PR #43 was pushed onto a
  `main` that two other PRs had changed meanwhile, and its conflict only
  showed on GitHub.
- **The agent looks at the app in a browser** (issue #49). Jest and the e2e
  specs prove behavior but not how a screen looks at phone width, so UI
  slices also get a `ui-verifier` pass in the verify step: an agent that
  drives the running web app through the Playwright MCP server and reports
  against the acceptance criteria with screenshots. Its allowlist of tools
  leaves out the shell, Edit/Write and the browser tools that run arbitrary
  code, upload files, handle storage state or rewrite requests. It is not
  fully read-only: screenshots and snapshots take a `filename` that may name
  any file in the workspace, and clicks can change local data. Keeping
  filenames under `.claude/state/` is an instruction, accepted as a known gap
  under the rule above, since an overwrite shows in the diff and the
  protected tests' content is checked by the Stop hook and CI. A hook on the
  MCP tools can close it if it bites. The server is pinned to an exact
  version and limited to `localhost` and `127.0.0.1` origins, which keeps it
  on the local stack but is not a security boundary (Playwright doesn't
  apply it to redirects). Screenshots go to the ignored `.claude/state/`.
  The `e2e-flow` skill holds the rules for e2e specs: role and translated
  text selectors, no sleeps, a reset database per run, axe on every screen,
  and reading traces.
- **A session starts with a status check.** The agent lists the open
  Dependabot PRs and the next issue, and I decide what to work on. Security
  PRs would otherwise wait unseen, and choosing the next piece of work stays
  mine.
- **Timing tests run alone** (issue #23). A test that guards a duration
  budget, such as the warm post-edit hook run under 5 seconds, failed every
  second or third run next to the parallel Jest suite. Such tests live in
  `*.timing.test.ts`, which `npm test` and the Stop hook skip; `npm run
  test:timing` runs them serially after the suite, in `npm run -s check` and
  as a separate CI step. Other sessions can still load the machine, so the
  test takes the fastest of three warm runs: load slows some runs, a slower
  hook slows all of them. The budget stays absolute: a budget relative to a
  baseline would still measure the load it is meant to ignore.
- **Tests time out after 60 seconds** (issue #41). The first render in a test
  file loads React Native components lazily, and with a cold transform cache
  Babel compiles them inside the test's time. A change to the `jest` config
  makes the cached transforms stale, and CI always starts cold. The failure
  in #23 came from the first run after such a change, on a loaded machine.
  Machine load alone, with a warm cache, kept the render under 1 s. One cold
  suite took 4.9 s for the first render, four in parallel 25 to 33 s, against
  Jest's default of 5 s. `testTimeout` in `package.json` is 60 s for every
  test, so future screens are covered too. A test that really hangs takes up
  to a minute to fail, so a few hanging tests can push the Stop hook past its
  300 s limit.
- **In-progress issues come from git, not from a marker.** The status check
  also lists the issues that already have a `<n>-*` branch or worktree, with
  the step each is at, and the next issue skips them. So a new session
  neither proposes an issue that is being worked on nor hides one I want to
  resume. A label, assignee or status file would need upkeep at both ends of
  a slice and go stale when a session dies; the branch is the work itself.
  A session lock was considered to tell an open session from a paused one,
  and rejected: Claude Code doesn't document that `SessionEnd` runs when a
  terminal is closed or killed, nor a way for a hook to learn the session's
  process, so the lock would outlive exactly the sessions I had to quit.
  Instead, the status check reads the running sessions from
  `claude agents --json` and marks an issue "session open" when one works
  in its worktree. That list holds only live processes and shows each
  session's `cwd`, so it needs no session names, which interactive sessions
  don't show there anyway.
- **Semi-auto runs, one issue at a time** (2026-10-03). Invoking the
  `semi-auto-workflow` skill approves gate 1 and the push for one issue: the
  agent picks the next unblocked issue (its "Depends on" issues closed), runs
  `feature-slice`, commits the tests after the `reviewer` has checked them
  against the acceptance criteria (one fix pass), pushes, opens
  the PR and watches CI. It stops before the merge, which stays mine, and
  cleans up once I say the PR is merged. Gate 1 moves into the PR: the tests,
  the design choices they pin down and the assumptions are listed there, and
  a test that looks wrong still stops the run. #46 ran this way first, on an
  approval I wrote out in the prompt; the skill saves repeating it. Unlike the autopilot (#17),
  it covers one issue per invocation and never merges, so it needs no phase 1
  review first.

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
