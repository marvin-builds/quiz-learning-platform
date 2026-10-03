# Quiz learning platform

Free, non-commercial learning platform: multiple-choice quizzes in categories,
played anonymously or with an account, managed by admins in the same app.
Expo (React Native, TypeScript, Expo Router) for web, Android and iOS;
Supabase (Postgres, RLS, Auth, Storage) as the backend. One developer, with
Claude Code as the main implementer.

Keep this file under ~150 lines and move procedures into `.claude/skills/`.

## Read first

- [Overview](docs/plan/overview.md): scope, architecture, data model, access rules
- [MVP implementation plan](docs/plan/mvp-implementation-plan.md): phases, the feature loop, test strategy, decisions
- [ADR 0003](docs/adr/0003-agentic-test-first-workflow.md): how work is done here, including its amendment
- Work items: GitHub issues, one per vertical slice, a milestone per phase (`gh issue view <n>`)

## Commands

- `npm ci`: install exactly what the lockfile pins
- `npx expo start --web`: dev server on the web (`npm start` for all platforms)
- `npm test`: Jest; one file with `npx jest <path>`
- `npm run test:timing`: duration budgets (`*.timing.test.ts`), run alone
  and serially because parallel load makes them flaky; `npm test` skips them,
  so run one with `npm run test:timing -- <path>`
- `npm run lint`: ESLint with Prettier and the no-hard-coded-strings rule
- `npm run typecheck`: `tsc --noEmit` in strict mode
- `npm run test:e2e`: Playwright and axe in Chromium (phone and desktop) against
  the static web export; needs the local stack running and reset first
  (`npx supabase start && npx supabase db reset`). One-time setup:
  `npx playwright install chromium`. `check` does not run it
- `npm run -s check`: lint, typecheck, tests and timing tests with quiet output (only
  problems and a summary); use it for verification runs; no e2e tests
- `npm run test:mutation`: Stryker on `src/domain/`; fails below 80 %
- `npm run -s slice [-- <n>]`: from a terminal, pick the next issue (or take
  `<n>`), create or reuse its worktree in `../quiz-learning-platform.worktrees/`,
  run `npm ci` and start `claude -n <branch> "/semi-auto-workflow <n>"` inside
  it, so the session never asks to switch worktrees and is named after the
  branch; `-- --pick` only prints the pick
- `npx expo install <package>`: add dependencies with versions matching the Expo SDK
- `npx expo-doctor`: check dependency and config problems
- `npx supabase start` / `stop`: local stack in Docker (CLI pinned in `package.json`)
- `npx supabase migration new <name>`: new migration file
- `npx supabase db reset && npx supabase test db`: rebuild the local database
  from the migrations and run the pgTAP tests; `start` and `reset` also create
  the `quiz-images` bucket and upload `supabase/seed-images/` (only with
  Storage running). Never run `supabase seed buckets --linked`: it would
  upload the seed images to the hosted project
- `npm run db:types`: regenerate `src/types/database.ts` from the local
  database; run it after every schema change

## Layout

- `src/app/`: Expo Router routes only; every file there becomes a screen,
  so tests and helpers live elsewhere
- `src/i18n/`: i18next setup and `locales/{de,en}.json`; `en` must have
  every key `de` has, which the typecheck enforces
- `tests/`: tests of the tooling itself (e.g. the lint rule)
- `supabase/migrations/`: SQL migrations; `supabase/tests/database/`: pgTAP
  tests (`*.test.sql`), one file per table or function
- `src/types/database.ts`: generated, never edit by hand
- `.github/workflows/ci.yml`: CI on PRs and pushes to `main`; runs the same
  commands as above (lint, typecheck, `jest --coverage` with an 80 % global
  threshold in `package.json`, the timing tests, `supabase start` +
  `supabase test db`, a stale-types check, `supabase db reset` +
  `npm run test:e2e`). Change it together with the local
  commands, never apart. On `main` it also migrates the hosted database,
  pushes `supabase/config.toml` (hosted overrides in `[remotes.production]`)
  and deploys the web export to Cloudflare Pages
- `.github/dependabot.yml`: daily GitHub Actions updates and npm security
  updates only; bump Expo and React Native with `npx expo install --fix`
- `.env`: the local stack's public URL and key for the app; CI sets the
  hosted values
- `.nvmrc`: the Node major version, shared by local setup and CI
- `.claude/`: the agent harness (see below); its hook scripts are tested in
  `tests/hooks/`, and `.claude/state/` holds local, ignored runtime state

Expo changes with every SDK release: check the docs for the SDK version in
`package.json` (`https://docs.expo.dev/versions/v<major>.0.0/`) rather than
memory before using an Expo or React Native API.

## Workflow

- **Session start:** list the open Dependabot PRs, the issues in progress
  (a `<n>-*` branch or worktree exists; give each its step, see
  `feature-slice` → Resume) and the next issue without one (lowest open
  milestone, then lowest number), then let me decide what to work on. Mark
  an issue "session open" when `claude agents --json` lists a running
  session whose `cwd` is inside its worktree.
- **One issue = one slice = one branch** named `<issue-number>-<short-slug>`
  (e.g. `2-expo-app-skeleton`), branched from an up-to-date `main`.
- **Tests first.** Turn the issue's acceptance criteria into failing tests and
  watch them fail for the right reason before writing production code.
- **Gate 1:** stop after the failing tests and let me approve them. From then
  on they are the spec.
- **Never edit an approved test to make it pass.** If a test looks wrong, stop
  and say why.
- **Gate 2:** commit verified work on the slice branch without asking; push,
  PR and merge only after my go-ahead. Rebase onto a fresh `origin/main`
  right before every push, and check the PR is mergeable after opening it.
- **Caps:** about 10 attempts to get to green, at most 3 review-and-fix rounds.
  When a cap is hit, stop and write down what was tried and where it is stuck.
- **Definition of done:** the acceptance criteria are covered by tests; lint,
  typecheck and all tests are green locally and in CI; no hard-coded UI
  strings; docs updated when a decision changed.

## Harness

For an issue, follow the `feature-slice` skill. When I invoke
`semi-auto-workflow`, it runs one issue through that loop without stopping at
gate 1 or before the push, and stops before the merge; start it with
`npm run -s slice` to skip the worktree-switch prompt. What runs
automatically:

- **After every edit** (`post-edit.mjs`): ESLint with `--fix` and the
  incremental typecheck for code, Prettier for other files,
  `supabase db reset` + `supabase test db` for migrations. Problems come back
  in the same turn; fix them before moving on.
- **Approved tests are locked** (`protect-tests.mjs`): a test committed in
  `HEAD` can't be edited. Only I unlock them: a message of mine starting with
  "unlock tests" (or "unlock tests: <paths>") makes `unlock-tests.mjs` create
  `.claude/state/tests-unlocked`; my next other message, or a new session,
  removes it. Never create, touch or mention that file in a command. Edit
  tests with Edit/Write only, never with shell commands.
- **Stop gate** (`stop-gate.mjs`): the turn can't end while committed tests
  related to the branch's changes, or the typecheck of non-test code, are red.
  New tests, and committed test files changed through Edit/Write while
  unlocked (recorded in `.claude/state/unlocked-edits`, exempt as a whole file
  until committed), may be red (gate 1); a test changed any other way blocks.
  Never write that file or name it in a shell command (the hook denies
  any command mentioning it). A branch that changes only Markdown, `docs/` or
  `.github/` skips the checks. After 10 blocked stops, write
  `.claude/state/escalation.md` and stop.
- **Agents:** `test-writer` writes the failing tests and can only write test
  files; `reviewer` reviews the branch diff read-only; `ui-verifier` checks
  the running web app through the Playwright MCP server (`.mcp.json`; setup
  in `feature-slice` step 5). The `e2e-flow` skill covers e2e specs.
- **Which checkout:** the hooks check the git work tree of the session's
  working directory (a worktree after `EnterWorktree`), falling back to
  `CLAUDE_PROJECT_DIR`. The hook scripts themselves load from the main
  checkout, so keep it on an up-to-date `main`. The MCP server runs where the
  session started. A tool that can't start
  (no `node_modules`) is reported as a setup problem: run `npm ci` there.

## Rules that must never break

- **Every table has RLS enabled.** Every policy gets a positive and a negative
  pgTAP test per role (`anon`, learner, admin).
- **Learners never see the solutions.** `answers.is_correct` and
  `questions.explanation` are only reachable through
  `submit_answer(attempt_id, question_id, answer_ids[])`, which records the
  answer before it reveals anything, never through a select. Scores are
  computed in the database; the client can't write them.
- **No hosted Supabase access from the dev machine.** Local stack only;
  migrations reach the hosted project through CI.
- **No hard-coded UI strings.** All user-facing text goes through i18next
  (German default, English).
- Schema changes are SQL migrations in `supabase/migrations/`; never change
  the database by hand.

## Changing these rules

Workflow changes are deliberate: update ADR 0003 (or add a new ADR) in the
same PR as the change to this file.
