-- private.delete_stale_anonymous_users() (#75) is for the pg_cron job only,
-- which runs it as the job owner (postgres). No API role may execute it: it
-- has no grant to anon or authenticated, so every such caller gets the same
-- error, SQLSTATE 42501 permission denied, and deletes nothing. That holds
-- without a user, as anon, as an anonymous user, as a learner and as an
-- admin. The positive control at the end shows the same call, made by the
-- owner, deletes the stale user. The function's rules are in
-- delete_stale_anonymous_users.test.sql; function_privileges.test.sql keeps
-- it off the API allow-lists.
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(13);

-- Fixtures: a stale anonymous user, a learner and an admin -----------------

insert into auth.users (id, is_anonymous, created_at, last_sign_in_at) values
  ('a1000000-0000-4000-8000-000000000001', true,
   now() - private.anonymous_retention_period() - interval '30 days',
   now() - private.anonymous_retention_period() - interval '30 days'),
  -- a recent anonymous user, who calls the function below
  ('a2000000-0000-4000-8000-000000000002', true, now(), now());

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Whether the stale user is still there, readable after `reset role`.
create function pg_temp.stale_user_count()
returns integer
language sql
as $$
  select count(*)::int from auth.users where id = 'a1000000-0000-4000-8000-000000000001'
$$;

-- anon ----------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select private.delete_stale_anonymous_users() $$,
  '42501', 'permission denied for function delete_stale_anonymous_users',
  'anon gets permission denied for the cleanup'
);

reset role;

select is(pg_temp.stale_user_count(), 1, 'anon''s call deletes nothing');

-- authenticated without a user (claims without sub) -------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select throws_ok(
  $$ select private.delete_stale_anonymous_users() $$,
  '42501', 'permission denied for function delete_stale_anonymous_users',
  'authenticated without a user gets permission denied for the cleanup'
);

reset role;

select is(pg_temp.stale_user_count(), 1, 'a call without a user deletes nothing');

-- anonymous user ------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a2000000-0000-4000-8000-000000000002", "role": "authenticated", "is_anonymous": true}',
  true);

select throws_ok(
  $$ select private.delete_stale_anonymous_users() $$,
  '42501', 'permission denied for function delete_stale_anonymous_users',
  'an anonymous user gets permission denied for the cleanup'
);

reset role;

select is(pg_temp.stale_user_count(), 1, 'an anonymous user''s call deletes nothing');

-- learner -------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select throws_ok(
  $$ select private.delete_stale_anonymous_users() $$,
  '42501', 'permission denied for function delete_stale_anonymous_users',
  'a learner gets permission denied for the cleanup'
);

reset role;

select is(pg_temp.stale_user_count(), 1, 'a learner''s call deletes nothing');

-- admin ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select throws_ok(
  $$ select private.delete_stale_anonymous_users() $$,
  '42501', 'permission denied for function delete_stale_anonymous_users',
  'an admin gets permission denied for the cleanup'
);

reset role;

select is(pg_temp.stale_user_count(), 1, 'an admin''s call deletes nothing');

-- No API role holds the privilege, directly or through PUBLIC ----------------

select ok(
  not has_function_privilege('anon', 'private.delete_stale_anonymous_users()', 'execute'),
  'anon has no execute privilege on the cleanup'
);

select ok(
  not has_function_privilege('authenticated', 'private.delete_stale_anonymous_users()', 'execute'),
  'authenticated has no execute privilege on the cleanup'
);

-- Positive control: the owner, as the pg_cron job ---------------------------

select set_config('request.jwt.claims', '', true);
select null from private.delete_stale_anonymous_users();

select is(pg_temp.stale_user_count(), 0, 'the owner''s call deletes the stale user');

select * from finish();
rollback;
