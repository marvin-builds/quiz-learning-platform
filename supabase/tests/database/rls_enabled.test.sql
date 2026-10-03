-- Every table in the app's schemas has row-level security enabled. The hosted
-- project turns RLS on automatically ("Enable automatic RLS"); the local stack
-- does not, so a migration that forgets `enable row level security` would pass
-- locally and return zero rows on hosted. The check reads the catalog, so new
-- tables are covered without editing this file.
--
-- Scope: the app schema `public` only. When the app gets another schema of its
-- own (e.g. `private`), add it to the schema list in the view below.
-- Supabase-managed schemas (auth, storage, realtime, ...) are out of scope.
begin;
select plan(4);

-- The one check query, shared by the main assertion and the negative case.
-- `collate "default"`: format() over `name` columns inherits their "C"
-- collation, which results_eq can't compare against a plain text literal.
create temporary view tables_without_rls as
  select format('%I.%I', n.nspname, c.relname) collate "default" as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname in ('public')
    and not c.relrowsecurity;

-- Main assertion ------------------------------------------------------------

select is_empty(
  $$ select table_name from pg_temp.tables_without_rls order by 1 $$,
  'every table in public has row-level security enabled'
);

-- Sanity: the same catalog filter sees real tables, so the check can't pass
-- vacuously because of a broken query.
select ok(
  exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public')
      and c.relrowsecurity
      and c.relname = 'profiles'
  ),
  'the catalog query sees public.profiles among the tables with RLS'
);

-- Negative case: a table created without RLS is reported -------------------

savepoint without_rls;

create table public.rls_enabled_probe (id int);

select results_eq(
  $$ select table_name from pg_temp.tables_without_rls order by 1 $$,
  $$ values ('public.rls_enabled_probe'::text) $$,
  'a public table created without RLS is reported by the check'
);

rollback to savepoint without_rls;

select is_empty(
  $$ select table_name from pg_temp.tables_without_rls order by 1 $$,
  'the check is clean again once the table without RLS is gone'
);

select * from finish();
rollback;
