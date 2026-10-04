-- Which functions the API roles can call, and how security definer functions
-- pin their search_path. PostgREST exposes every function a role may EXECUTE
-- in an exposed schema as /rest/v1/rpc/<name>, and a security definer function
-- runs with its owner's rights, so either one is a way past RLS: a new function
-- that leaks `answers.is_correct` or `questions.explanation`, or writes a
-- score, must show up here as a change to the allow-list rather than slip in
-- through a grant (or a forgotten revoke of Postgres' default grant to PUBLIC).
-- The checks read the catalog, so new functions are covered without editing
-- this file; only the expected lists change, and only on purpose.
--
-- Scope: `public` and `private` (the app's schemas) and `graphql_public`
-- (Supabase's GraphQL entry point, exposed by the API). Functions owned by an
-- extension (pg_depend deptype 'e') are left out, so an extension installed
-- into one of these schemas (e.g. pgTAP for this run) doesn't make the list
-- depend on the environment; none of them is in the lists today.
--
-- Signatures are built as schema.name(argument types) rather than with
-- oid::regprocedure::text, which leaves out the schema when it is on the
-- search_path and so would differ between environments.
begin;
select plan(13);

-- The one schema list. Every check below builds on this view.
-- `collate "default"`: format() over `name` columns inherits their "C"
-- collation, which the set comparisons can't match against a text literal.
create temporary view app_functions as
  select
    p.oid,
    format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
      collate "default" as signature,
    p.prosecdef,
    p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'graphql_public')
    and not exists (
      select 1
      from pg_depend d
      where d.classid = 'pg_proc'::regclass
        and d.objid = p.oid
        and d.deptype = 'e'
    );

-- The check queries, shared by the main assertions and the probe cases.
create temporary view executable_by_anon as
  select f.signature
  from pg_temp.app_functions f
  where has_function_privilege('anon', f.oid, 'execute');

create temporary view executable_by_authenticated as
  select f.signature
  from pg_temp.app_functions f
  where has_function_privilege('authenticated', f.oid, 'execute');

-- A security definer function resolves unqualified names through its
-- search_path. Without its own, that is the caller's, so a caller could
-- shadow a table or function it uses; a fixed but non-empty one still trusts
-- every schema on it. So the rule is an empty search_path (`set search_path =
-- ''`, stored as search_path="") and fully qualified names in the body.
create temporary view definers_without_empty_search_path as
  select f.signature
  from pg_temp.app_functions f
  where f.prosecdef
    and not ('search_path=""' = any (coalesce(f.proconfig, '{}'::text[])));

-- Main assertions -----------------------------------------------------------

select set_eq(
  $$ select signature from pg_temp.executable_by_anon $$,
  $$ values
       ('public.health_check()'),
       ('graphql_public.graphql(text, text, jsonb, jsonb)'),
       ('private.is_category_visible(uuid)'),
       ('private.is_quiz_visible(uuid)'),
       ('private.is_question_visible(uuid)') $$,
  'anon can execute exactly the allow-listed functions'
);

-- A learner and an admin are both the `authenticated` role; phase 1 gives
-- the admin nothing more.
select set_eq(
  $$ select signature from pg_temp.executable_by_authenticated $$,
  $$ values
       ('public.health_check()'),
       ('graphql_public.graphql(text, text, jsonb, jsonb)'),
       ('private.is_category_visible(uuid)'),
       ('private.is_quiz_visible(uuid)'),
       ('private.is_question_visible(uuid)'),
       ('public.start_attempt(uuid)'),
       ('public.submit_answer(uuid, uuid, uuid[])') $$,
  'authenticated can execute exactly the allow-listed functions'
);

select is_empty(
  $$ select signature from pg_temp.definers_without_empty_search_path order by 1 $$,
  'every security definer function sets an empty search_path'
);

-- Sanity: the view sees the security definer functions the app has, so the
-- search_path check can't pass vacuously because of a broken query.
select ok(
  exists (
    select 1
    from pg_temp.app_functions f
    where f.prosecdef
      and f.signature = 'public.submit_answer(uuid, uuid, uuid[])'
  ),
  'the catalog query sees submit_answer() among the security definer functions'
);

-- Probe cases ---------------------------------------------------------------
-- Each one creates a function, checks the views report it and drops it again,
-- as rls_enabled.test.sql does. Not savepoints: rolling one back would also
-- erase pgTAP's record of the assertions made inside it.

-- Negative case: a function granted to anon is reported ----------------------

create function public.function_privileges_probe()
returns integer
language sql
as $$ select 1 $$;

grant execute on function public.function_privileges_probe() to anon;

select results_eq(
  $$
    select signature from pg_temp.executable_by_anon
    except
    values
      ('public.health_check()'),
      ('graphql_public.graphql(text, text, jsonb, jsonb)'),
      ('private.is_category_visible(uuid)'),
      ('private.is_quiz_visible(uuid)'),
      ('private.is_question_visible(uuid)')
  $$,
  $$ values ('public.function_privileges_probe()'::text) $$,
  'a function granted to anon shows up outside the allow-list'
);

drop function public.function_privileges_probe();

select is_empty(
  $$
    select signature from pg_temp.executable_by_anon
    where signature like '%function_privileges_probe%'
  $$,
  'the allow-list check is clean again once the probe function is gone'
);

-- Negative case: a function granted to authenticated is reported ------------

create function public.function_privileges_authenticated_probe()
returns integer
language sql
as $$ select 1 $$;

grant execute on function public.function_privileges_authenticated_probe() to authenticated;

select results_eq(
  $$
    select signature from pg_temp.executable_by_authenticated
    except
    values
      ('public.health_check()'),
      ('graphql_public.graphql(text, text, jsonb, jsonb)'),
      ('private.is_category_visible(uuid)'),
      ('private.is_quiz_visible(uuid)'),
      ('private.is_question_visible(uuid)'),
      ('public.start_attempt(uuid)'),
      ('public.submit_answer(uuid, uuid, uuid[])')
  $$,
  $$ values ('public.function_privileges_authenticated_probe()'::text) $$,
  'a function granted to authenticated shows up outside its allow-list'
);

-- The views are per role: anon doesn't get what only authenticated was given.
select is_empty(
  $$
    select signature from pg_temp.executable_by_anon
    where signature like '%function_privileges_authenticated_probe%'
  $$,
  'a function granted to authenticated only is not reported for anon'
);

drop function public.function_privileges_authenticated_probe();

select is_empty(
  $$
    select signature from pg_temp.executable_by_authenticated
    where signature like '%function_privileges_authenticated_probe%'
  $$,
  'the authenticated allow-list check is clean again once the probe function is gone'
);

-- Negative case: a security definer function without search_path ------------

create function private.function_privileges_definer_probe()
returns integer
language sql
security definer
as $$ select 1 $$;

select results_eq(
  $$ select signature from pg_temp.definers_without_empty_search_path order by 1 $$,
  $$ values ('private.function_privileges_definer_probe()'::text) $$,
  'a security definer function without a search_path is reported by the check'
);

drop function private.function_privileges_definer_probe();

select is_empty(
  $$ select signature from pg_temp.definers_without_empty_search_path order by 1 $$,
  'the search_path check is clean again once the probe function is gone'
);

-- Negative case: a security definer function with a non-empty search_path ---

create function private.function_privileges_public_path_probe()
returns integer
language sql
security definer
set search_path = public
as $$ select 1 $$;

select results_eq(
  $$ select signature from pg_temp.definers_without_empty_search_path order by 1 $$,
  $$ values ('private.function_privileges_public_path_probe()'::text) $$,
  'a security definer function with search_path = public is reported by the check'
);

drop function private.function_privileges_public_path_probe();

select is_empty(
  $$ select signature from pg_temp.definers_without_empty_search_path order by 1 $$,
  'the search_path check is clean again once that probe function is gone'
);

select * from finish();
rollback;
