-- Access rules for public.profiles, per role: anon, anonymous user, learner,
-- admin. Nobody makes themselves admin: not by updating their role, not by
-- inserting a profile, not with sign-up metadata.
begin;
select plan(29);

-- Fixtures: three auth users. Their profiles must come from the signup trigger.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', '{"display_name": "Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test', '{"display_name": "Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test', '{"display_name": "Carol"}');

-- Promotion to admin happens outside the app (SQL / seed), as the owner.
update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Structure ---------------------------------------------------------------

select has_table('public', 'profiles', 'profiles table exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'profiles has row-level security enabled'
);

select results_eq(
  $$ select display_name, role::text from public.profiles
     where id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values ('Alice'::text, 'learner'::text) $$,
  'signing up creates a profile with the display name and role learner'
);

select throws_ok(
  $$ update public.profiles set role = 'superuser'
     where id = '11111111-1111-1111-1111-111111111111' $$,
  null, null,
  'role only accepts learner or admin'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select * from public.profiles $$,
  '42501', null,
  'anon cannot read profiles'
);

select throws_ok(
  $$ update public.profiles set display_name = 'Hacked' $$,
  '42501', null,
  'anon cannot update profiles'
);

select throws_ok(
  $$ insert into public.profiles (id, display_name)
     values ('44444444-4444-4444-4444-444444444444', 'Mallory') $$,
  '42501', null,
  'anon cannot insert profiles'
);

reset role;

-- anonymous user ----------------------------------------------------------

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select throws_ok(
  $$ update public.profiles set role = 'admin'
     where id = '44444444-4444-4444-4444-444444444444' $$,
  '42501', null,
  'an anonymous user cannot change their own role'
);

select throws_ok(
  $$ insert into public.profiles (id, display_name, role)
     values ('77777777-7777-7777-7777-777777777777', 'Mallory', 'admin') $$,
  '42501', null,
  'an anonymous user cannot insert an admin profile'
);

reset role;

select results_eq(
  $$ select role::text from public.profiles
     where id = '44444444-4444-4444-4444-444444444444' $$,
  $$ values ('learner'::text) $$,
  'the anonymous user is still a learner'
);

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id from public.profiles $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid) $$,
  'learner sees only their own profile'
);

select is_empty(
  $$ select 1 from public.profiles where id = '22222222-2222-2222-2222-222222222222' $$,
  'learner cannot read another user''s profile'
);

select results_eq(
  $$ update public.profiles set display_name = 'Alice Liddell'
     where id = '11111111-1111-1111-1111-111111111111' returning display_name $$,
  $$ values ('Alice Liddell'::text) $$,
  'learner can update their own display name'
);

select throws_ok(
  $$ update public.profiles set role = 'admin'
     where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', null,
  'learner cannot change their own role'
);

select is_empty(
  $$ update public.profiles set display_name = 'Hacked'
     where id = '22222222-2222-2222-2222-222222222222' returning 1 $$,
  'learner cannot update another user''s profile'
);

select throws_ok(
  $$ insert into public.profiles (id, display_name)
     values ('44444444-4444-4444-4444-444444444444', 'Mallory') $$,
  '42501', null,
  'learner cannot insert a profile'
);

select throws_ok(
  $$ insert into public.profiles (id, display_name, role)
     values ('77777777-7777-7777-7777-777777777777', 'Mallory', 'admin') $$,
  '42501', null,
  'learner cannot insert an admin profile'
);

select throws_ok(
  $$ delete from public.profiles where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', null,
  'learner cannot delete their own profile'
);

select throws_ok(
  $$ delete from public.profiles where id = '22222222-2222-2222-2222-222222222222' $$,
  '42501', null,
  'learner cannot delete another user''s profile'
);

reset role;

-- admin (carol) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, role::text from public.profiles $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid, 'admin'::text) $$,
  'admin sees their own profile with role admin, and no others'
);

select results_eq(
  $$ update public.profiles set display_name = 'Carol Admin'
     where id = '33333333-3333-3333-3333-333333333333' returning display_name $$,
  $$ values ('Carol Admin'::text) $$,
  'admin can update their own display name'
);

select is_empty(
  $$ update public.profiles set display_name = 'Hacked'
     where id = '11111111-1111-1111-1111-111111111111' returning 1 $$,
  'admin cannot update another user''s profile'
);

select throws_ok(
  $$ update public.profiles set role = 'admin'
     where id = '22222222-2222-2222-2222-222222222222' $$,
  '42501', null,
  'admin cannot change roles through the API'
);

select throws_ok(
  $$ delete from public.profiles where id = '22222222-2222-2222-2222-222222222222' $$,
  '42501', null,
  'admin cannot delete profiles through the API'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select id::text, display_name, role::text from public.profiles
     -- The fixtures and the rejected insert's id, so seed users and leftovers
     -- of e2e runs don't count.
     where id in ('11111111-1111-1111-1111-111111111111',
                  '22222222-2222-2222-2222-222222222222',
                  '33333333-3333-3333-3333-333333333333',
                  '44444444-4444-4444-4444-444444444444',
                  '77777777-7777-7777-7777-777777777777')
     order by id $$,
  $$ values
       ('11111111-1111-1111-1111-111111111111', 'Alice Liddell', 'learner'),
       ('22222222-2222-2222-2222-222222222222', 'Bob', 'learner'),
       ('33333333-3333-3333-3333-333333333333', 'Carol Admin', 'admin'),
       ('44444444-4444-4444-4444-444444444444', null, 'learner') $$,
  'only the allowed changes reached the table'
);

-- Signup without a display name still creates a learner profile.
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'dave@example.test');

select results_eq(
  $$ select display_name, role::text from public.profiles
     where id = '55555555-5555-5555-5555-555555555555' $$,
  $$ values (null::text, 'learner'::text) $$,
  'signup without metadata creates a learner profile with no display name'
);

-- Signup metadata can't choose the role: both metadata fields are set by
-- the client at sign-up (supabase.auth.signUp options.data) or by an admin
-- API the app doesn't use, so neither may make an admin.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('66666666-6666-6666-6666-666666666666', 'eve@example.test',
   '{"display_name": "Eve", "role": "admin"}', '{}'),
  ('88888888-8888-8888-8888-888888888888', 'trent@example.test',
   '{"display_name": "Trent"}', '{"role": "admin"}');

select results_eq(
  $$ select role::text from public.profiles
     where id = '66666666-6666-6666-6666-666666666666' $$,
  $$ values ('learner'::text) $$,
  'signup with role admin in the user metadata creates a learner profile'
);

select results_eq(
  $$ select role::text from public.profiles
     where id = '88888888-8888-8888-8888-888888888888' $$,
  $$ values ('learner'::text) $$,
  'signup with role admin in the app metadata creates a learner profile'
);

delete from auth.users where id = '55555555-5555-5555-5555-555555555555';

select is_empty(
  $$ select 1 from public.profiles where id = '55555555-5555-5555-5555-555555555555' $$,
  'deleting the auth user deletes the profile'
);

select * from finish();
rollback;
