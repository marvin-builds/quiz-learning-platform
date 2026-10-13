-- public.health_check(): the one value the deployed page reads to prove it
-- reaches the database. Callable by every API role; returns a fixed value and
-- touches no data.
begin;
select plan(7);

-- Fixtures: a learner, an admin and an anonymous user.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Structure ---------------------------------------------------------------

select has_function('public', 'health_check', '{}'::name[], 'health_check() exists');

select function_returns('public', 'health_check', '{}'::name[], 'text',
  'health_check() returns text');

select isnt_definer('public', 'health_check', '{}'::name[],
  'health_check() runs with the caller''s rights, not as security definer');

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select public.health_check() $$,
  $$ values ('ok'::text) $$,
  'anon can call health_check() and gets ok'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select public.health_check() $$,
  $$ values ('ok'::text) $$,
  'an anonymous user can call health_check() and gets ok'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select public.health_check() $$,
  $$ values ('ok'::text) $$,
  'a learner can call health_check() and gets ok'
);

reset role;

-- admin (carol) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select public.health_check() $$,
  $$ values ('ok'::text) $$,
  'an admin can call health_check() and gets ok'
);

reset role;

select * from finish();
rollback;
