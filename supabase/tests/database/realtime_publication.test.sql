-- The `supabase_realtime` publication carries no app table. Realtime streams
-- every change of a published table to subscribed clients; its row filtering
-- is not the column grants that keep `answers.is_correct` and
-- `questions.explanation` from learners, so publishing `answers`, `questions`
-- or `attempts` (e.g. by ticking "Enable Realtime" in the dashboard, or with
-- `for all tables`) could stream solutions and scores. The app uses no
-- Realtime, so the rule is simply: nothing from `public`.
--
-- Supabase creates the publication; a project may also lack it. Both are
-- fine: the checks read pg_publication and pg_publication_tables, which are
-- empty for a missing publication, and a probe below shows that case stays
-- green. pg_publication_tables expands `for all tables` and
-- `for tables in schema`, so the table check covers those forms too.
begin;
select plan(9);

-- The check queries, shared by the main assertions and the probe cases.
-- `collate "default"`: format() over `name` columns inherits their "C"
-- collation, which results_eq can't compare against a plain text literal.
create temporary view published_app_tables as
  select format('%I.%I', t.schemaname, t.tablename) collate "default" as table_name
  from pg_publication_tables t
  where t.pubname = 'supabase_realtime'
    and t.schemaname = 'public';

create temporary view realtime_publishes_all_tables as
  select coalesce(
    (select p.puballtables from pg_publication p where p.pubname = 'supabase_realtime'),
    false
  ) as all_tables;

-- Main assertions -----------------------------------------------------------

select is(
  (select all_tables from pg_temp.realtime_publishes_all_tables),
  false,
  'supabase_realtime does not publish all tables'
);

select is_empty(
  $$ select table_name from pg_temp.published_app_tables order by 1 $$,
  'supabase_realtime publishes no table in public'
);

-- Probe cases ---------------------------------------------------------------
-- Each one changes the publication, checks the views see it and undoes the
-- change, as rls_enabled.test.sql does; the final rollback restores the rest.
-- Not savepoints: rolling one back would also erase pgTAP's record of the
-- assertions made inside it.

-- Plan around both: a project without the publication gets one here.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- Negative case: a public table added to the publication is reported --------

create table public.realtime_publication_probe (id integer primary key);
alter publication supabase_realtime add table public.realtime_publication_probe;

select results_eq(
  $$ select table_name from pg_temp.published_app_tables order by 1 $$,
  $$ values ('public.realtime_publication_probe'::text) $$,
  'a public table added to supabase_realtime is reported by the check'
);

drop table public.realtime_publication_probe;

select is_empty(
  $$ select table_name from pg_temp.published_app_tables order by 1 $$,
  'the table check is clean again once the probe table is gone'
);

-- Negative case: the whole public schema added is reported -------------------

alter publication supabase_realtime add tables in schema public;

select ok(
  exists (
    select 1 from pg_temp.published_app_tables
    where table_name = 'public.answers'
  ),
  'publishing the public schema is reported by the check (it lists public.answers)'
);

alter publication supabase_realtime drop tables in schema public;

-- Positive case: a missing publication passes ------------------------------

drop publication supabase_realtime;

select is(
  (select all_tables from pg_temp.realtime_publishes_all_tables),
  false,
  'without supabase_realtime the all-tables check passes'
);

select is_empty(
  $$ select table_name from pg_temp.published_app_tables order by 1 $$,
  'without supabase_realtime the table check passes'
);

-- Negative case: a publication for all tables is reported --------------------

create publication supabase_realtime for all tables;

select is(
  (select all_tables from pg_temp.realtime_publishes_all_tables),
  true,
  'a supabase_realtime for all tables is reported by the all-tables check'
);

select ok(
  exists (
    select 1 from pg_temp.published_app_tables
    where table_name = 'public.answers'
  ),
  'a supabase_realtime for all tables is also reported by the table check'
);

select * from finish();
rollback;
