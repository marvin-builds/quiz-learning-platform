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
select plan(29);

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

-- Dedicated e2e admins (#122) -------------------------------------------
-- Every TOTP verify makes GoTrue end all of that user's sessions below aal2,
-- so the e2e tests that sign in with password and code (or sign out)
-- themselves can't share the seed admin with the tests running at the same
-- time: each spec file that does gets its own admin per Playwright project
-- (TEST_ADMINS and API_ADMIN in e2e/admin-auth.ts). Each is set up like the
-- seed admin: a confirmed email user GoTrue can sign in with the password
-- `<local part>-password`, role admin, and exactly one verified TOTP factor
-- with its own local-only 32-character base32 secret (the Jest test
-- tests/repo/admin-mfa-config.test.ts checks the secrets match the helper's).

create temporary table e2e_admins (email text primary key) on commit drop;
insert into e2e_admins (email) values
  ('admin-mfa-phone@example.com'),
  ('admin-mfa-desktop@example.com'),
  ('admin-sign-in-phone@example.com'),
  ('admin-sign-in-desktop@example.com'),
  ('admin-nav-phone@example.com'),
  ('admin-nav-desktop@example.com'),
  ('admin-api-aal1@example.com');

select results_eq(
  $$ select e.email, count(u.id)::int
     from e2e_admins e
     left join auth.users u on u.email = e.email
     group by e.email
     order by e.email $$,
  $$ select email, 1 from e2e_admins order by email $$,
  'the seed has each dedicated e2e admin exactly once'
);

select is_empty(
  $$ select e.email
     from e2e_admins e
     left join auth.users u on u.email = e.email
     where u.id is null
        or u.encrypted_password is distinct from extensions.crypt(
             split_part(e.email, '@', 1) || '-password', u.encrypted_password) $$,
  'each dedicated e2e admin''s password is its local part followed by -password (bcrypt)'
);

select is_empty(
  $$ select e.email
     from e2e_admins e
     left join auth.users u on u.email = e.email
     where not coalesce(
       u.email_confirmed_at is not null
       and not u.is_anonymous
       and u.aud = 'authenticated'
       and u.role = 'authenticated',
       false) $$,
  'each dedicated e2e admin is a confirmed, non-anonymous authenticated user'
);

select is_empty(
  $$ select e.email
     from e2e_admins e
     left join auth.users u on u.email = e.email
     where not coalesce(
       u.confirmation_token is not null
       and u.recovery_token is not null
       and u.email_change is not null
       and u.email_change_token_new is not null,
       false) $$,
  'each dedicated e2e admin''s token columns are empty strings, not null'
);

select is_empty(
  $$ select e.email
     from e2e_admins e
     where not exists (
       select 1
       from auth.identities i
       join auth.users u on u.id = i.user_id
       where u.email = e.email and i.provider = 'email'
     ) $$,
  'each dedicated e2e admin has an email identity'
);

select results_eq(
  $$ select e.email, p.role::text
     from e2e_admins e
     left join auth.users u on u.email = e.email
     left join public.profiles p on p.id = u.id
     order by e.email $$,
  $$ select email, 'admin'::text from e2e_admins order by email $$,
  'each dedicated e2e admin''s profile has role admin'
);

select results_eq(
  $$ select e.email, f.factor_type::text, f.status::text, f.secret ~ '^[A-Z2-7]{32}$'
     from e2e_admins e
     left join auth.users u on u.email = e.email
     left join auth.mfa_factors f on f.user_id = u.id
     order by e.email, f.id $$,
  $$ select email, 'totp'::text, 'verified'::text, true from e2e_admins order by email $$,
  'each dedicated e2e admin has exactly one factor, a verified TOTP factor with a 32-character base32 secret'
);

select results_eq(
  $$ select count(distinct f.secret)::int
     from auth.mfa_factors f
     join auth.users u on u.id = f.user_id
     where u.email in (select email from e2e_admins) or u.email = 'admin@example.com' $$,
  $$ select count(*)::int + 1 from e2e_admins $$,
  'the dedicated e2e admins and the seed admin each have their own TOTP secret'
);

select * from finish();
rollback;
