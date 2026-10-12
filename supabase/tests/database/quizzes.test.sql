-- public.quizzes: structure, constraints and access per role (anon,
-- anonymous user, learner, admin). For everyone but an admin a quiz is
-- visible only if it and its category are published; an admin reads every
-- quiz (private.is_admin()). Fixtures are created here as the owner,
-- independent of seed.sql, and vanish on rollback.
--
-- Only an admin writes quizzes through the API (#81): insert category_id,
-- title, description and published; update title, description and published
-- (no move to another category); delete. The database assigns sort_order
-- (max + 1 within the category, or 1 in an empty one) in a before-insert
-- trigger in schema internal; id, created_at and sort_order are never
-- writable. A learner's or an anonymous user's update or delete passes the
-- grant but RLS lets it touch no row, so those tests target a published row
-- the role can see and check afterwards, as the owner, that it is
-- unchanged; their insert fails with an RLS error. anon has no write grant.
begin;
select plan(95);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Verstecktes Thema', 2, false);

insert into public.quizzes (id, category_id, title, description, sort_order, published) values
  -- published quiz in a published category: visible
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlichtes Quiz', 'Zum Üben', 1, true),
  -- unpublished quiz in a published category: hidden
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', null, 2, false),
  -- published quiz in an unpublished category: hidden
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000002',
   'Quiz im versteckten Thema', null, 1, true);

insert into public.questions (id, quiz_id, text, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
   'Frage im Entwurf?', 1);

-- Only for the admin's writes, so the read tests keep their fixtures.
insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000003', 'Leeres Thema', 3, true);

insert into public.quizzes (id, category_id, title, description, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001',
   'Zum Bearbeiten', 'Alt', 3, true),
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001',
   'Zum Veröffentlichen', null, 4, false),
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001',
   'Zum Löschen', null, 5, true);

-- Re-spec (#82): a quiz may only be published with questions that keep the
-- answer rules (quiz_publish_rules.test.sql), so the quiz the admin
-- publishes below gets a valid question; it used to have none.
insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000005',
   'Frage zum Veröffentlichen?', false, 1);

insert into public.answers (question_id, text, is_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000005', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000005', 'Nein', false, 2);

-- The number of rows a write touched, or null (with the error as a notice)
-- when it raised one, so a failing write reports here instead of aborting
-- the file. Temporary, so it never shows up in function_privileges.test.sql.
create function pg_temp.touched_rows(statement text)
returns integer
language plpgsql
as $fn$
declare
  touched integer;
begin
  execute statement;
  get diagnostics touched = row_count;
  return touched;
exception when others then
  raise notice 'touched_rows: % (%)', sqlerrm, sqlstate;
  return null;
end;
$fn$;

grant execute on function pg_temp.touched_rows(text) to authenticated;

-- The advisory locks this transaction holds, to see the sort_order trigger
-- serialise inserts per category.
create function pg_temp.advisory_locks()
returns integer
language sql
as $fn$
  select count(*)::integer from pg_locks
  where locktype = 'advisory' and pid = pg_backend_pid() and granted
$fn$;

grant execute on function pg_temp.advisory_locks() to authenticated;

-- Structure ---------------------------------------------------------------

select has_table('public', 'quizzes', 'quizzes table exists');

select columns_are('public', 'quizzes',
  array['id', 'category_id', 'title', 'description', 'sort_order', 'published', 'created_at'],
  'quizzes has exactly the planned columns');

select col_is_pk('public', 'quizzes', 'id', 'quizzes.id is the primary key');
select col_type_is('public', 'quizzes', 'id', 'uuid', 'quizzes.id is a uuid');
select col_has_default('public', 'quizzes', 'id', 'quizzes.id has a default');

select col_type_is('public', 'quizzes', 'category_id', 'uuid', 'quizzes.category_id is a uuid');
select col_not_null('public', 'quizzes', 'category_id', 'quizzes.category_id is required');
select fk_ok('public', 'quizzes', 'category_id', 'public', 'categories', 'id',
  'quizzes.category_id references categories.id');

select col_type_is('public', 'quizzes', 'title', 'text', 'quizzes.title is text');
select col_not_null('public', 'quizzes', 'title', 'quizzes.title is required');

select col_type_is('public', 'quizzes', 'description', 'text', 'quizzes.description is text');
select col_is_null('public', 'quizzes', 'description', 'quizzes.description is optional');

select col_type_is('public', 'quizzes', 'sort_order', 'integer',
  'quizzes.sort_order is an integer');
select col_not_null('public', 'quizzes', 'sort_order', 'quizzes.sort_order is required');

select col_type_is('public', 'quizzes', 'published', 'boolean',
  'quizzes.published is a boolean');
select col_not_null('public', 'quizzes', 'published', 'quizzes.published is required');

select col_type_is('public', 'quizzes', 'created_at', 'timestamp with time zone',
  'quizzes.created_at is a timestamptz');
select col_not_null('public', 'quizzes', 'created_at', 'quizzes.created_at is required');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.quizzes'::regclass
      and a.attname = 'category_id'
  ),
  'an index leads with quizzes.category_id'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.quizzes'::regclass),
  'quizzes has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

insert into public.quizzes (category_id, title, sort_order)
values ('c0000000-0000-0000-0000-000000000001', 'Nur Pflichtfelder', 9);

select results_eq(
  $$ select id is not null, published, created_at = now()
     from public.quizzes where title = 'Nur Pflichtfelder' $$,
  $$ values (true, false, true) $$,
  'a new quiz gets an id, published = false and created_at = now() by default'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order)
     values ('c0000000-0000-0000-0000-000000000001', null, 1) $$,
  '23502', null,
  'a quiz without a title is rejected'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order)
     values ('c0000000-0000-0000-0000-000000000001', '   ', 1) $$,
  '23514', null,
  'a quiz with a blank title is rejected'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order)
     values (null, 'Ohne Thema', 1) $$,
  '23502', null,
  'a quiz without a category is rejected'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order)
     values ('c0000000-0000-0000-0000-0000000000ff', 'Verwaist', 1) $$,
  '23503', null,
  'a quiz in a category that does not exist is rejected'
);

delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000002';

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  'deleting a quiz deletes its questions'
);

-- Restore the deleted fixture for the role tests.
insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 2, false);

-- Grants, policies and the sort_order trigger (catalog) ---------------------

select ok(
  not has_table_privilege('anon', 'public.quizzes', 'INSERT, UPDATE, DELETE'),
  'anon has no write privilege on quizzes'
);

-- has_table_privilege ignores column-level grants; anon gets none either.
select ok(
  not has_any_column_privilege('anon', 'public.quizzes', 'INSERT')
  and not has_any_column_privilege('anon', 'public.quizzes', 'UPDATE'),
  'anon has no column-level insert or update privilege on quizzes'
);

select results_eq(
  $$ select c.column_name::text collate "default",
            has_column_privilege('authenticated', 'public.quizzes', c.column_name, 'INSERT'),
            has_column_privilege('authenticated', 'public.quizzes', c.column_name, 'UPDATE')
     from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'quizzes'
     order by c.column_name $$,
  $$ values ('category_id'::text, true, false),
            ('created_at'::text, false, false),
            ('description'::text, true, true),
            ('id'::text, false, false),
            ('published'::text, true, true),
            ('sort_order'::text, false, false),
            ('title'::text, true, true) $$,
  'authenticated may insert category_id, title, description and published, and update all but category_id'
);

select ok(
  has_table_privilege('authenticated', 'public.quizzes', 'DELETE'),
  'authenticated may delete quizzes (RLS decides which)'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'quizzes'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and roles <> '{authenticated}'::name[] $$,
  'every write policy on quizzes applies to authenticated only'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'quizzes'
       and cmd in ('UPDATE', 'ALL')
       and (qual is null or with_check is null) $$,
  'every update policy on quizzes has both using and with check'
);

select set_eq(
  $$ select w.cmd from (values ('INSERT'), ('UPDATE'), ('DELETE')) as w(cmd)
     where exists (
       select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = 'quizzes'
         and p.cmd in (w.cmd, 'ALL')) $$,
  $$ values ('INSERT'), ('UPDATE'), ('DELETE') $$,
  'quizzes has a policy for each write: insert, update and delete (or one for all)'
);

-- The trigger fills in sort_order only when none is given, so the owner
-- (seed, migrations) keeps an explicit one; its function lives in schema
-- internal, which no API role may use or execute.
select ok(
  coalesce((
    select bool_and(
             n.nspname = 'internal'
             and pg_get_triggerdef(t.oid) ~* 'when \(\(?new\.sort_order is null\)?\)'
             and not has_function_privilege('anon', t.tgfoid, 'execute')
             and not has_function_privilege('authenticated', t.tgfoid, 'execute'))
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = p.pronamespace
    where t.tgrelid = 'public.quizzes'::regclass
      and not t.tgisinternal
      and pg_get_triggerdef(t.oid) ~* 'before insert'
      and pg_get_triggerdef(t.oid) ~* 'sort_order'
  ), false),
  'a before-insert trigger on quizzes, only when sort_order is null, runs a function in schema internal that no API role may execute'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select id, category_id, title, description, sort_order, published from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid,
             'c0000000-0000-0000-0000-000000000001'::uuid,
             'Veröffentlichtes Quiz'::text, 'Zum Üben'::text, 1, true) $$,
  'anon sees a published quiz in a published category with all its columns'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000002' $$,
  'anon does not see an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000003' $$,
  'anon does not see a published quiz in an unpublished category'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order, published)
     values ('c0000000-0000-0000-0000-000000000001', 'Neu', 3, true) $$,
  '42501', null,
  'anon cannot insert a quiz'
);

-- Only the columns an admin may insert, so a column-level insert grant to
-- anon would show up as an RLS error instead of a missing grant.
select throws_ok(
  $$ insert into public.quizzes (category_id, title, description, published)
     values ('c0000000-0000-0000-0000-000000000001', 'Neu', null, true) $$,
  '42501', 'permission denied for table quizzes',
  'anon cannot insert a quiz with only the admin-writable columns (no grant, not RLS)'
);

select throws_ok(
  $$ update public.quizzes set title = 'Geändert'
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot update a quiz'
);

select throws_ok(
  $$ delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete a quiz'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid) $$,
  'an anonymous user sees a published quiz in a published category'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000002' $$,
  'an anonymous user does not see an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000003' $$,
  'an anonymous user does not see a published quiz in an unpublished category'
);

select throws_like(
  $$ insert into public.quizzes (category_id, title, description, published)
     values ('c0000000-0000-0000-0000-000000000001', 'Von Anonym', null, true) $$,
  '%row-level security%',
  'an anonymous user cannot insert a quiz (RLS)'
);

select is(
  pg_temp.touched_rows($$ update public.quizzes set title = 'Von Anonym geändert', published = false
     where id = 'd0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s update of a visible published quiz touches no row, without an error'
);

select is(
  pg_temp.touched_rows($$ delete from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s delete of a visible published quiz touches no row, without an error'
);

reset role;

select results_eq(
  $$ select title, description, published from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Veröffentlichtes Quiz'::text, 'Zum Üben'::text, true) $$,
  'after the anonymous user''s writes the published quiz is still there, unchanged'
);

select is_empty(
  $$ select 1 from public.quizzes where title = 'Von Anonym' $$,
  'the anonymous user''s insert left no row behind'
);

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id, category_id, title, description, sort_order, published from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid,
             'c0000000-0000-0000-0000-000000000001'::uuid,
             'Veröffentlichtes Quiz'::text, 'Zum Üben'::text, 1, true) $$,
  'a learner sees a published quiz in a published category with all its columns'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000002' $$,
  'a learner does not see an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000003' $$,
  'a learner does not see a published quiz in an unpublished category'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order, published)
     values ('c0000000-0000-0000-0000-000000000001', 'Neu', 3, true) $$,
  '42501', null,
  'a learner cannot insert a quiz'
);

select throws_like(
  $$ insert into public.quizzes (category_id, title, description, published)
     values ('c0000000-0000-0000-0000-000000000001', 'Vom Lerner', null, true) $$,
  '%row-level security%',
  'a learner cannot insert a quiz with only writable columns either (RLS)'
);

-- Re-spec (#81): with the update and delete grants for the admin, a
-- learner's update or delete is no longer refused by a missing grant; RLS
-- lets it touch no row, which the owner checks below.
select is(
  pg_temp.touched_rows($$ update public.quizzes set title = 'Geändert'
     where id = 'd0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot update a quiz: the update touches no row'
);

select is(
  pg_temp.touched_rows($$ delete from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot delete a quiz: the delete touches no row'
);

reset role;

select results_eq(
  $$ select title, description, published from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Veröffentlichtes Quiz'::text, 'Zum Üben'::text, true) $$,
  'after the learner''s writes the published quiz is still there, unchanged'
);

select is_empty(
  $$ select 1 from public.quizzes where title = 'Vom Lerner' $$,
  'the learner''s insert left no row behind'
);

-- admin (carol) -----------------------------------------------------------

-- The next sort_order the database must assign in the first category.
select set_config('test.next_sort_order',
  (select (max(sort_order) + 1)::text from public.quizzes
   where category_id = 'c0000000-0000-0000-0000-000000000001'), true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, category_id, title, description, sort_order, published from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid,
             'c0000000-0000-0000-0000-000000000001'::uuid,
             'Veröffentlichtes Quiz'::text, 'Zum Üben'::text, 1, true) $$,
  'an admin sees a published quiz in a published category'
);

select results_eq(
  $$ select id, category_id, title, description, sort_order, published from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000002' $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid,
             'c0000000-0000-0000-0000-000000000001'::uuid,
             'Entwurf'::text, null::text, 2, false) $$,
  'an admin sees an unpublished quiz with all its columns'
);

select results_eq(
  $$ select id from public.quizzes where id = 'd0000000-0000-0000-0000-000000000003' $$,
  $$ values ('d0000000-0000-0000-0000-000000000003'::uuid) $$,
  'an admin sees a published quiz in an unpublished category'
);

-- Re-spec (#81): the admin now writes quizzes through the API. These were
-- 'an admin cannot insert / update / delete a quiz through the API yet'.

select set_config('test.locks_before', pg_temp.advisory_locks()::text, true);

select lives_ok(
  $$ insert into public.quizzes (category_id, title, description, published)
     values ('c0000000-0000-0000-0000-000000000001', 'Neues Quiz', 'Vom Admin angelegt', false) $$,
  'an admin can insert a quiz with category_id, title, description and published'
);

select results_eq(
  $$ select category_id, title, description, published, sort_order from public.quizzes
     where title = 'Neues Quiz' $$,
  $$ values ('c0000000-0000-0000-0000-000000000001'::uuid, 'Neues Quiz'::text,
             'Vom Admin angelegt'::text, false,
             current_setting('test.next_sort_order')::integer) $$,
  'the admin''s new quiz is stored, with the next sort_order in its category (max + 1)'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  1,
  'inserting a quiz takes a transaction advisory lock for its category'
);

select lives_ok(
  $$ insert into public.quizzes (category_id, title)
     values ('c0000000-0000-0000-0000-000000000001', 'Noch ein Quiz') $$,
  'an admin can insert a quiz with only a category and a title'
);

select results_eq(
  $$ select description, published, sort_order from public.quizzes
     where title = 'Noch ein Quiz' $$,
  $$ values (null::text, false, current_setting('test.next_sort_order')::integer + 1) $$,
  'the next new quiz in that category gets the sort_order after that, unpublished and without a description'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  1,
  'a second insert into the same category takes the same lock, not another one'
);

select lives_ok(
  $$ insert into public.quizzes (category_id, title)
     values ('c0000000-0000-0000-0000-000000000002', 'Quiz im zweiten Thema') $$,
  'an admin can insert a quiz into an unpublished category'
);

select results_eq(
  $$ select sort_order from public.quizzes where title = 'Quiz im zweiten Thema' $$,
  $$ values (2) $$,
  'sort_order counts per category: the other category''s quizzes do not move it'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  2,
  'an insert into another category takes a lock of its own'
);

select lives_ok(
  $$ insert into public.quizzes (category_id, title)
     values ('c0000000-0000-0000-0000-000000000003', 'Erstes Quiz') $$,
  'an admin can insert the first quiz into an empty category'
);

select lives_ok(
  $$ insert into public.quizzes (category_id, title)
     values ('c0000000-0000-0000-0000-000000000003', 'Zweites Quiz') $$,
  'an admin can insert a second quiz into that category'
);

select results_eq(
  $$ select title, sort_order from public.quizzes
     where category_id = 'c0000000-0000-0000-0000-000000000003' order by sort_order $$,
  $$ values ('Erstes Quiz'::text, 1), ('Zweites Quiz'::text, 2) $$,
  'in an empty category the first quiz gets sort_order 1 and the next 2'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order)
     values ('c0000000-0000-0000-0000-000000000001', 'Mit Position', 1) $$,
  '42501', null,
  'an admin cannot choose the sort_order of a new quiz'
);

select throws_ok(
  $$ insert into public.quizzes (id, category_id, title)
     values ('d0000000-0000-0000-0000-0000000000ff', 'c0000000-0000-0000-0000-000000000001', 'Mit Id') $$,
  '42501', null,
  'an admin cannot choose the id of a new quiz'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, created_at)
     values ('c0000000-0000-0000-0000-000000000001', 'Mit Datum', now()) $$,
  '42501', null,
  'an admin cannot choose the created_at of a new quiz'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title) values ('c0000000-0000-0000-0000-000000000001', null) $$,
  '23502', null,
  'an admin cannot insert a quiz without a title'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title) values ('c0000000-0000-0000-0000-000000000001', '') $$,
  '23514', null,
  'an admin cannot insert a quiz with an empty title'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title)
     values ('c0000000-0000-0000-0000-000000000001', E' \t\r\n') $$,
  '23514', null,
  'an admin cannot insert a quiz whose title is only spaces, tabs and line breaks'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title)
     values ('c0000000-0000-0000-0000-0000000000ff', 'Verwaist') $$,
  '23503', null,
  'an admin cannot insert a quiz into a category that does not exist'
);

select is(
  pg_temp.touched_rows($$ update public.quizzes
     set title = 'Bearbeitet', description = 'Neu beschrieben', published = false
     where id = 'd0000000-0000-0000-0000-000000000004' $$),
  1,
  'an admin can update the title, description and published flag of a quiz'
);

select results_eq(
  $$ select title, description, published from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000004' $$,
  $$ values ('Bearbeitet'::text, 'Neu beschrieben'::text, false) $$,
  'the admin reads back the updated title, description and published flag'
);

select is(
  pg_temp.touched_rows($$ update public.quizzes set published = true
     where id = 'd0000000-0000-0000-0000-000000000005' $$),
  1,
  'an admin can publish an unpublished quiz'
);

select is(
  pg_temp.touched_rows($$ update public.quizzes set description = null
     where id = 'd0000000-0000-0000-0000-000000000004' $$),
  1,
  'an admin can clear the description of a quiz'
);

select throws_ok(
  $$ update public.quizzes set category_id = 'c0000000-0000-0000-0000-000000000002'
     where id = 'd0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot move a quiz to another category'
);

select throws_ok(
  $$ update public.quizzes set sort_order = 99
     where id = 'd0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the sort_order of a quiz (reordering is item 6)'
);

select throws_ok(
  $$ update public.quizzes set id = 'd0000000-0000-0000-0000-0000000000fe'
     where id = 'd0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the id of a quiz'
);

select throws_ok(
  $$ update public.quizzes set created_at = now() - interval '1 day'
     where id = 'd0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the created_at of a quiz'
);

select throws_ok(
  $$ update public.quizzes set title = E'\n '
     where id = 'd0000000-0000-0000-0000-000000000004' $$,
  '23514', null,
  'an admin cannot change the title of a quiz to a blank one'
);

select is(
  pg_temp.touched_rows($$ delete from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000006' $$),
  1,
  'an admin can delete a quiz'
);

reset role;

-- Effects of the admin's writes, checked as the owner ---------------------

select results_eq(
  $$ select category_id, title, description, published, sort_order from public.quizzes
     where id = 'd0000000-0000-0000-0000-000000000004' $$,
  $$ values ('c0000000-0000-0000-0000-000000000001'::uuid, 'Bearbeitet'::text, null::text,
             false, 3) $$,
  'the admin''s edits are stored, and the refused writes changed nothing else'
);

select results_eq(
  $$ select published from public.quizzes where id = 'd0000000-0000-0000-0000-000000000005' $$,
  $$ values (true) $$,
  'the admin''s publish is stored'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000006' $$,
  'the admin''s delete removed the quiz'
);

select is_empty(
  $$ select 1 from public.quizzes
     where title in ('Mit Position', 'Mit Id', 'Mit Datum', 'Verwaist')
        or id in ('d0000000-0000-0000-0000-0000000000ff',
                  'd0000000-0000-0000-0000-0000000000fe') $$,
  'the admin''s refused inserts left no row behind'
);

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select title from public.quizzes
     where id in ('d0000000-0000-0000-0000-000000000001',
                  'd0000000-0000-0000-0000-000000000002',
                  'd0000000-0000-0000-0000-000000000003')
     order by id $$,
  $$ values ('Veröffentlichtes Quiz'::text), ('Entwurf'::text),
            ('Quiz im versteckten Thema'::text) $$,
  'the rejected writes left the quizzes unchanged'
);

select * from finish();
rollback;
