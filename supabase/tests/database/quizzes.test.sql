-- public.quizzes: structure, constraints and access per role (anon,
-- anonymous user, learner, admin). For everyone but an admin a quiz is
-- visible only if it and its category are published; an admin reads every
-- quiz (private.is_admin()). Fixtures are created here as the owner,
-- independent of seed.sql, and vanish on rollback. Nobody writes through the
-- API yet (phase 2 items 2 to 5).
begin;
select plan(48);

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

reset role;

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

select throws_ok(
  $$ update public.quizzes set title = 'Geändert'
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot update a quiz'
);

select throws_ok(
  $$ delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot delete a quiz'
);

reset role;

-- admin (carol) -----------------------------------------------------------

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

select throws_ok(
  $$ insert into public.quizzes (category_id, title, sort_order, published)
     values ('c0000000-0000-0000-0000-000000000001', 'Neu', 3, true) $$,
  '42501', null,
  'an admin cannot insert a quiz through the API yet'
);

select throws_ok(
  $$ update public.quizzes set title = 'Geändert'
     where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot update a quiz through the API yet'
);

select throws_ok(
  $$ delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot delete a quiz through the API yet'
);

reset role;

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
