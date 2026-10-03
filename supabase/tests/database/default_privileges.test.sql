-- New objects in public are closed to the API roles until a migration grants
-- access explicitly, as on the hosted project ("Automatically expose new tables"
-- off). Throwaway objects are created as the owner and vanish on rollback.
begin;
select plan(16);

create table public.default_privileges_probe (id int);
insert into public.default_privileges_probe values (1);

create sequence public.default_privileges_probe_seq;

create function public.default_privileges_probe_fn()
returns int
language sql
as $$ select 1 $$;

-- Owner (positive controls) -----------------------------------------------

select results_eq(
  $$ select id from public.default_privileges_probe $$,
  $$ values (1) $$,
  'the owner can select from a new table'
);

select lives_ok(
  $$ select nextval('public.default_privileges_probe_seq') $$,
  'the owner can use a new sequence'
);

select results_eq(
  $$ select public.default_privileges_probe_fn() $$,
  $$ values (1) $$,
  'the owner can execute a new function'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select * from public.default_privileges_probe $$,
  '42501', null,
  'anon cannot select from a table created without grants'
);

select throws_ok(
  $$ insert into public.default_privileges_probe values (2) $$,
  '42501', null,
  'anon cannot insert into a table created without grants'
);

select throws_ok(
  $$ select nextval('public.default_privileges_probe_seq') $$,
  '42501', null,
  'anon cannot use a sequence created without grants'
);

select throws_ok(
  $$ select public.default_privileges_probe_fn() $$,
  '42501', null,
  'anon cannot execute a function created without grants'
);

reset role;

-- authenticated (learner) -------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select throws_ok(
  $$ select * from public.default_privileges_probe $$,
  '42501', null,
  'authenticated cannot select from a table created without grants'
);

select throws_ok(
  $$ insert into public.default_privileges_probe values (2) $$,
  '42501', null,
  'authenticated cannot insert into a table created without grants'
);

select throws_ok(
  $$ select nextval('public.default_privileges_probe_seq') $$,
  '42501', null,
  'authenticated cannot use a sequence created without grants'
);

select throws_ok(
  $$ select public.default_privileges_probe_fn() $$,
  '42501', null,
  'authenticated cannot execute a function created without grants'
);

reset role;

-- Explicit grants still open access (positive controls) -------------------

grant select on public.default_privileges_probe to anon, authenticated;
grant usage on sequence public.default_privileges_probe_seq to anon, authenticated;
grant execute on function public.default_privileges_probe_fn() to anon, authenticated;

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select id from public.default_privileges_probe where id = 1 $$,
  $$ values (1) $$,
  'anon can select from a table once it is granted explicitly'
);

select lives_ok(
  $$ select nextval('public.default_privileges_probe_seq') $$,
  'anon can use a sequence once it is granted explicitly'
);

select results_eq(
  $$ select public.default_privileges_probe_fn() $$,
  $$ values (1) $$,
  'anon can execute a function once it is granted explicitly'
);

reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id from public.default_privileges_probe where id = 1 $$,
  $$ values (1) $$,
  'authenticated can select from a table once it is granted explicitly'
);

select results_eq(
  $$ select public.default_privileges_probe_fn() $$,
  $$ values (1) $$,
  'authenticated can execute a function once it is granted explicitly'
);

reset role;

select * from finish();
rollback;
