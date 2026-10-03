# ADR 0002 — Supabase (Postgres) as the backend

- **Status:** Accepted (2026-10-02, planning). It replaces a short-lived choice of Appwrite in the same session.
- **Context:** quiz learning platform: data storage, authentication, image storage and admin permissions
- **Deciders:** me, with Claude as the planning assistant
- Overview: [overview](../plan/overview.md)

## Context and problem

The apps need a server side that:

- stores categories, quizzes, questions, answers, users and quiz attempts
- handles login, including anonymous play and later converting a guest to an account
- stores quiz images
- enforces that only admins may create or edit content
- keeps the correct answers hidden from learners until they answer

The platform is free and non-commercial, so running costs and vendor lock-in
matter. Users are mostly in the EU, so GDPR applies.

## Decision drivers

- **SQL.** It is the kind of database I know. The data is also naturally
  relational: categories → quizzes → questions → answers → attempts.
- Ready-made authentication, file storage and permissions, to save weeks of work
- Real-time updates available for future features (live quizzes,
  leaderboards), so I learn one platform that already covers them
- Open source and self-hostable, to avoid lock-in
- EU data region
- Low cost

## Options considered

- **Supabase:**
  - Postgres plus auth (email, OAuth, anonymous), Storage, row-level
    security, Edge Functions and Realtime
  - Open source, with an EU region
- **Appwrite:**
  - An open-source alternative with similar features, including realtime,
    and easier to self-host
  - Its database is less relational and not plain SQL. I picked it first,
    then reverted because I'm used to SQL.
- **Firebase (Google):**
  - Very fast to start, with realtime
  - Proprietary, with a non-relational database that fits the data poorly,
    and the strongest lock-in
- **PocketBase:**
  - A single small program on SQLite, simple and cheap to host
  - Not at version 1.0 yet, and suited to small or medium scale
- **Own backend (Node/TS + Postgres):**
  - Full control, with only normal code
  - Login, password reset, email verification, uploads and permissions all
    have to be built, roughly several weeks of extra work
- **Headless CMS (Directus, Payload, Strapi):**
  - Ready-made admin screens
  - A second tool to run, a less flexible quiz editor, and end-user accounts
    still need solving. Not needed, because the admin is just a role in the
    app.

## Decision

**Supabase**, hosted in the EU (Frankfurt), with the schema kept as SQL
migrations in git. The rules are:

- **Permissions** are row-level security policies.
- **Admin rights** are `profiles.role = 'admin'`.
- **Answer checking** is a `security definer` SQL function, `check_answer`.
  Learners never read `is_correct` or `explanation` directly.

### Amendment (2026-10-03): answers are recorded before they are checked

A stateless `check_answer(question_id, answer_ids[])` can be called before
answering, so it would reveal the solution in advance, and a score computed
by the client can be faked. Planning phase 1, I chose a server-authoritative
flow instead, like an endpoint of a classic backend:

- `start_attempt(quiz_id)` creates an attempt for the signed-in (possibly
  anonymous) user.
- `submit_answer(attempt_id, question_id, answer_ids[])` stores the first
  submission per question, scores it in SQL, and only then returns
  correctness, the correct answer ids, the explanation and the points. A
  repeated call returns the stored result.
- Learners have no write access to attempts or scores. The attempt's score is
  the sum of its stored points.

Accepted gap: a learner can play a quiz once to learn the answers and then
start a new attempt. A later rule (e.g. only the first attempt counts for a
leaderboard) can close it. The scoring rules now live in SQL. The TypeScript
version in `src/domain/scoring.ts` stays as the property-tested reference
that the SQL cases mirror.

## Consequences

**Positive:**

- Plain SQL and Postgres, which I know, with generated TypeScript types for the app
- Login, image storage and permissions come out of the box
- Realtime (database changes, broadcast, presence) is available when needed
- A full local stack through `supabase start`. Permissions can be tested with
  pgTAP (`supabase test db`).

**Negative, accepted:**

- **Permissions live inside the database.** Row-level security policies are
  unfamiliar at first and harder to test than application code, so they get
  dedicated pgTAP tests.
- **Free projects pause after about a week without activity.** Production
  needs the paid tier, about $25 a month. The free and paid limits are from
  memory and should be verified.
- **Some logic may need Edge Functions.** Logic that SQL can't express would
  run on Deno, a second runtime to learn.
- **Self-hosting is possible but not trivial.** It's several services, not
  one program.
- **GDPR:** a data processing agreement with Supabase is needed before launch.
