-- Every table in the app's schemas has row-level security enabled, and no view
-- there bypasses it. The hosted project turns RLS on automatically ("Enable
-- automatic RLS"); the local stack does not, so a migration that forgets
-- `enable row level security` would pass locally and return zero rows on
-- hosted. A view runs with its owner's rights unless it sets
-- `security_invoker`, so a granted view could read past RLS (e.g. expose
-- `answers.is_correct` or `questions.explanation` to learners). The checks read
-- the catalog, so new tables and views are covered without editing this file.
--
-- Scope: the app schema `public` only. The schema list lives in one place, the
-- `app_relations` view below; when the app gets another schema of its own
-- (e.g. `private`), add it there. Supabase-managed schemas (auth, storage,
-- realtime, ...) are out of scope.
begin;
select plan(9);

-- The one schema list. Every check below builds on this view.
create temporary view app_relations as
  select n.nspname, c.relname, c.relkind, c.relrowsecurity, c.reloptions
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public');

-- The check queries, shared by the main assertions and the probe cases.
-- `collate "default"`: format() over `name` columns inherits their "C"
-- collation, which results_eq can't compare against a plain text literal.
create temporary view tables_without_rls as
  select format('%I.%I', r.nspname, r.relname) collate "default" as table_name
  from pg_temp.app_relations r
  where r.relkind in ('r', 'p')
    and not r.relrowsecurity;

-- Plain views only (relkind 'v'). Materialized views can't set
-- `security_invoker` and are left out; they need their own rule if the app
-- ever uses them. Postgres accepts true/on/1/yes (any case) for the option, so
-- the value is cast to boolean rather than compared as text.
create temporary view views_without_security_invoker as
  select format('%I.%I', r.nspname, r.relname) collate "default" as view_name
  from pg_temp.app_relations r
  where r.relkind = 'v'
    and not coalesce(
      (
        select o.option_value::boolean
        from pg_options_to_table(r.reloptions) o
        where o.option_name = 'security_invoker'
      ),
      false
    );

-- Main assertions -----------------------------------------------------------

select is_empty(
  $$ select table_name from pg_temp.tables_without_rls order by 1 $$,
  'every table in public has row-level security enabled'
);

-- Sanity: the shared schema list sees real tables, so the checks can't pass
-- vacuously because of a broken query.
select ok(
  exists (
    select 1
    from pg_temp.app_relations r
    where r.relkind in ('r', 'p')
      and r.relrowsecurity
      and r.relname = 'profiles'
  ),
  'the catalog query sees public.profiles among the tables with RLS'
);

select is_empty(
  $$ select view_name from pg_temp.views_without_security_invoker order by 1 $$,
  'every view in public has security_invoker enabled'
);

-- Negative case: a table created without RLS is reported -------------------

create table public.rls_enabled_probe (id int);

select results_eq(
  $$ select table_name from pg_temp.tables_without_rls order by 1 $$,
  $$ values ('public.rls_enabled_probe'::text) $$,
  'a public table created without RLS is reported by the check'
);

drop table public.rls_enabled_probe;

select is_empty(
  $$ select table_name from pg_temp.tables_without_rls order by 1 $$,
  'the check is clean again once the table without RLS is gone'
);

-- Negative case: a view without security_invoker is reported ---------------

create view public.rls_enabled_probe_view as select 1 as x;

select results_eq(
  $$ select view_name from pg_temp.views_without_security_invoker order by 1 $$,
  $$ values ('public.rls_enabled_probe_view'::text) $$,
  'a public view created without security_invoker is reported by the check'
);

drop view public.rls_enabled_probe_view;

select is_empty(
  $$ select view_name from pg_temp.views_without_security_invoker order by 1 $$,
  'the view check is clean again once the view without security_invoker is gone'
);

-- Positive case: a view with security_invoker is not reported --------------

create view public.rls_enabled_probe_invoker_view
  with (security_invoker = true)
  as select 1 as x;

select is_empty(
  $$ select view_name from pg_temp.views_without_security_invoker order by 1 $$,
  'a public view created with security_invoker is not reported by the check'
);

drop view public.rls_enabled_probe_invoker_view;

select is_empty(
  $$ select view_name from pg_temp.views_without_security_invoker order by 1 $$,
  'the view check is clean after the probe views are gone'
);

select * from finish();
rollback;
