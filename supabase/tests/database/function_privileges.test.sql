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
-- Scope: `public`, `private` and `internal` (the app's schemas) and
-- `graphql_public` (Supabase's GraphQL entry point, exposed by the API).
-- `internal` holds trigger functions and helpers no API role may call or
-- even see (security review #37): anon and authenticated have no USAGE or
-- CREATE on it and EXECUTE on none of its functions, so the allow-lists
-- below have no internal entries, and every function there, security
-- definer or not, sets an empty search_path. Functions owned by an
-- extension (pg_depend deptype 'e') are left out, so an extension installed
-- into one of these schemas (e.g. pgTAP for this run) doesn't make the list
-- depend on the environment; none of them is in the lists today.
--
-- Signatures are built as schema.name(argument types) rather than with
-- oid::regprocedure::text, which leaves out the schema when it is on the
-- search_path and so would differ between environments.
begin;
select plan(21);

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
  where n.nspname in ('public', 'private', 'internal', 'graphql_public')
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

-- Functions in internal without an empty search_path, security definer or
-- not.
create temporary view internal_functions_without_empty_search_path as
  select f.signature
  from pg_temp.app_functions f
  where f.signature like 'internal.%'
    and not ('search_path=""' = any (coalesce(f.proconfig, '{}'::text[])));

-- Main assertions -----------------------------------------------------------

select set_eq(
  $$ select signature from pg_temp.executable_by_anon $$,
  $$ values
       ('public.health_check()'),
       ('graphql_public.graphql(text, text, jsonb, jsonb)'),
       ('private.is_category_visible(uuid)'),
       ('private.is_quiz_visible(uuid)'),
       ('private.is_question_visible(uuid)'),
       ('private.is_admin()') $$,
  'anon can execute exactly the allow-listed functions'
);

-- A learner and an admin are both the `authenticated` role. The admin read
-- policies call private.is_admin(), which anon and authenticated may execute
-- like the visibility helpers. admin_question() (#81) is the admin's read of
-- questions.explanation: authenticated may execute it, and the function
-- itself refuses everyone but an admin (admin_question.test.sql).
-- admin_answers() (#82) is the admin's read of answers.is_correct, refused
-- to everyone but an admin the same way (admin_answers.test.sql).
-- save_question() (#82) is the admin's save of a question with its answers
-- in one transaction; it is security invoker, so the grants and RLS of
-- questions and answers decide who may write (save_question.test.sql).
-- Re-spec (#83): save_question() also writes the question's image_path and
-- image_alt (two trailing parameters) and each answer's (in the answers
-- payload); the six-argument overload is dropped, not left behind
-- (save_question_images.test.sql).
-- Re-spec (#84): reorder_categories(), reorder_quizzes() and
-- reorder_questions() are the admin's one-call reorders of a list's
-- sort_order. Security definer (sort_order has no column grant), guarded by
-- private.is_admin(), refused to everyone else; they return nothing, so no
-- solution can leak through them (reorder_*.test.sql).
select set_eq(
  $$ select signature from pg_temp.executable_by_authenticated $$,
  $$ values
       ('public.health_check()'),
       ('graphql_public.graphql(text, text, jsonb, jsonb)'),
       ('private.is_category_visible(uuid)'),
       ('private.is_quiz_visible(uuid)'),
       ('private.is_question_visible(uuid)'),
       ('private.is_admin()'),
       ('public.start_attempt(uuid)'),
       ('public.submit_answer(uuid, uuid, uuid[])'),
       ('public.admin_question(uuid)'),
       ('public.admin_answers(uuid)'),
       ('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)'),
       ('public.reorder_categories(uuid[])'),
       ('public.reorder_quizzes(uuid, uuid[])'),
       ('public.reorder_questions(uuid, uuid[])') $$,
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

-- The internal schema ---------------------------------------------------------

-- Sanity: the view sees internal's functions, so the checks below can't
-- pass vacuously.
select ok(
  exists (
    select 1 from pg_temp.app_functions f
    where f.signature = 'internal.check_quiz_publish_rules()'
  ),
  'the catalog query sees internal.check_quiz_publish_rules()'
);

select is_empty(
  $$ select signature from pg_temp.app_functions
     where signature like 'internal.%'
       and (has_function_privilege('anon', oid, 'execute')
            or has_function_privilege('authenticated', oid, 'execute'))
     order by 1 $$,
  'anon and authenticated can execute no function in internal'
);

select ok(
  not has_schema_privilege('anon', 'internal', 'usage')
  and not has_schema_privilege('authenticated', 'internal', 'usage'),
  'anon and authenticated have no usage on schema internal'
);

select ok(
  not has_schema_privilege('anon', 'internal', 'create')
  and not has_schema_privilege('authenticated', 'internal', 'create'),
  'anon and authenticated cannot create objects in schema internal'
);

select is_empty(
  $$ select signature from pg_temp.internal_functions_without_empty_search_path order by 1 $$,
  'every function in internal sets an empty search_path'
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
      ('private.is_question_visible(uuid)'),
      ('private.is_admin()')
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
      ('private.is_admin()'),
      ('public.start_attempt(uuid)'),
      ('public.submit_answer(uuid, uuid, uuid[])'),
      ('public.admin_question(uuid)'),
      ('public.admin_answers(uuid)'),
      ('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)'),
      ('public.reorder_categories(uuid[])'),
      ('public.reorder_quizzes(uuid, uuid[])'),
      ('public.reorder_questions(uuid, uuid[])')
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

-- Negative case: an internal function without search_path ------------------

create function internal.function_privileges_invoker_probe()
returns integer
language sql
as $$ select 1 $$;

select results_eq(
  $$ select signature from pg_temp.internal_functions_without_empty_search_path order by 1 $$,
  $$ values ('internal.function_privileges_invoker_probe()'::text) $$,
  'a security invoker function in internal without a search_path is reported'
);

drop function internal.function_privileges_invoker_probe();

-- Negative case: an internal function granted to authenticated --------------

create function internal.function_privileges_internal_probe()
returns integer
language sql
set search_path = ''
as $$ select 1 $$;

grant execute on function internal.function_privileges_internal_probe() to authenticated;

select results_eq(
  $$ select signature from pg_temp.executable_by_authenticated
     where signature like 'internal.%' $$,
  $$ values ('internal.function_privileges_internal_probe()'::text) $$,
  'an internal function granted to authenticated shows up in its executable list'
);

drop function internal.function_privileges_internal_probe();

select is_empty(
  $$ select signature from pg_temp.internal_functions_without_empty_search_path
     union all
     select signature from pg_temp.executable_by_authenticated where signature like 'internal.%' $$,
  'the internal checks are clean again once the probe functions are gone'
);

select * from finish();
rollback;
