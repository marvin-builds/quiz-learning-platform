-- Anonymous sign-in creates an auth user with is_anonymous = true. Such a user
-- gets a profile from the same signup trigger as everyone else, with role
-- learner, and reads it like any other learner. Their JWT carries
-- "is_anonymous": true next to role authenticated.
begin;
select plan(4);

-- Fixtures: two anonymous users, as Supabase creates them (no email).
insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true),
  ('66666666-6666-6666-6666-666666666666', true);

-- As the owner --------------------------------------------------------------

select results_eq(
  $$ select display_name, role::text from public.profiles
     where id = '44444444-4444-4444-4444-444444444444' $$,
  $$ values (null::text, 'learner'::text) $$,
  'an anonymous user gets a profile with role learner and no display name'
);

select results_eq(
  $$ select count(*)::int from public.profiles
     where id in ('44444444-4444-4444-4444-444444444444',
                  '66666666-6666-6666-6666-666666666666') $$,
  $$ values (2) $$,
  'every anonymous user gets a profile of their own'
);

-- anonymous user ------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id, role::text from public.profiles $$,
  $$ values ('44444444-4444-4444-4444-444444444444'::uuid, 'learner'::text) $$,
  'an anonymous user reads their own profile with role learner'
);

select is_empty(
  $$ select 1 from public.profiles where id = '66666666-6666-6666-6666-666666666666' $$,
  'an anonymous user cannot read another anonymous user''s profile'
);

reset role;

select * from finish();
rollback;
