-- public.answers: structure, constraints and access per role (anon,
-- anonymous user, learner, admin). For everyone but an admin an answer is
-- visible only if its question's quiz is visible (the quiz and its category
-- are published); an admin reads every answer (private.is_admin()).
-- `is_correct` is the solution: no API role may select it, not even an admin
-- (this slice grants row visibility only; the editor slices decide how an
-- admin reads it), only submit_answer() evaluates it. Fixtures are created
-- here as the owner, independent of seed.sql, and vanish on rollback.
begin;
select plan(66);

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

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlichtes Quiz', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 2, false),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000002',
   'Quiz im versteckten Thema', 1, true);

insert into public.questions (id, quiz_id, text, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', 1),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   'Frage im Entwurf?', 1),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003',
   'Frage im versteckten Thema?', 1);

insert into public.answers
  (id, question_id, text, image_path, image_alt, is_correct, sort_order) values
  -- of a question in a visible quiz: visible
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Blau', 'antworten/blau.png', 'Eine blaue Fläche', true, 1),
  -- of a question in an unpublished quiz: hidden
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002',
   'Antwort im Entwurf', null, null, true, 1),
  -- of a question in a published quiz of an unpublished category: hidden
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003',
   'Antwort im versteckten Thema', null, null, true, 1);

-- Structure ---------------------------------------------------------------

select has_table('public', 'answers', 'answers table exists');

select columns_are('public', 'answers',
  array['id', 'question_id', 'text', 'image_path', 'image_alt', 'is_correct',
        'sort_order', 'created_at'],
  'answers has exactly the planned columns');

select col_is_pk('public', 'answers', 'id', 'answers.id is the primary key');
select col_type_is('public', 'answers', 'id', 'uuid', 'answers.id is a uuid');
select col_has_default('public', 'answers', 'id', 'answers.id has a default');

select col_type_is('public', 'answers', 'question_id', 'uuid',
  'answers.question_id is a uuid');
select col_not_null('public', 'answers', 'question_id', 'answers.question_id is required');
select fk_ok('public', 'answers', 'question_id', 'public', 'questions', 'id',
  'answers.question_id references questions.id');

select col_type_is('public', 'answers', 'text', 'text', 'answers.text is text');
select col_not_null('public', 'answers', 'text', 'answers.text is required');

select col_type_is('public', 'answers', 'image_path', 'text', 'answers.image_path is text');
select col_is_null('public', 'answers', 'image_path', 'answers.image_path is optional');

select col_type_is('public', 'answers', 'image_alt', 'text', 'answers.image_alt is text');
select col_is_null('public', 'answers', 'image_alt',
  'answers.image_alt is optional without an image');

select col_type_is('public', 'answers', 'is_correct', 'boolean',
  'answers.is_correct is a boolean');
select col_not_null('public', 'answers', 'is_correct', 'answers.is_correct is required');

select col_type_is('public', 'answers', 'sort_order', 'integer',
  'answers.sort_order is an integer');
select col_not_null('public', 'answers', 'sort_order', 'answers.sort_order is required');

select col_type_is('public', 'answers', 'created_at', 'timestamp with time zone',
  'answers.created_at is a timestamptz');
select col_not_null('public', 'answers', 'created_at', 'answers.created_at is required');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.answers'::regclass
      and a.attname = 'question_id'
  ),
  'an index leads with answers.question_id'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.answers'::regclass),
  'answers has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

insert into public.answers (question_id, text, sort_order)
values ('e0000000-0000-0000-0000-000000000001', 'Nur Pflichtfelder', 9);

select results_eq(
  $$ select id is not null, is_correct, created_at = now()
     from public.answers where text = 'Nur Pflichtfelder' $$,
  $$ values (true, false, true) $$,
  'a new answer gets an id, is_correct = false and created_at = now() by default'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', null, 1) $$,
  '23502', null,
  'an answer without a text is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', ' ', 1) $$,
  '23514', null,
  'an answer with a blank text is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values (null, 'Ohne Frage', 1) $$,
  '23502', null,
  'an answer without a question is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-0000000000ff', 'Verwaist', 1) $$,
  '23503', null,
  'an answer to a question that does not exist is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, image_path, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Bild ohne Alt', 'antworten/x.png', 1) $$,
  '23514', null,
  'an answer with an image but no image_alt is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, image_path, image_alt, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Bild mit leerem Alt',
             'antworten/x.png', E'\t', 1) $$,
  '23514', null,
  'an answer with an image and a blank image_alt is rejected'
);

select lives_ok(
  $$ insert into public.answers (question_id, text, image_path, image_alt, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Bild mit Alt',
             'antworten/y.png', 'Ein Kreis', 1) $$,
  'an answer with an image and an image_alt is accepted'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select id, question_id, text, image_path, image_alt, sort_order,
            created_at is not null
     from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             'Blau'::text, 'antworten/blau.png'::text, 'Eine blaue Fläche'::text, 1, true) $$,
  'anon sees an answer of a visible quiz with every column except is_correct'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'anon does not see an answer of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  'anon does not see an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'anon cannot select answers.is_correct'
);

select throws_ok(
  $$ select * from public.answers $$,
  '42501', null,
  'anon cannot select * from answers (it includes is_correct)'
);

select throws_ok(
  $$ select id from public.answers where is_correct $$,
  '42501', null,
  'anon cannot filter answers on is_correct'
);

select throws_ok(
  $$ select to_jsonb(a) from public.answers a $$,
  '42501', null,
  'anon cannot read is_correct through a whole-row reference'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Neu', 3) $$,
  '42501', null,
  'anon cannot insert an answer'
);

select throws_ok(
  $$ update public.answers set text = 'Geändert'
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot update an answer'
);

select throws_ok(
  $$ delete from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete an answer'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'an anonymous user sees an answer of a visible quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'an anonymous user does not see an answer of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  'an anonymous user does not see an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'an anonymous user cannot select answers.is_correct'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id, question_id, text, image_path, image_alt, sort_order,
            created_at is not null
     from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             'Blau'::text, 'antworten/blau.png'::text, 'Eine blaue Fläche'::text, 1, true) $$,
  'a learner sees an answer of a visible quiz with every column except is_correct'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'a learner does not see an answer of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  'a learner does not see an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'a learner cannot select answers.is_correct'
);

select throws_ok(
  $$ select * from public.answers $$,
  '42501', null,
  'a learner cannot select * from answers (it includes is_correct)'
);

select throws_ok(
  $$ select id from public.answers where is_correct $$,
  '42501', null,
  'a learner cannot filter answers on is_correct'
);

select throws_ok(
  $$ select to_jsonb(a) from public.answers a $$,
  '42501', null,
  'a learner cannot read is_correct through a whole-row reference'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Neu', 3) $$,
  '42501', null,
  'a learner cannot insert an answer'
);

select throws_ok(
  $$ update public.answers set text = 'Geändert'
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot update an answer'
);

select throws_ok(
  $$ delete from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot delete an answer'
);

reset role;

-- admin (carol) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, question_id, text, image_path, image_alt, sort_order,
            created_at is not null
     from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             'Blau'::text, 'antworten/blau.png'::text, 'Eine blaue Fläche'::text, 1, true) $$,
  'an admin sees an answer of a visible quiz without is_correct'
);

select results_eq(
  $$ select id, question_id, text, sort_order
     from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  $$ values ('a0000000-0000-0000-0000-000000000002'::uuid,
             'e0000000-0000-0000-0000-000000000002'::uuid,
             'Antwort im Entwurf'::text, 1) $$,
  'an admin sees an answer of an unpublished quiz'
);

select results_eq(
  $$ select id from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  $$ values ('a0000000-0000-0000-0000-000000000003'::uuid) $$,
  'an admin sees an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'an admin still cannot select answers.is_correct'
);

select throws_ok(
  $$ select is_correct from public.answers
     where id = 'a0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'an admin cannot select is_correct of an answer in an unpublished quiz either'
);

select throws_ok(
  $$ select * from public.answers $$,
  '42501', null,
  'an admin still cannot select * from answers'
);

select throws_ok(
  $$ select id from public.answers where is_correct $$,
  '42501', null,
  'an admin still cannot filter answers on is_correct'
);

select throws_ok(
  $$ select to_jsonb(a) from public.answers a $$,
  '42501', null,
  'an admin still cannot read is_correct through a whole-row reference'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Neu', 3) $$,
  '42501', null,
  'an admin cannot insert an answer through the API yet'
);

select throws_ok(
  $$ update public.answers set text = 'Geändert'
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot update an answer through the API yet'
);

select throws_ok(
  $$ delete from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot delete an answer through the API yet'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select text, is_correct from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Blau'::text, true) $$,
  'the rejected writes left the answer unchanged'
);

select * from finish();
rollback;
