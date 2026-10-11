-- public.categories: structure, constraints and access per role (anon,
-- anonymous user, learner, admin). Fixtures are created here as the owner,
-- independent of seed.sql, and vanish on rollback. An admin reads every
-- category, published or not (private.is_admin()); everyone else only the
-- published ones. Only an admin writes categories through the API (#80):
-- insert and update only name, description and published; the database
-- assigns sort_order (max + 1, or 1 in an empty table), and id and
-- created_at are never writable. A learner's or an anonymous user's update
-- or delete passes the grant but RLS lets it touch no row, so those tests
-- target a published row the role can see and check afterwards, as the
-- owner, that it is unchanged. anon has no write grant at all.
begin;
select plan(78);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, description, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 'Veröffentlicht', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Verstecktes Thema', null, 2, false),
  -- Only for the admin's writes, so the read tests keep their fixtures.
  ('c0000000-0000-0000-0000-000000000003', 'Zum Bearbeiten', 'Alt', 3, true),
  ('c0000000-0000-0000-0000-000000000004', 'Zum Veröffentlichen', null, 4, false),
  ('c0000000-0000-0000-0000-000000000005', 'Zum Löschen', null, 5, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Quiz im sichtbaren Thema', 1, true);

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

-- Structure ---------------------------------------------------------------

select has_table('public', 'categories', 'categories table exists');

select columns_are('public', 'categories',
  array['id', 'name', 'description', 'sort_order', 'published', 'created_at'],
  'categories has exactly the planned columns');

select col_is_pk('public', 'categories', 'id', 'categories.id is the primary key');
select col_type_is('public', 'categories', 'id', 'uuid', 'categories.id is a uuid');
select col_has_default('public', 'categories', 'id', 'categories.id has a default');

select col_type_is('public', 'categories', 'name', 'text', 'categories.name is text');
select col_not_null('public', 'categories', 'name', 'categories.name is required');

select col_type_is('public', 'categories', 'description', 'text',
  'categories.description is text');
select col_is_null('public', 'categories', 'description',
  'categories.description is optional');

select col_type_is('public', 'categories', 'sort_order', 'integer',
  'categories.sort_order is an integer');
select col_not_null('public', 'categories', 'sort_order',
  'categories.sort_order is required');

select col_type_is('public', 'categories', 'published', 'boolean',
  'categories.published is a boolean');
select col_not_null('public', 'categories', 'published',
  'categories.published is required');

select col_type_is('public', 'categories', 'created_at', 'timestamp with time zone',
  'categories.created_at is a timestamptz');
select col_not_null('public', 'categories', 'created_at',
  'categories.created_at is required');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.categories'::regclass),
  'categories has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

insert into public.categories (name, sort_order) values ('Nur Pflichtfelder', 9);

select results_eq(
  $$ select id is not null, published, created_at = now()
     from public.categories where name = 'Nur Pflichtfelder' $$,
  $$ values (true, false, true) $$,
  'a new category gets an id, published = false and created_at = now() by default'
);

select throws_ok(
  $$ insert into public.categories (name, sort_order) values (null, 1) $$,
  '23502', null,
  'a category without a name is rejected'
);

select throws_ok(
  $$ insert into public.categories (name, sort_order) values (E' \t ', 1) $$,
  '23514', null,
  'a category with a blank name is rejected'
);

delete from public.categories where id = 'c0000000-0000-0000-0000-000000000001';

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  'deleting a category deletes its quizzes'
);

-- Restore the deleted fixture for the role tests.
insert into public.categories (id, name, description, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 'Veröffentlicht', 1, true);


-- Grants and policies (catalog) -------------------------------------------

select ok(
  not has_table_privilege('anon', 'public.categories', 'INSERT, UPDATE, DELETE'),
  'anon has no write privilege on categories'
);

select results_eq(
  $$ select c.column_name::text collate "default",
            has_column_privilege('authenticated', 'public.categories', c.column_name, 'INSERT'),
            has_column_privilege('authenticated', 'public.categories', c.column_name, 'UPDATE')
     from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'categories'
     order by c.column_name $$,
  $$ values ('created_at'::text, false, false),
            ('description'::text, true, true),
            ('id'::text, false, false),
            ('name'::text, true, true),
            ('published'::text, true, true),
            ('sort_order'::text, false, false) $$,
  'authenticated may insert and update only name, description and published'
);

select ok(
  has_table_privilege('authenticated', 'public.categories', 'DELETE'),
  'authenticated may delete categories (RLS decides which)'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'categories'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and roles <> '{authenticated}'::name[] $$,
  'every write policy on categories applies to authenticated only'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'categories'
       and cmd in ('UPDATE', 'ALL')
       and (qual is null or with_check is null) $$,
  'every update policy on categories has both using and with check'
);

-- One policy per command or a single `for all` policy: either shape gates
-- every write, and the role tests below decide what the policies allow.
select set_eq(
  $$ select w.cmd from (values ('INSERT'), ('UPDATE'), ('DELETE')) as w(cmd)
     where exists (
       select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = 'categories'
         and p.cmd in (w.cmd, 'ALL')) $$,
  $$ values ('INSERT'), ('UPDATE'), ('DELETE') $$,
  'categories has a policy for each write: insert, update and delete (or one for all)'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select id, name, description, sort_order, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  $$ values ('c0000000-0000-0000-0000-000000000001'::uuid, 'Sichtbares Thema'::text,
             'Veröffentlicht'::text, 1, true) $$,
  'anon sees a published category with all its columns'
);

select is_empty(
  $$ select 1 from public.categories where not published $$,
  'anon does not see unpublished categories'
);

select throws_like(
  $$ insert into public.categories (name, description, published)
     values ('Neu', null, true) $$,
  '%permission denied%',
  'anon cannot insert a category (no grant)'
);

select throws_like(
  $$ update public.categories set name = 'Geändert'
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '%permission denied%',
  'anon cannot update a category (no grant)'
);

select throws_like(
  $$ delete from public.categories where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '%permission denied%',
  'anon cannot delete a category (no grant)'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id from public.categories
     where id in ('c0000000-0000-0000-0000-000000000001',
                  'c0000000-0000-0000-0000-000000000002') $$,
  $$ values ('c0000000-0000-0000-0000-000000000001'::uuid) $$,
  'an anonymous user sees a published category'
);

select is_empty(
  $$ select 1 from public.categories where not published $$,
  'an anonymous user does not see unpublished categories'
);

select throws_like(
  $$ insert into public.categories (name, description, published)
     values ('Von Anonym', null, true) $$,
  '%row-level security%',
  'an anonymous user cannot insert a category (RLS)'
);

select is(
  pg_temp.touched_rows($$ update public.categories set name = 'Von Anonym geändert', published = false
     where id = 'c0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s update of a visible published category touches no row, without an error'
);

select is(
  pg_temp.touched_rows($$ delete from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s delete of a visible published category touches no row, without an error'
);

reset role;

select results_eq(
  $$ select name, description, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Sichtbares Thema'::text, 'Veröffentlicht'::text, true) $$,
  'after the anonymous user''s writes the published category is still there, unchanged'
);

select is_empty(
  $$ select 1 from public.categories where name = 'Von Anonym' $$,
  'the anonymous user''s insert left no row behind'
);

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id, name, description, sort_order, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  $$ values ('c0000000-0000-0000-0000-000000000001'::uuid, 'Sichtbares Thema'::text,
             'Veröffentlicht'::text, 1, true) $$,
  'a learner sees a published category with all its columns'
);

select is_empty(
  $$ select 1 from public.categories where not published $$,
  'a learner does not see unpublished categories'
);

select throws_like(
  $$ insert into public.categories (name, description, published)
     values ('Vom Lerner', null, true) $$,
  '%row-level security%',
  'a learner cannot insert a category (RLS)'
);

select is(
  pg_temp.touched_rows($$ update public.categories set name = 'Vom Lerner geändert', published = false
     where id = 'c0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner''s update of a visible published category touches no row, without an error'
);

select is(
  pg_temp.touched_rows($$ delete from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner''s delete of a visible published category touches no row, without an error'
);

reset role;

select results_eq(
  $$ select name, description, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Sichtbares Thema'::text, 'Veröffentlicht'::text, true) $$,
  'after the learner''s writes the published category is still there, unchanged'
);

select is_empty(
  $$ select 1 from public.categories where name = 'Vom Lerner' $$,
  'the learner''s insert left no row behind'
);

-- admin (carol): reads ----------------------------------------------------

-- Every category id as the owner sees it, for the admin to match.
select set_config('test.all_category_ids',
  (select string_agg(id::text, ',') from public.categories), true);
-- The next sort_order the database must assign while the table has rows.
select set_config('test.next_sort_order',
  (select (max(sort_order) + 1)::text from public.categories), true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, name, description, sort_order, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  $$ values ('c0000000-0000-0000-0000-000000000001'::uuid, 'Sichtbares Thema'::text,
             'Veröffentlicht'::text, 1, true) $$,
  'an admin sees a published category'
);

select results_eq(
  $$ select id, name, description, sort_order, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000002' $$,
  $$ values ('c0000000-0000-0000-0000-000000000002'::uuid, 'Verstecktes Thema'::text,
             null::text, 2, false) $$,
  'an admin sees an unpublished category with all its columns'
);

select set_eq(
  $$ select id from public.categories $$,
  $$ select unnest(string_to_array(current_setting('test.all_category_ids'), ',')::uuid[]) $$,
  'an admin sees every category, published or not'
);

-- admin (carol): insert ---------------------------------------------------

select lives_ok(
  $$ insert into public.categories (name, description, published)
     values ('Neues Thema', 'Vom Admin angelegt', false) $$,
  'an admin can insert a category with name, description and published'
);

select results_eq(
  $$ select name, description, published, sort_order from public.categories
     where name = 'Neues Thema' $$,
  $$ values ('Neues Thema'::text, 'Vom Admin angelegt'::text, false,
             current_setting('test.next_sort_order')::integer) $$,
  'the admin''s new category is stored, with the next sort_order (max + 1)'
);

select lives_ok(
  $$ insert into public.categories (name) values ('Noch ein Thema') $$,
  'an admin can insert a category with only a name'
);

select results_eq(
  $$ select description, published, sort_order from public.categories
     where name = 'Noch ein Thema' $$,
  $$ values (null::text, false, current_setting('test.next_sort_order')::integer + 1) $$,
  'the next new category gets the sort_order after that, unpublished and without a description'
);

select throws_ok(
  $$ insert into public.categories (name, sort_order) values ('Mit Position', 1) $$,
  '42501', null,
  'an admin cannot choose the sort_order of a new category'
);

select throws_ok(
  $$ insert into public.categories (id, name)
     values ('c0000000-0000-0000-0000-0000000000ff', 'Mit Id') $$,
  '42501', null,
  'an admin cannot choose the id of a new category'
);

select throws_ok(
  $$ insert into public.categories (name, created_at) values ('Mit Datum', now()) $$,
  '42501', null,
  'an admin cannot choose the created_at of a new category'
);

select throws_ok(
  $$ insert into public.categories (name) values (null) $$,
  '23502', null,
  'an admin cannot insert a category without a name'
);

select throws_ok(
  $$ insert into public.categories (name) values ('') $$,
  '23514', null,
  'an admin cannot insert a category with an empty name'
);

select throws_ok(
  $$ insert into public.categories (name) values ('   ') $$,
  '23514', null,
  'an admin cannot insert a category whose name is only spaces'
);

select throws_ok(
  $$ insert into public.categories (name) values (E'\t\r\n') $$,
  '23514', null,
  'an admin cannot insert a category whose name is only tabs and line breaks'
);

-- admin (carol): update ---------------------------------------------------

select is(
  pg_temp.touched_rows($$ update public.categories
     set name = 'Bearbeitet', description = 'Neu beschrieben', published = false
     where id = 'c0000000-0000-0000-0000-000000000003' $$),
  1,
  'an admin can update the name, description and published flag of a category'
);

select results_eq(
  $$ select name, description, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  $$ values ('Bearbeitet'::text, 'Neu beschrieben'::text, false) $$,
  'the admin reads back the updated name, description and published flag'
);

select is(
  pg_temp.touched_rows($$ update public.categories set published = true
     where id = 'c0000000-0000-0000-0000-000000000004' $$),
  1,
  'an admin can publish an unpublished category'
);

select is(
  pg_temp.touched_rows($$ update public.categories set description = null
     where id = 'c0000000-0000-0000-0000-000000000003' $$),
  1,
  'an admin can clear the description of a category'
);

select throws_ok(
  $$ update public.categories set sort_order = 99
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  '42501', null,
  'an admin cannot change the sort_order of a category (reordering is item 6)'
);

select throws_ok(
  $$ update public.categories set id = 'c0000000-0000-0000-0000-0000000000fe'
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  '42501', null,
  'an admin cannot change the id of a category'
);

select throws_ok(
  $$ update public.categories set created_at = now() - interval '1 day'
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  '42501', null,
  'an admin cannot change the created_at of a category'
);

select throws_ok(
  $$ update public.categories set name = null
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23502', null,
  'an admin cannot remove the name of a category'
);

select throws_ok(
  $$ update public.categories set name = ''
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null,
  'an admin cannot rename a category to an empty name'
);

select throws_ok(
  $$ update public.categories set name = '   '
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null,
  'an admin cannot rename a category to only spaces'
);

select throws_ok(
  $$ update public.categories set name = E'\t\r\n'
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null,
  'an admin cannot rename a category to only tabs and line breaks'
);

-- admin (carol): delete ---------------------------------------------------

select is(
  pg_temp.touched_rows($$ delete from public.categories
     where id = 'c0000000-0000-0000-0000-000000000005' $$),
  1,
  'an admin can delete a category'
);

reset role;

-- Effects of the admin's writes, checked as the owner -------------------------

select results_eq(
  $$ select name, description, published, sort_order from public.categories
     where id = 'c0000000-0000-0000-0000-000000000003' $$,
  $$ values ('Bearbeitet'::text, null::text, false, 3) $$,
  'the admin''s edits are stored, and the failed writes changed nothing else'
);

select results_eq(
  $$ select published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000004' $$,
  $$ values (true) $$,
  'the admin''s publish is stored'
);

select is_empty(
  $$ select 1 from public.categories where id = 'c0000000-0000-0000-0000-000000000005' $$,
  'the admin''s delete removed the category'
);

select is_empty(
  $$ select 1 from public.categories
     where name in ('Mit Position', 'Mit Id', 'Mit Datum')
        or id in ('c0000000-0000-0000-0000-0000000000ff',
                  'c0000000-0000-0000-0000-0000000000fe') $$,
  'the admin''s rejected inserts left no row behind'
);

-- sort_order in an empty table ---------------------------------------------

delete from public.categories;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ insert into public.categories (name) values ('Erstes Thema') $$,
  'an admin can insert the first category into an empty table'
);

select lives_ok(
  $$ insert into public.categories (name) values ('Zweites Thema') $$,
  'an admin can insert a second category after it'
);

select results_eq(
  $$ select name, sort_order from public.categories order by sort_order $$,
  $$ values ('Erstes Thema'::text, 1), ('Zweites Thema'::text, 2) $$,
  'in an empty table the first category gets sort_order 1 and the next 2'
);

reset role;

select * from finish();
rollback;
