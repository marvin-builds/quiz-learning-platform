# MVP implementation plan

Builds on the [overview](overview.md), [ADR 0001](../adr/0001-expo-react-native-client.md),
[ADR 0002](../adr/0002-supabase-backend.md) and
[ADR 0003](../adr/0003-agentic-test-first-workflow.md) (the workflow below). Stack and data model are not
repeated here.

## 1. What "MVP" means

**MVP = phases 0–3 of the overview, released on the web.**

- Learners browse categories, play quizzes (single and multiple choice, images,
  explanations) anonymously, and see their result.
- Admins create, edit, reorder and publish content with images in the browser.
- Optional account: email + password or magic link, the anonymous session is
  kept, progress and score history. No OAuth in the MVP, which also avoids the
  Sign in with Apple requirement until the store release.
- UI in German and English (i18n from day one).

**Not in the MVP:** store release (phase 4), Realtime, desktop, multilingual
content, offline. Android and iOS are smoke-tested in an Expo dev build
throughout, so mobile doesn't drift, but they aren't released.

**MVP is done when** the three end-to-end flows in section 5 pass in CI against
a fresh local Supabase stack, the pgTAP security suite is green, and the web
build is deployed with Impressum and privacy policy.

## 2. Working model: agent builds, human decides

One developer plus Claude Code as the main implementer. The human owns **what**
(specs, acceptance criteria, approving tests) and **whether** (merges,
security-relevant changes). The agent owns **how**, inside a loop that checks
itself automatically.

Three principles carry the whole plan:

1. **Tests are the spec the agent works against.** Acceptance criteria become
   failing tests before any production code. The agent iterates until they
   pass, not until it "thinks it's done".
2. **Feedback is automatic and fast.** Hooks run format, lint, typecheck and
   the relevant tests after every edit and before the agent may stop, so errors
   come back to the agent within seconds, not at PR time.
3. **Loops are bounded and gated.** Every automatic loop has an iteration cap
   and escalates to the human instead of looping forever or weakening tests.

## 3. Agentic harness (built in phase 0, before features)

The harness is code in the repo, versioned and reviewed like the app.

### 3.1 Project instructions

- **`CLAUDE.md`** (short, under ~150 lines): commands, folder layout, the
  definition of done, the TDD rule, "never edit an approved test to make it
  pass", security rules (RLS, `submit_answer`), i18n rule (no hard-coded UI
  strings).
- Deeper procedures go into **project skills** in `.claude/skills/` so they load
  only when needed:
  - `db-migration`: new migration → pgTAP test first → `supabase db reset` →
    regenerate `src/types/database.ts`
  - `feature-slice`: the full loop in section 4
  - `e2e-flow`: writing and debugging Playwright tests, including screenshots
  - `rls-policy`: patterns and the mandatory negative tests for each policy

### 3.2 Hooks: the automatic inner loop

In `.claude/settings.json`:

| Hook | Runs | Effect |
|---|---|---|
| `PostToolUse` on Edit/Write | Prettier + ESLint on the file, `tsc --noEmit` (incremental) | Errors are fed straight back to the agent |
| `PostToolUse` on Edit/Write of `supabase/migrations/*` | `supabase db reset` + `supabase test db` | Schema and RLS errors surface immediately |
| `PreToolUse` on Edit/Write of approved test files | Block, unless the task is explicitly "change tests" | Stops the agent from weakening tests to get green |
| `Stop` | `jest --onlyChanged` + typecheck; exit 2 if red | The agent can't end its turn with failing tests |

Plus a permission allowlist for the safe commands (`npm test`, `npx tsc`,
`supabase start/db reset/test db`, `npx playwright test`) so loops run without
prompts, while `git push`, deploys and prod database access stay manual.

### 3.3 Subagents with separate roles

Defined in `.claude/agents/`:

- **test-writer**: turns acceptance criteria into failing tests. May only write
  under `__tests__/`, `supabase/tests/`, `e2e/`. Writing tests in a separate
  context from the implementation avoids tests that just mirror the code.
- **implementer**: makes the tests pass. May not touch approved tests (hook
  above).
- **reviewer** (read-only): checks the diff for correctness, RLS gaps, hidden
  `is_correct` leaks, untranslated strings, missing negative tests. Runs as
  `/code-review` or as an independent agent before every PR.
- **ui-verifier**: drives the running web app with the Playwright MCP server,
  takes screenshots on phone and desktop widths and compares them to the
  acceptance criteria. Catches what unit tests can't (layout, empty states).

### 3.4 Tooling

- **MCP servers:** Playwright (browser verification). GitHub Issues and PRs
  through the `gh` CLI. The local Supabase stack is reached through the CLI,
  never the hosted project.
- **Git worktrees:** one per issue. Sequential (one slice at a time) through
  phase 1 while the harness matures; from phase 2 on, up to **two** parallel
  worktree sessions (e.g. a learner slice and an admin slice). Rules for
  parallel work: migrations get timestamps at merge time, not at creation, and
  each worktree runs its own local Supabase stack on separate ports.
- **CI (GitHub Actions):** lint, typecheck, Jest with coverage, `supabase start`
  + `supabase test db`, Playwright against the web build, axe accessibility
  check. The same commands as locally, so "green locally" means "green in CI".
- **Claude runs locally only.** No Claude GitHub Action: the review step is
  `/code-review` plus the reviewer subagent in the local session, before the
  PR is opened. Keeps API costs predictable.

## 4. The feature loop (one vertical slice)

Each GitHub issue is one vertical slice (DB → API → UI → e2e), small enough for
one session (roughly half a day to two days of work).

```
  ┌─ 1. Spec ───────────── human writes issue: user story + Given/When/Then
  │
  ├─ 2. Red ────────────── test-writer: pgTAP / Jest / RNTL / Playwright tests
  │                        all fail for the right reason
  │   ▶ HUMAN GATE: review and approve the tests (the real spec)
  │
  ├─ 3. Green ──────────── implementer iterates; hooks give feedback per edit;
  │                        Stop hook refuses to end while red   (cap: ~10 rounds)
  │
  ├─ 4. Refactor ───────── /simplify; tests stay green
  │
  ├─ 5. Verify ─────────── full suite + ui-verifier screenshots (web + phone
  │                        width) + mutation testing on changed domain logic
  │
  ├─ 6. Review loop ────── reviewer → fix → re-check   (cap: 2–3 rounds)
  │
  └─ 7. Ship ───────────── agent commits, drafts the PR; CI must be green
      ▶ HUMAN GATE: approve push, PR, merge
```

If a cap is hit, the agent stops and writes down what it tried and where it is
stuck (systematic debugging), instead of guessing further.

### Test strategy per layer

| Layer | Tool | What it proves | Extra quality check |
|---|---|---|---|
| Domain logic (scoring, progress) | Jest + **fast-check** property tests | Scoring rules hold for all inputs, e.g. "all correct ⇒ full points", "any wrong pick in multi-choice ⇒ 0" | **Stryker** mutation testing: tests must kill the mutants |
| Database, RLS, `start_attempt`/`submit_answer`, scoring in SQL | pgTAP | Every policy has a positive **and** a negative test per role (anon, learner, admin) | Reviewer checks each new table has RLS on |
| Components | Jest + React Native Testing Library | Rendering, states (loading/empty/error), i18n keys | — |
| End-to-end | Playwright on the web build | The real flows in section 5, against a reset local stack with seed data | axe accessibility scan; screenshots as artifacts |
| Mobile | Expo dev build, manual smoke | Nothing broke on Android/iOS | Once per phase, not per slice |

Test data comes from `supabase/seed.sql` plus small typed factories, so every
run starts from a known state.

## 5. Phases and slices

Estimates are for one full-time developer with the agentic workflow. Treat them
as a hypothesis; measure after phase 1 and adjust.

### Phase 0: foundation and harness (~1 week)

1. Repo, Expo app (TypeScript + Router), NativeWind, i18next, ESLint/Prettier,
   Jest. Lint rule against hard-coded UI strings.
2. Supabase CLI, local stack, first migration (`profiles`) with pgTAP test.
3. CI pipeline (section 3.4).
4. Agentic harness: `CLAUDE.md`, hooks, skills, subagents, MCP config.
5. **Harness proof:** the scoring function built with the full loop (failing
   property tests → implementation → mutation score ≥ 80 %). This tests the
   workflow itself before real features depend on it.
6. **Walking skeleton:** choose the web host, deploy a minimal web build
   through CI, create the hosted Supabase project (Frankfurt) with migrations
   applied by CI. Hosting and deploy problems show up now, not at release.

Item 4 builds only the minimal harness: `CLAUDE.md`, the post-edit check and
Stop gate hooks, the protected-tests hook, the `test-writer` and `reviewer`
subagents, the `feature-slice` skill and the permission allowlist. The rest of
section 3 (`implementer`, `ui-verifier` with Playwright MCP, the `e2e-flow`,
`rls-policy` and `db-migration` skills, axe) is added in the first slice that
needs it.

### Phase 1: learner on web (~3 weeks)

1. Content schema (`categories`, `quizzes`, `questions`, `answers`) + RLS +
   seed data
2. Anonymous sign-in and attempts (`start_attempt`)
3. `submit_answer`: records the first answer per question, scores it in SQL,
   then reveals the solution and explanation of that question only
4. E2E harness: Playwright and axe on the web build, locally and in CI
5. Browser verification for the agent: `ui-verifier`, Playwright MCP,
   `e2e-flow` skill
6. Category list and quiz list screens
7. Quiz player: single and multiple choice
8. Images in questions and answers (public Storage bucket)
9. Answer feedback with explanation, result screen, E2E flow A
10. Security review of the learner surface (see "Security reviews" below)

The order follows the server-authoritative answer flow decided while planning
phase 1 (section 7): attempts exist before answers can be checked, and the
harness for browser tests comes before the first screen that needs it.

**E2E flow A:** an anonymous user opens a category, plays a quiz, sees
explanations and the score.

### Phase 2: admin editor (~3 weeks)

1. Admin role guard (routes + RLS), admin seed user
2. Category CRUD with publish toggle
3. Quiz and question editor (react-hook-form + zod, schemas shared with the
   DB types)
4. Answers with single/multiple correct, validation (at least one correct)
5. Image upload to Storage with policies
6. Reordering and learner preview
7. Security review of the admin surface (see "Security reviews" below)

**E2E flow B:** an admin logs in, creates a category and a quiz with an image,
publishes it, and a learner sees it. A learner trying admin routes or writes is
rejected (UI and API).

### Phase 3: accounts and progress (~2 weeks)

1. Registration and login with email + password and magic link (including
   verification and password reset, tested against the local Inbucket mail
   server)
2. Linking the anonymous identity to the new account, keeping attempts
3. Progress and score history screens

**E2E flow C:** a guest plays a quiz, registers, and the earlier result is
still in their history.

### MVP release (~3–5 days, legal work in parallel)

- Web deploy (static export of the Expo web build; host to be chosen)
- Hosted Supabase project in Frankfurt, migrations applied by CI, DPA signed
- Impressum, privacy policy, minimal error monitoring (e.g. Sentry)
- Pre-release security audit (see "Security reviews" below)

### Security reviews

Each slice is already checked by its pgTAP tests and the `reviewer`. On top of
that, a dedicated security review closes a phase when it adds an attack
surface, so a problem is found before the next phase builds on it, not at
launch:

- **End of phase 1, learner surface:** content RLS, `start_attempt`/`submit_answer`, solution
  leaks, unpublished content, abuse of anonymous sign-in.
- **End of phase 2, admin surface:** privilege escalation to admin, writes
  without the admin role, Storage policies.
- **Before the MVP release, everything:** account flows from phase 3, the
  hosted configuration and Supabase's security advisors, secrets in the web
  bundle, security headers of the deployed site, open dependency alerts.

Each review is an issue: `/security-review` plus a manual pass and a human
read of every policy, findings listed in the issue, each fixed test first or
given its own issue. No high or critical finding is open at release.

## 6. Guardrails and risks

| Risk | Countermeasure |
|---|---|
| Agent "fixes" tests instead of code | Human-approved tests, PreToolUse block, reviewer checks the test diff |
| Weak tests that pass anything | Property tests + mutation testing on domain logic, negative RLS tests mandatory |
| RLS mistake leaks answers or allows writes | pgTAP per role, reviewer focus, security reviews at the end of phases 1 and 2 and before launch; human reads every policy |
| Endless fix loops, wasted tokens | Iteration caps, escalation note, slices kept small |
| Flaky e2e tests eroding trust | Reset DB per run, no sleeps (Playwright auto-waits), flaky test = bug ticket |
| Context drift in long sessions | One slice per session, state in the issue and in commits, not in chat |
| Agent touches production | Hosted project credentials not available locally; deploys only via CI |

## 7. Decisions

Clarified on 2026-10-03:

| Topic | Decision |
|---|---|
| MVP cut | Learner + admin + accounts (phases 0–3), web release |
| Human gates | Two per slice: approve the failing tests, approve push/merge |
| Issue tracker | GitHub Issues in the project repo; one issue per slice, a milestone per phase |
| Login | Anonymous + email/password + magic link; OAuth after the MVP |
| Claude in CI | None; review runs locally before each PR |
| Parallelism | Sequential through phase 1, then up to 2 worktree sessions |
| Repo | Public GitHub repo `quiz-learning-platform` under the GNU AGPL v3 (decided at gate 1 of #7) |

Clarified on 2026-10-03 (second round):

| Topic | Decision |
|---|---|
| Human gates | Gate 2 is push, PR and merge; the agent commits verified work on its own branch without asking |
| Harness scope | Minimal in phase 0, grown when a slice first needs a piece (see ADR 0003 amendment) |
| Harness home | In this repo's `.claude/`; parts that prove generic move to the personal Claude Code plugin after phase 1 |
| Security reviews | One per phase that adds an attack surface (end of phases 1 and 2) plus a full audit before the release, each as its own issue |
| Docs | ADRs and plans live in this repo under `docs/` |
| Branch naming | `<issue-number>-<short-slug>`, documented in `CLAUDE.md` |
| Walking skeleton | Phase 0 ends with a CI deploy of a minimal web build against the hosted Supabase project |
| Scoring | Single choice: the correct answer ⇒ full points, else 0. Multiple choice: any wrong pick ⇒ 0, a correct subset ⇒ points × picked / total correct (decided at gate 1 of #6) |
| Mutation testing scope | Only `src/domain/`, run locally with `npm run test:mutation` (break threshold 80 %); not in CI yet |

Decided with the walking-skeleton deploy (#7):

| Topic | Decision |
|---|---|
| Web hosting | Cloudflare Pages, project `small-quiz-poc` (`https://small-quiz-poc.pages.dev`); CI deploys the static web export (`expo export`, SPA output) with wrangler on every push to `main` |
| Hosted Supabase | Project `kiywcqhicsesgknlwjyy` in Frankfurt; CI runs `supabase db push` on every push to `main`, never a local machine |
| Hosted auth settings | Pushed by CI with `supabase config push` from `supabase/config.toml`; `[remotes.production]` overrides the local development values (site URL, email confirmations, email rate). PR runs show `supabase config diff` against the hosted project |
| Hosted credentials | Only in GitHub secrets (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PUBLISHABLE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EXPO_TOKEN`); the root `.env` holds only the local stack's public values |
| Hosted dashboard settings | Created with "Automatically expose new tables" off and "Enable automatic RLS" on. Locally, a migration revokes the default privileges of `anon` and `authenticated` (and `execute` on new functions in any schema from `PUBLIC`), so a table or function without explicit grants is closed in both places; helper functions used in RLS policies need an explicit `grant execute` |
| RLS helpers | Visibility checks used by policies (e.g. `private.is_quiz_visible(uuid)`) are `security definer` functions with `search_path = ''` in schema `private`, which the API doesn't expose; `anon` and `authenticated` get `usage` on the schema and `execute` on each helper. `private` holds functions only, never tables. Solution columns are hidden by column grants, not policies |
| Stale types | CI fails when `src/types/database.ts` differs from `npm run db:types` |

Decided while planning phase 1 (2026-10-03):

| Topic | Decision |
|---|---|
| Answer checking | Server-authoritative ([ADR 0002 amendment](../adr/0002-supabase-backend.md#amendment-2026-10-03-answers-are-recorded-before-they-are-checked)): `start_attempt(quiz_id)` creates an attempt; `submit_answer(attempt_id, question_id, answer_ids[])` stores the first submission per question, scores it in SQL, then returns correctness, the correct answer ids, the explanation and the points. Replaying a quiz in a new attempt is an accepted gap |
| Scoring | One point per question, rounded to 2 decimals per question; the attempt's score is the sum of the stored points. `src/domain/scoring.ts` stays as the property-tested reference the SQL cases mirror |
| Anonymous session | Browsing works as `anon` without a session; starting a quiz signs in anonymously if there is no session yet. Locally the anonymous sign-in limit is raised for E2E runs; hosted keeps 30 per hour per IP |
| Images | A public-read Storage bucket `quiz-images`; uploads come with phase 2. Every image has a required alt text. `supabase/config.toml` declares it for the local stack, which uploads the seed images; a migration creates it on the hosted project, since `config push` doesn't create buckets. No storage policies yet, so nobody can write or list it |
| Admins in phase 1 | See and do what learners do; the admin read and write paths come with phase 2 |
| Hosted content | `seed.sql` runs only locally, so the hosted site shows the empty state until admins create content in phase 2 |
| Android smoke build | The preview APK is built by hand with a `workflow_dispatch` job that runs `eas build --local` on the GitHub runner (#67): it uses no EAS free-tier build credits, and the hosted publishable key stays a GitHub secret of the `production` environment instead of moving to expo.dev or the dev machine. Package id `io.github.marvinmai.quiz`. The per-phase checklist targets the preview APK; see [mobile smoke test](../mobile-smoke-test.md) |
| Issues | Created for phase 1 only; phases 2 and 3 get theirs after the phase 1 review in ADR 0003 |

The agentic workflow itself is recorded in
[ADR 0003](../adr/0003-agentic-test-first-workflow.md).
