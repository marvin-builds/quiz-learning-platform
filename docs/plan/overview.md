# Quiz Learning Platform: project plan

Planning status: 2026-10-02. This is an early plan, and planning continues in
a new session. Decisions are recorded in [ADR 0001](../adr/0001-expo-react-native-client.md)
(client stack), [ADR 0002](../adr/0002-supabase-backend.md) (backend) and
[ADR 0003](../adr/0003-agentic-test-first-workflow.md) (agentic development workflow).

## Context

A free, non-commercial, public learning platform. The first feature is
multiple-choice quizzes grouped into categories. Admins log in and manage
categories and quizzes with an easy editor. The same features are needed on
web, Android and iOS. Windows, macOS and Linux are optional and only worth it
if they come cheaply. There is one developer, working full time.

How we got here: we ruled out building separate apps per platform. Everything
uses one shared client codebase and one backend, released in stages.

### Decisions made

| Topic | Decision | Reason |
|---|---|---|
| Client | **Expo (React Native) + TypeScript + Expo Router** | One codebase for web, Android and iOS. Web output is real HTML, so SEO (a nice to have) comes almost free |
| Backend | **Supabase** (hosted, EU/Frankfurt region, self-hostable later) | The data lives in Postgres, a normal SQL database I already know. Supabase adds login (including anonymous), file storage for images, row-level security and **Realtime** for future features such as live quizzes or leaderboards |
| Admin | Screens **inside the same app**, shown only to users with `role = 'admin'` in `profiles` and enforced by row-level security, used in the web browser | One codebase and one login system; admin is just a role |
| Desktop | Later, by wrapping the web build with **Tauri** | Small effort, not part of the MVP |
| Platform order | Web and admin first, then the Android and iOS store release from the same code | Fastest feedback; app store review comes once the content works |

### MVP scope (confirmed)

- Categories → quizzes → questions with single **or multiple** correct answers
- Images in questions and answers
- An explanation shown after answering
- **Anonymous play.** An account is optional and adds progress and score history
- The UI is ready for translation from day one (i18n). Multilingual content,
  offline use and real-time features come later.

## Architecture

```
Expo app (one codebase)
 ├─ /(learn)   categories, quiz player, results, profile/progress
 ├─ /(admin)   category & quiz editor (guarded by the admin role)
 └─ data layer  (@supabase/supabase-js; generated TypeScript types from the DB schema)
        │
Supabase: Postgres + row-level security · Auth · Storage (images) · Realtime (later)
```

**Data model (Postgres tables, created through SQL migrations in git):**

- `profiles`: id (→ auth.users), display_name, role (`learner` | `admin`)
- `categories`: name, description, sort_order, published
- `quizzes`: category_id, title, description, sort_order, published
- `questions`: quiz_id, text, image_path, multiple_correct, explanation, sort_order
- `answers`: question_id, text, image_path, is_correct, sort_order
- `attempts` / `attempt_answers`: user_id, quiz_id, selected answers, score, timestamps

**Access rules (row-level security):**

- Learners can read published content, except `answers.is_correct` and
  `questions.explanation`. Those are only exposed through the
  `check_answer(question_id, answer_ids[])` SQL function (`security definer`),
  which returns whether the answer is correct, plus the explanation. Learners
  can't see the solutions in advance, and no extra server code is needed.
- Admins have full write access.
- Users can only read and write their own attempts.

**Anonymous play:** uses Supabase anonymous sign-in. When the learner
registers, the identity is linked to a real account and their progress is kept.

**Supporting libraries:**

- NativeWind (styling)
- TanStack Query (server data)
- react-hook-form + zod (admin forms, shared validation)
- i18next (UI texts)

**Local development:** `supabase start` runs a full local stack in Docker.
Migrations live in `supabase/migrations`, and generated types in
`src/types/database.ts`.

**Tests:** Jest + React Native Testing Library for units and components,
pgTAP (`supabase test db`) for row-level security and SQL functions, and
Playwright for web end-to-end flows. Tests come first.

## Phases (rough estimates for one full-time developer)

0. **Foundation (about 1 week):**
   - Git repo and Expo app skeleton
   - TypeScript, ESLint and Jest setup
   - Supabase CLI and local stack, with the first migration
   - CI on GitHub Actions (lint, typecheck, tests, DB tests)
1. **Learner MVP on web (about 3 weeks):**
   - Category and quiz browsing
   - Quiz player with single and multiple choice
   - `check_answer`, explanation and result screen
   - Anonymous sign-in
2. **Admin editor (about 3 weeks):**
   - Admin-guarded routes
   - Create, edit and delete categories, quizzes, questions and answers
   - Image upload to Storage, reordering, publish toggle and preview
3. **Accounts and progress (about 2 weeks):**
   - Email + password and magic-link login (OAuth after the MVP)
   - Linking an anonymous session to an account
   - Progress and score history
4. **Mobile release (about 2-3 weeks):**
   - EAS builds and testing on devices
   - Store listings
   - Sign in with Apple (required if Google login is offered)
   - Privacy labels
   - Static web export of public quiz pages for SEO
   - Move the hosted project to the paid tier, since free projects pause when
     inactive
5. **Later:** Realtime features (e.g. live quiz sessions, leaderboards), Tauri
   desktop builds, multilingual content, offline mode

**Legal (in parallel, before the public launch):**

- Impressum
- Privacy policy (GDPR; accounts store personal data)
- Supabase data processing agreement
- Store costs: Apple $99 per year, Google $25 once

## Open decisions

Repo, tracker, MVP cut, login methods, UI languages (German + English) and the
agentic workflow were decided on 2026-10-03; see
[MVP implementation plan § 7](mvp-implementation-plan.md#7-decisions).
Still open:

- Open-source license (e.g. MIT or AGPL), before going public

## Next step

Phase 0 as described in the
[MVP implementation plan § 5](mvp-implementation-plan.md#phase-0-foundation-and-harness-1-week).

## Verification

- `npm run lint && npx tsc --noEmit && npm test && supabase test db` pass
  locally and in CI
- Playwright end-to-end flow on web: anonymous user opens a category, takes a
  quiz, sees explanations and the score
- Admin end-to-end flow: an admin logs in, creates a category and a quiz with
  an image, publishes it, and the quiz appears for learners
- pgTAP tests prove that a learner cannot write content, cannot read
  `is_correct` or `explanation` directly, and cannot see other users' attempts
- Manual check on Android and iOS through an Expo development build before the
  store release
