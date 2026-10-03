-- public.health_check(): the one value the deployed page reads to prove it
-- reaches the database. Callable by every API role; returns a fixed value and
-- touches no data.
begin;
select plan(6);

-- Fixtures: a learner and an admin.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

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
