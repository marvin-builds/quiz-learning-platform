# Quiz learning platform

Free, non-commercial learning platform: multiple-choice quizzes in categories,
played anonymously or with an account, managed by admins in the same app.
Expo (React Native, TypeScript, Expo Router) for web, Android and iOS;
Supabase (Postgres, RLS, Auth, Storage) as the backend. One developer, with
Claude Code as the main implementer.

This file is a seed. Issues #2–#4 add commands and layout as they create
them; #5 completes it with the hooks and agents. Keep it under ~150 lines and
move procedures into `.claude/skills/`.

## Read first

- [Overview](docs/plan/overview.md): scope, architecture, data model, access rules
- [MVP implementation plan](docs/plan/mvp-implementation-plan.md): phases, the feature loop, test strategy, decisions
- [ADR 0003](docs/adr/0003-agentic-test-first-workflow.md): how work is done here, including its amendment
- Work items: GitHub issues, one per vertical slice, a milestone per phase (`gh issue view <n>`)

## Commands

- `npm ci`: install exactly what the lockfile pins
- `npx expo start --web`: dev server on the web (`npm start` for all platforms)
- `npm test`: Jest; one file with `npx jest <path>`
- `npm run lint`: ESLint with Prettier and the no-hard-coded-strings rule
- `npm run typecheck`: `tsc --noEmit` in strict mode
- `npx expo install <package>`: add dependencies with versions matching the Expo SDK
- `npx expo-doctor`: check dependency and config problems

## Layout

- `src/app/`: Expo Router routes only; every file there becomes a screen,
  so tests and helpers live elsewhere
- `src/i18n/`: i18next setup and `locales/{de,en}.json`; `en` must have
  every key `de` has, which the typecheck enforces
- `tests/`: tests of the tooling itself (e.g. the lint rule)

Expo changes with every SDK release: check the docs for the SDK version in
`package.json` (`https://docs.expo.dev/versions/v<major>.0.0/`) rather than
memory before using an Expo or React Native API.

## Workflow

- **One issue = one slice = one branch** named `<issue-number>-<short-slug>`
  (e.g. `2-expo-app-skeleton`), branched from an up-to-date `main`.
- **Tests first.** Turn the issue's acceptance criteria into failing tests and
  watch them fail for the right reason before writing production code.
- **Gate 1:** stop after the failing tests and let me approve them. From then
  on they are the spec.
- **Never edit an approved test to make it pass.** If a test looks wrong, stop
  and say why.
- **Gate 2:** commit verified work on the slice branch without asking; push,
  PR and merge only after my go-ahead.
- **Caps:** about 10 attempts to get to green, at most 3 review-and-fix rounds.
  When a cap is hit, stop and write down what was tried and where it is stuck.
- **Definition of done:** the acceptance criteria are covered by tests; lint,
  typecheck and all tests are green (later: in CI too); no hard-coded UI
  strings; docs updated when a decision changed.

## Rules that must never break

- **Every table has RLS enabled.** Every policy gets a positive and a negative
  pgTAP test per role (`anon`, learner, admin).
- **Learners never see the solutions.** `answers.is_correct` and
  `questions.explanation` are only reachable through the
  `check_answer(question_id, answer_ids[])` function, never through a select.
- **No hosted Supabase access from the dev machine.** Local stack only;
  migrations reach the hosted project through CI.
- **No hard-coded UI strings.** All user-facing text goes through i18next
  (German default, English).
- Schema changes are SQL migrations in `supabase/migrations/`; never change
  the database by hand.

## Changing these rules

Workflow changes are deliberate: update ADR 0003 (or add a new ADR) in the
same PR as the change to this file.
