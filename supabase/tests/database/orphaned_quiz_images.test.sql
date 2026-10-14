-- public.orphaned_quiz_images(older_than) (#125): the names of the objects in
-- the quiz-images bucket that no questions.image_path and no
-- answers.image_path names and that were created before `older_than`. The
-- scheduled cleanup (scripts/clean-up-images.mjs, run by a GitHub Actions
-- schedule) passes now minus its grace period, so an upload whose save is
-- still running survives, and removes the listed objects through the
-- Storage API: Storage refuses a direct DELETE on storage.objects
-- (storage.protect_delete), and even where one is allowed it would remove only
-- the row, not the public file.
--
-- The function only lists. It returns object names and nothing else, so no
-- solution column can leak through it, and only the service role may call it:
-- no grant to anon or authenticated, so every API caller gets SQLSTATE 42501
-- (without a user, as anon, as an anonymous user, as a learner and as an
-- admin). function_privileges.test.sql keeps it off the anon and
-- authenticated allow-lists.
--
-- Fixtures are storage.objects rows inserted as the owner with a chosen
-- created_at, at a fixed cutoff far in the future, so the seed's objects
-- (created by `db reset`) count as old and must still be kept because rows
-- name them.
begin;
select plan(22);

-- Fixtures -----------------------------------------------------------------

create function pg_temp.cutoff()
returns timestamptz
language sql
as $$ select '2100-01-01 00:00:00+00'::timestamptz $$;

insert into storage.buckets (id, name, public)
values ('orphan-test-other', 'orphan-test-other', false);

insert into storage.objects (bucket_id, name, created_at) values
  -- unreferenced, a second older than the cutoff
  ('quiz-images', 'c1250000-0000-4000-8000-000000000001.png', pg_temp.cutoff() - interval '1 second'),
  -- unreferenced, a second younger than the cutoff (an upload in progress)
  ('quiz-images', 'c1250000-0000-4000-8000-000000000002.png', pg_temp.cutoff() + interval '1 second'),
  -- unreferenced, long before the cutoff
  ('quiz-images', 'c1250000-0000-4000-8000-000000000003.webp', pg_temp.cutoff() - interval '30 days'),
  -- named by a question of an unpublished quiz
  ('quiz-images', 'c1250000-0000-4000-8000-000000000004.png', pg_temp.cutoff() - interval '30 days'),
  -- named by an answer of an unpublished quiz
  ('quiz-images', 'c1250000-0000-4000-8000-000000000005.jpg', pg_temp.cutoff() - interval '30 days'),
  -- unreferenced and old, but in another bucket
  ('orphan-test-other', 'c1250000-0000-4000-8000-000000000006.png', pg_temp.cutoff() - interval '30 days');

-- Flüsse in Deutschland is the seed's unpublished draft.
update public.questions
set image_path = 'c1250000-0000-4000-8000-000000000004.png', image_alt = 'Ein Fluss'
where id = '30000000-0000-4000-8000-000000000006';

update public.answers
set image_path = 'c1250000-0000-4000-8000-000000000005.jpg', image_alt = 'Der Rhein'
where id = '40000000-0000-4000-8000-000000000018';

insert into auth.users (id, is_anonymous) values
  ('a1250000-0000-4000-8000-000000000001', true);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- The shape -----------------------------------------------------------------

select has_function(
  'public', 'orphaned_quiz_images', array['timestamp with time zone'],
  'public.orphaned_quiz_images(timestamptz) exists'
);

select function_returns(
  'public', 'orphaned_quiz_images', array['timestamp with time zone'], 'setof text',
  'it returns object names only (setof text), so no solution column can leak through it'
);

-- What the service role gets ------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);

create temporary table listed as
  select * from public.orphaned_quiz_images(pg_temp.cutoff()) as name;

create temporary table listed_at_infinity as
  select * from public.orphaned_quiz_images('infinity'::timestamptz) as name;

create temporary table listed_long_ago as
  select * from public.orphaned_quiz_images('2000-01-01 00:00:00+00'::timestamptz) as name;

reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  exists (select 1 from pg_temp.listed where name = 'c1250000-0000-4000-8000-000000000001.png'),
  'an unreferenced object a second older than the cutoff is listed'
);

select ok(
  not exists (select 1 from pg_temp.listed where name = 'c1250000-0000-4000-8000-000000000002.png'),
  'an unreferenced object a second younger than the cutoff is kept'
);

select ok(
  exists (select 1 from pg_temp.listed where name = 'c1250000-0000-4000-8000-000000000003.webp'),
  'an unreferenced object long before the cutoff is listed'
);

select ok(
  not exists (select 1 from pg_temp.listed where name = 'c1250000-0000-4000-8000-000000000004.png'),
  'an old object a question of an unpublished quiz names is kept'
);

select ok(
  not exists (select 1 from pg_temp.listed where name = 'c1250000-0000-4000-8000-000000000005.jpg'),
  'an old object an answer of an unpublished quiz names is kept'
);

select ok(
  not exists (select 1 from pg_temp.listed where name = '063fa988-b996-4b4e-908f-1118f445ae46.png'),
  'the seed image a question of a published quiz names is kept'
);

select ok(
  not exists (select 1 from pg_temp.listed where name = '39c5ec8d-57d6-4ab5-8ff7-f32a80a0a25d.png'),
  'the seed image an answer of a published quiz names is kept'
);

select ok(
  not exists (select 1 from pg_temp.listed where name = 'c1250000-0000-4000-8000-000000000006.png'),
  'an old unreferenced object of another bucket is never listed'
);

select set_eq(
  $$ select name from pg_temp.listed where name like 'c1250000-%' $$,
  $$ values ('c1250000-0000-4000-8000-000000000001.png'),
            ('c1250000-0000-4000-8000-000000000003.webp') $$,
  'of the fixtures, exactly the two old unreferenced quiz-images objects are listed'
);

-- After `db reset`, a cleanup at any time keeps every seeded image, so
-- seed_images.test.sql stays green after it.
select ok(
  (select count(*) from public.questions where image_path is not null)
  + (select count(*) from public.answers where image_path is not null) > 0
  and not exists (
    select 1 from pg_temp.listed_at_infinity l
    where l.name in (
      select image_path from public.questions where image_path is not null
      union
      select image_path from public.answers where image_path is not null
    )
  ),
  'no object a question or answer names is listed, whatever the cutoff'
);

select is_empty(
  $$ select name from pg_temp.listed_long_ago $$,
  'nothing is listed when no object is older than the cutoff'
);

select ok(
  exists (
    select 1 from storage.objects
    where bucket_id = 'quiz-images' and name = 'c1250000-0000-4000-8000-000000000001.png'
  ),
  'listing deletes nothing: the listed object''s row is still there'
);

-- Who may call it -------------------------------------------------------------

select ok(
  has_function_privilege('service_role', 'public.orphaned_quiz_images(timestamptz)', 'execute'),
  'service_role may execute it'
);

select ok(
  not has_function_privilege('anon', 'public.orphaned_quiz_images(timestamptz)', 'execute'),
  'anon has no execute privilege on it'
);

select ok(
  not has_function_privilege('authenticated', 'public.orphaned_quiz_images(timestamptz)', 'execute'),
  'authenticated has no execute privilege on it'
);

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select * from public.orphaned_quiz_images(now()) $$,
  '42501', 'permission denied for function orphaned_quiz_images',
  'anon gets permission denied'
);

reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select throws_ok(
  $$ select * from public.orphaned_quiz_images(now()) $$,
  '42501', 'permission denied for function orphaned_quiz_images',
  'authenticated without a user gets permission denied'
);

reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a1250000-0000-4000-8000-000000000001", "role": "authenticated", "is_anonymous": true}',
  true);

select throws_ok(
  $$ select * from public.orphaned_quiz_images(now()) $$,
  '42501', 'permission denied for function orphaned_quiz_images',
  'an anonymous user gets permission denied'
);

reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select throws_ok(
  $$ select * from public.orphaned_quiz_images(now()) $$,
  '42501', 'permission denied for function orphaned_quiz_images',
  'a learner gets permission denied'
);

reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select throws_ok(
  $$ select * from public.orphaned_quiz_images(now()) $$,
  '42501', 'permission denied for function orphaned_quiz_images',
  'an admin gets permission denied'
);

reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
