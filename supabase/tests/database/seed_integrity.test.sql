-- supabase/seed.sql, as loaded by `supabase db reset`: every question can be
-- answered correctly, and the seed holds the shapes the app and its tests need
-- (visible content, an empty category and each kind of hidden content). Read
-- as the owner, so RLS doesn't filter anything. The shape checks also keep
-- the integrity checks from passing vacuously on an empty database.
--
-- Seed admin: the e2e tests and ui-verifier sign in as admin@example.com with
-- the password admin-password and a TOTP code from the seeded factor (#122). seed.sql runs only locally (`db reset`); CI's
-- `db push` never seeds the hosted project.
begin;
select plan(21);

-- Integrity ---------------------------------------------------------------

select ok(
  (select count(*) from public.questions) > 0,
  'the seed contains questions'
);

select is_empty(
  $$ select q.id
     from public.questions q
     where not exists (
       select 1 from public.answers a where a.question_id = q.id and a.is_correct
     ) $$,
  'every seeded question has at least one correct answer'
);

select is_empty(
  $$ select q.id
     from public.questions q
     where not q.multiple_correct
       and (select count(*) from public.answers a
            where a.question_id = q.id and a.is_correct) <> 1 $$,
  'every seeded single-choice question has exactly one correct answer'
);

-- Shape -------------------------------------------------------------------

select ok(
  (select count(*)
   from public.categories c
   where c.published
     and exists (select 1 from public.quizzes z
                 where z.category_id = c.id and z.published)) >= 2,
  'the seed has at least 2 published categories with published quizzes'
);

select ok(
  exists (
    select 1
    from public.categories c
    where c.published
      and not exists (select 1 from public.quizzes z where z.category_id = c.id)
  ),
  'the seed has an empty published category'
);

select ok(
  exists (
    select 1
    from public.categories c
    join public.quizzes z on z.category_id = c.id
    where not c.published and z.published
  ),
  'the seed has an unpublished category holding a published quiz'
);

select ok(
  exists (
    select 1
    from public.categories c
    join public.quizzes z on z.category_id = c.id
    where c.published and not z.published
  ),
  'the seed has an unpublished quiz in a published category'
);

select ok(
  exists (select 1 from public.questions where not multiple_correct and explanation is not null),
  'the seed has a single-choice question with an explanation'
);

select ok(
  exists (select 1 from public.questions where not multiple_correct and explanation is null),
  'the seed has a single-choice question without an explanation'
);

select ok(
  exists (select 1 from public.questions where multiple_correct and explanation is not null),
  'the seed has a multiple-choice question with an explanation'
);

select ok(
  exists (select 1 from public.questions where multiple_correct and explanation is null),
  'the seed has a multiple-choice question without an explanation'
);

select ok(
  exists (
    select 1
    from public.questions q
    where q.multiple_correct
      and (select count(*) from public.answers a
           where a.question_id = q.id and a.is_correct) = 3
  ),
  'the seed has a multiple-choice question with 3 correct answers'
);

select ok(
  exists (
    select 1
    from public.questions q
    join public.quizzes z on z.id = q.quiz_id
    join public.categories c on c.id = z.category_id
    where z.published and c.published
  ),
  'the seed has questions in a visible quiz'
);

-- Seed admin -------------------------------------------------------------

select results_eq(
  $$ select count(*)::int from auth.users where email = 'admin@example.com' $$,
  $$ values (1) $$,
  'the seed has exactly one user admin@example.com'
);

select ok(
  coalesce(
    (select encrypted_password = extensions.crypt('admin-password', encrypted_password)
     from auth.users where email = 'admin@example.com'),
    false
  ),
  'the seed admin''s password is admin-password (bcrypt, as GoTrue checks it)'
);

select ok(
  coalesce(
    (select email_confirmed_at is not null
            and not is_anonymous
            and aud = 'authenticated'
            and role = 'authenticated'
     from auth.users where email = 'admin@example.com'),
    false
  ),
  'the seed admin is a confirmed, non-anonymous authenticated user'
);

-- GoTrue reads these columns into strings and fails the sign-in with a
-- server error when one is null, which a hand-written insert leaves them.
select ok(
  coalesce(
    (select confirmation_token is not null
            and recovery_token is not null
            and email_change is not null
            and email_change_token_new is not null
     from auth.users where email = 'admin@example.com'),
    false
  ),
  'the seed admin''s token columns are empty strings, not null, so GoTrue can read the row'
);

select ok(
  exists (
    select 1
    from auth.identities i
    join auth.users u on u.id = i.user_id
    where u.email = 'admin@example.com' and i.provider = 'email'
  ),
  'the seed admin has an email identity'
);

select results_eq(
  $$ select p.role::text
     from public.profiles p
     join auth.users u on u.id = p.id
     where u.email = 'admin@example.com' $$,
  $$ values ('admin'::text) $$,
  'the seed admin''s profile has role admin'
);

-- Seed admin's second factor (#122) ---------------------------------------
-- Admin rights need an aal2 session, so the seed admin has a verified TOTP
-- factor with a fixed, local-only secret (base32, 160 bits like the secrets
-- GoTrue generates); the e2e helper computes the codes from the same secret.

select results_eq(
  $$ select f.factor_type::text, f.status::text
     from auth.mfa_factors f
     join auth.users u on u.id = f.user_id
     where u.email = 'admin@example.com' $$,
  $$ values ('totp'::text, 'verified'::text) $$,
  'the seed admin has exactly one factor, a verified TOTP factor'
);

select ok(
  coalesce(
    (select f.secret ~ '^[A-Z2-7]{32}$'
     from auth.mfa_factors f
     join auth.users u on u.id = f.user_id
     where u.email = 'admin@example.com'),
    false
  ),
  'the seed admin''s TOTP secret is a 32-character base32 string'
);

select * from finish();
rollback;
