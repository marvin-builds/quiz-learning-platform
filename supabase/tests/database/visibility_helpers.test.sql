-- The visibility helpers behind the content RLS policies live in schema
-- `private`, which the API doesn't expose (config.toml [api] schemas; that
-- part can't be checked from SQL). They run as security definer with an empty
-- search_path, and anon and authenticated may call them because the policies
-- run with the caller's rights. `private` holds only functions, so no table or
-- view there could be read past RLS.
--
-- Pinned names: private.is_category_visible(uuid) and
-- private.is_quiz_visible(uuid), both returning boolean. The catalog checks
-- cover every function in `private`, so further helpers are held to the same
-- rules without editing this file.
begin;
select plan(29);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test');

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Verstecktes Thema', 2, false);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlichtes Quiz', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 2, false),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000002',
   'Quiz im versteckten Thema', 1, true);

-- Schema `private` ----------------------------------------------------------

select has_schema('private', 'schema private exists');

select is_empty(
  $$ select format('%I.%I', n.nspname, c.relname)
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'private' $$,
  'private holds no tables, views, sequences or other relations'
);

select ok(
  has_schema_privilege('anon', 'private', 'usage'),
  'anon has usage on schema private'
);

select ok(
  has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated has usage on schema private'
);

select ok(
  not has_schema_privilege('anon', 'private', 'create')
    and not has_schema_privilege('authenticated', 'private', 'create'),
  'anon and authenticated cannot create objects in schema private'
);

-- The pinned helpers --------------------------------------------------------

select has_function('private', 'is_category_visible', '{uuid}'::name[],
  'private.is_category_visible(uuid) exists');

select function_returns('private', 'is_category_visible', '{uuid}'::name[], 'boolean',
  'private.is_category_visible(uuid) returns boolean');

select is_definer('private', 'is_category_visible', '{uuid}'::name[],
  'private.is_category_visible(uuid) is security definer');

select has_function('private', 'is_quiz_visible', '{uuid}'::name[],
  'private.is_quiz_visible(uuid) exists');

select function_returns('private', 'is_quiz_visible', '{uuid}'::name[], 'boolean',
  'private.is_quiz_visible(uuid) returns boolean');

select is_definer('private', 'is_quiz_visible', '{uuid}'::name[],
  'private.is_quiz_visible(uuid) is security definer');

-- Every function in `private` ---------------------------------------------

select is_empty(
  $$ select p.oid::regprocedure::text
     from pg_proc p
     where p.pronamespace = 'private'::regnamespace
       and not p.prosecdef $$,
  'every function in private is security definer'
);

select is_empty(
  $$ select p.oid::regprocedure::text
     from pg_proc p
     where p.pronamespace = 'private'::regnamespace
       and not coalesce(p.proconfig @> array['search_path=""'], false) $$,
  'every function in private sets search_path to the empty string'
);

select is_empty(
  $$ select p.oid::regprocedure::text
     from pg_proc p
     where p.pronamespace = 'private'::regnamespace
       and not (has_function_privilege('anon', p.oid, 'execute')
                and has_function_privilege('authenticated', p.oid, 'execute')) $$,
  'anon and authenticated may execute every function in private'
);

-- Sanity: the catalog checks above see the helpers, so they can't pass
-- vacuously on an empty schema.
select ok(
  (select count(*) from pg_proc where pronamespace = 'private'::regnamespace) >= 2,
  'the catalog checks see at least the two pinned helpers'
);

-- New functions in private stay closed until granted ----------------------

create function private.visibility_helpers_probe()
returns int
language sql
as $$ select 1 $$;

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select private.is_category_visible('c0000000-0000-0000-0000-000000000001') $$,
  $$ values (true) $$,
  'for anon, is_category_visible is true for a published category'
);

select results_eq(
  $$ select private.is_category_visible('c0000000-0000-0000-0000-000000000002') $$,
  $$ values (false) $$,
  'for anon, is_category_visible is false for an unpublished category'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-000000000001') $$,
  $$ values (true) $$,
  'for anon, is_quiz_visible is true for a published quiz in a published category'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-000000000002') $$,
  $$ values (false) $$,
  'for anon, is_quiz_visible is false for an unpublished quiz'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-000000000003') $$,
  $$ values (false) $$,
  'for anon, is_quiz_visible is false for a published quiz in an unpublished category'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-0000000000ff') $$,
  $$ values (false) $$,
  'for anon, is_quiz_visible is false for a quiz that does not exist'
);

select throws_ok(
  $$ select private.visibility_helpers_probe() $$,
  '42501', null,
  'anon cannot execute a function created in private without a grant'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select private.is_category_visible('c0000000-0000-0000-0000-000000000001') $$,
  $$ values (true) $$,
  'for a learner, is_category_visible is true for a published category'
);

select results_eq(
  $$ select private.is_category_visible('c0000000-0000-0000-0000-000000000002') $$,
  $$ values (false) $$,
  'for a learner, is_category_visible is false for an unpublished category'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-000000000001') $$,
  $$ values (true) $$,
  'for a learner, is_quiz_visible is true for a published quiz in a published category'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-000000000002') $$,
  $$ values (false) $$,
  'for a learner, is_quiz_visible is false for an unpublished quiz'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-000000000003') $$,
  $$ values (false) $$,
  'for a learner, is_quiz_visible is false for a published quiz in an unpublished category'
);

select results_eq(
  $$ select private.is_quiz_visible('d0000000-0000-0000-0000-0000000000ff') $$,
  $$ values (false) $$,
  'for a learner, is_quiz_visible is false for a quiz that does not exist'
);

select throws_ok(
  $$ select private.visibility_helpers_probe() $$,
  '42501', null,
  'authenticated cannot execute a function created in private without a grant'
);

reset role;

select * from finish();
rollback;
