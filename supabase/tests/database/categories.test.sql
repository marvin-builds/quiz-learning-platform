-- public.categories: structure, constraints and access per role (anon,
-- learner, admin). Fixtures are created here as the owner, independent of
-- seed.sql, and vanish on rollback. In phase 1 an admin is treated like a
-- learner; phase 2 changes the admin tests on purpose.
begin;
select plan(36);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, description, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 'Veröffentlicht', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Verstecktes Thema', null, 2, false);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Quiz im sichtbaren Thema', 1, true);

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

select throws_ok(
  $$ insert into public.categories (name, sort_order, published) values ('Neu', 3, true) $$,
  '42501', null,
  'anon cannot insert a category'
);

select throws_ok(
  $$ update public.categories set name = 'Geändert'
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot update a category'
);

select throws_ok(
  $$ delete from public.categories where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete a category'
);

reset role;

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

select throws_ok(
  $$ insert into public.categories (name, sort_order, published) values ('Neu', 3, true) $$,
  '42501', null,
  'a learner cannot insert a category'
);

select throws_ok(
  $$ update public.categories set name = 'Geändert'
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot update a category'
);

select throws_ok(
  $$ delete from public.categories where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot delete a category'
);

reset role;

-- admin (carol), treated like a learner in phase 1 ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, name, description, sort_order, published from public.categories
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  $$ values ('c0000000-0000-0000-0000-000000000001'::uuid, 'Sichtbares Thema'::text,
             'Veröffentlicht'::text, 1, true) $$,
  'an admin sees a published category in phase 1'
);

select is_empty(
  $$ select 1 from public.categories where not published $$,
  'an admin does not see unpublished categories in phase 1'
);

select throws_ok(
  $$ insert into public.categories (name, sort_order, published) values ('Neu', 3, true) $$,
  '42501', null,
  'an admin cannot insert a category in phase 1'
);

select throws_ok(
  $$ update public.categories set name = 'Geändert'
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot update a category in phase 1'
);

select throws_ok(
  $$ delete from public.categories where id = 'c0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot delete a category in phase 1'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select name, published from public.categories
     where id in ('c0000000-0000-0000-0000-000000000001',
                  'c0000000-0000-0000-0000-000000000002')
     order by sort_order $$,
  $$ values ('Sichtbares Thema'::text, true), ('Verstecktes Thema'::text, false) $$,
  'the rejected writes left the categories unchanged'
);

select * from finish();
rollback;
