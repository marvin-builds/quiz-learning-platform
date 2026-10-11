-- private.is_admin(): true only for a caller whose profiles.role is 'admin'.
-- The admin read policies build on it, so it must never trust anything the
-- client controls: not the JWT's user_metadata or app_metadata, not the
-- sign-up metadata. It runs as security definer with an empty search_path,
-- like the visibility helpers, so it can read profiles past their RLS, and
-- anon and authenticated may call it because the policies run with the
-- caller's rights.
--
-- Pinned name: private.is_admin(), no arguments, returning boolean.
begin;
select plan(19);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test', '{}'),
  -- signed up with role admin in their metadata: still a learner
  ('55555555-5555-5555-5555-555555555555', 'mallory@example.test', '{"role": "admin"}');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

-- Promotion to admin happens outside the app (SQL / seed), as the owner.
update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Structure ---------------------------------------------------------------

select has_function('private', 'is_admin', '{}'::name[], 'private.is_admin() exists');

select function_returns('private', 'is_admin', '{}'::name[], 'boolean',
  'private.is_admin() returns boolean');

select is_definer('private', 'is_admin', '{}'::name[],
  'private.is_admin() is security definer');

select ok(
  coalesce(
    (select 'search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))
     from pg_proc p
     where p.oid = to_regprocedure('private.is_admin()')),
    false
  ),
  'private.is_admin() sets an empty search_path'
);

select ok(
  coalesce(
    (select has_function_privilege('anon', p.oid, 'execute')
              and has_function_privilege('authenticated', p.oid, 'execute')
     from pg_proc p
     where p.oid = to_regprocedure('private.is_admin()')),
    false
  ),
  'anon and authenticated may execute private.is_admin()'
);

select hasnt_function('public', 'is_admin',
  'is_admin is not in schema public, so the API does not expose it as an RPC');

-- anon (no session) -------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin is false for anon'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin is false for an anonymous user'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin is false for a learner'
);

reset role;

-- learner whose JWT claims admin in its metadata --------------------------
-- user_metadata is writable by the user (auth.updateUser), so it must count
-- for nothing; app_metadata isn't, but the role lives in profiles only.

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated",
    "user_metadata": {"role": "admin"}, "app_metadata": {"role": "admin"},
    "user_role": "admin"}',
  true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin is false for a learner whose JWT metadata says admin'
);

reset role;

-- learner who signed up with role admin in the metadata -------------------

select results_eq(
  $$ select role::text from public.profiles
     where id = '55555555-5555-5555-5555-555555555555' $$,
  $$ values ('learner'::text) $$,
  'sign-up metadata with role admin still creates a learner profile'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "55555555-5555-5555-5555-555555555555", "role": "authenticated"}', true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin is false for a user who signed up with role admin in the metadata'
);

reset role;

-- a session for a user that doesn't exist ---------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "99999999-9999-9999-9999-999999999999", "role": "authenticated"}', true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin is false (not null) for a user without a profile'
);

reset role;

-- admin (carol) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (true) $$,
  'is_admin is true for an admin'
);

-- The admin still can't read other profiles: is_admin reads past RLS, the
-- caller doesn't.
select is_empty(
  $$ select 1 from public.profiles where id <> '33333333-3333-3333-3333-333333333333' $$,
  'an admin still reads only their own profile'
);

reset role;

-- The role is read on every call, not cached in the session ---------------

update public.profiles set role = 'learner' where id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin is false once the admin is demoted to learner'
);

reset role;

update public.profiles set role = 'admin' where id = '11111111-1111-1111-1111-111111111111';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (true) $$,
  'is_admin is true once the owner promotes a learner to admin'
);

reset role;

-- Nobody makes themselves admin through the API -----------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "55555555-5555-5555-5555-555555555555", "role": "authenticated"}', true);

select throws_ok(
  $$ update public.profiles set role = 'admin'
     where id = '55555555-5555-5555-5555-555555555555' $$,
  '42501', null,
  'a learner cannot set their own role to admin'
);

select results_eq(
  $$ select private.is_admin() $$,
  $$ values (false) $$,
  'is_admin stays false after the rejected role update'
);

reset role;

select * from finish();
rollback;
