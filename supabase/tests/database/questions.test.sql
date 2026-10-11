-- public.questions: structure, constraints and access per role (anon,
-- anonymous user, learner, admin). For everyone but an admin a question is
-- visible only if its quiz is visible (the quiz and its category are
-- published); an admin reads every question (private.is_admin()).
-- `explanation` is part of the solution: no API role may select it, not even
-- an admin (this slice grants row visibility only; the editor slices decide
-- how an admin reads it), only submit_answer() returns it. Fixtures are
-- created here as the owner, independent of seed.sql, and vanish on rollback.
begin;
select plan(69);

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

insert into public.questions
  (id, quiz_id, text, image_path, image_alt, multiple_correct, explanation, sort_order) values
  -- in a visible quiz: visible
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', 'fragen/himmel.png', 'Ein blauer Himmel', true,
   'Wegen der Rayleigh-Streuung.', 1),
  -- in an unpublished quiz: hidden
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   'Frage im Entwurf?', null, null, false, 'Geheim.', 1),
  -- in a published quiz of an unpublished category: hidden
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003',
   'Frage im versteckten Thema?', null, null, false, 'Geheim.', 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Blau', true, 1);

-- Structure ---------------------------------------------------------------

select has_table('public', 'questions', 'questions table exists');

select columns_are('public', 'questions',
  array['id', 'quiz_id', 'text', 'image_path', 'image_alt', 'multiple_correct',
        'explanation', 'sort_order', 'created_at'],
  'questions has exactly the planned columns');

select col_is_pk('public', 'questions', 'id', 'questions.id is the primary key');
select col_type_is('public', 'questions', 'id', 'uuid', 'questions.id is a uuid');
select col_has_default('public', 'questions', 'id', 'questions.id has a default');

select col_type_is('public', 'questions', 'quiz_id', 'uuid', 'questions.quiz_id is a uuid');
select col_not_null('public', 'questions', 'quiz_id', 'questions.quiz_id is required');
select fk_ok('public', 'questions', 'quiz_id', 'public', 'quizzes', 'id',
  'questions.quiz_id references quizzes.id');

select col_type_is('public', 'questions', 'text', 'text', 'questions.text is text');
select col_not_null('public', 'questions', 'text', 'questions.text is required');

select col_type_is('public', 'questions', 'image_path', 'text', 'questions.image_path is text');
select col_is_null('public', 'questions', 'image_path', 'questions.image_path is optional');

select col_type_is('public', 'questions', 'image_alt', 'text', 'questions.image_alt is text');
select col_is_null('public', 'questions', 'image_alt',
  'questions.image_alt is optional without an image');

select col_type_is('public', 'questions', 'multiple_correct', 'boolean',
  'questions.multiple_correct is a boolean');
select col_not_null('public', 'questions', 'multiple_correct',
  'questions.multiple_correct is required');

select col_type_is('public', 'questions', 'explanation', 'text',
  'questions.explanation is text');
select col_is_null('public', 'questions', 'explanation', 'questions.explanation is optional');

select col_type_is('public', 'questions', 'sort_order', 'integer',
  'questions.sort_order is an integer');
select col_not_null('public', 'questions', 'sort_order', 'questions.sort_order is required');

select col_type_is('public', 'questions', 'created_at', 'timestamp with time zone',
  'questions.created_at is a timestamptz');
select col_not_null('public', 'questions', 'created_at', 'questions.created_at is required');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.questions'::regclass
      and a.attname = 'quiz_id'
  ),
  'an index leads with questions.quiz_id'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.questions'::regclass),
  'questions has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

insert into public.questions (quiz_id, text, sort_order)
values ('d0000000-0000-0000-0000-000000000001', 'Nur Pflichtfelder?', 9);

select results_eq(
  $$ select id is not null, multiple_correct, created_at = now()
     from public.questions where text = 'Nur Pflichtfelder?' $$,
  $$ values (true, false, true) $$,
  'a new question gets an id, multiple_correct = false and created_at = now() by default'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', null, 1) $$,
  '23502', null,
  'a question without a text is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', E'\n  ', 1) $$,
  '23514', null,
  'a question with a blank text is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values (null, 'Ohne Quiz?', 1) $$,
  '23502', null,
  'a question without a quiz is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-0000000000ff', 'Verwaist?', 1) $$,
  '23503', null,
  'a question in a quiz that does not exist is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, image_path, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Bild ohne Alt?', 'fragen/x.png', 1) $$,
  '23514', null,
  'a question with an image but no image_alt is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, image_path, image_alt, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Bild mit leerem Alt?',
             'fragen/x.png', '  ', 1) $$,
  '23514', null,
  'a question with an image and a blank image_alt is rejected'
);

select lives_ok(
  $$ insert into public.questions (quiz_id, text, image_path, image_alt, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Bild mit Alt?',
             'fragen/y.png', 'Ein Diagramm', 1) $$,
  'a question with an image and an image_alt is accepted'
);

delete from public.questions where id = 'e0000000-0000-0000-0000-000000000001';

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  'deleting a question deletes its answers'
);

-- Restore the deleted fixture for the role tests.
insert into public.questions
  (id, quiz_id, text, image_path, image_alt, multiple_correct, explanation, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', 'fragen/himmel.png', 'Ein blauer Himmel', true,
   'Wegen der Rayleigh-Streuung.', 1);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select id, quiz_id, text, image_path, image_alt, multiple_correct, sort_order,
            created_at is not null
     from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid,
             'Welche Farbe hat der Himmel?'::text, 'fragen/himmel.png'::text,
             'Ein blauer Himmel'::text, true, 1, true) $$,
  'anon sees a question of a visible quiz with every column except explanation'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  'anon does not see a question of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  'anon does not see a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'anon cannot select questions.explanation'
);

select throws_ok(
  $$ select * from public.questions $$,
  '42501', null,
  'anon cannot select * from questions (it includes explanation)'
);

select throws_ok(
  $$ select id from public.questions where explanation is not null $$,
  '42501', null,
  'anon cannot filter questions on explanation'
);

select throws_ok(
  $$ select to_jsonb(q) from public.questions q $$,
  '42501', null,
  'anon cannot read explanation through a whole-row reference'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Neu?', 3) $$,
  '42501', null,
  'anon cannot insert a question'
);

select throws_ok(
  $$ update public.questions set text = 'Geändert?'
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot update a question'
);

select throws_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete a question'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid) $$,
  'an anonymous user sees a question of a visible quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  'an anonymous user does not see a question of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  'an anonymous user does not see a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'an anonymous user cannot select questions.explanation'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id, quiz_id, text, image_path, image_alt, multiple_correct, sort_order,
            created_at is not null
     from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid,
             'Welche Farbe hat der Himmel?'::text, 'fragen/himmel.png'::text,
             'Ein blauer Himmel'::text, true, 1, true) $$,
  'a learner sees a question of a visible quiz with every column except explanation'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  'a learner does not see a question of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  'a learner does not see a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'a learner cannot select questions.explanation'
);

select throws_ok(
  $$ select * from public.questions $$,
  '42501', null,
  'a learner cannot select * from questions (it includes explanation)'
);

select throws_ok(
  $$ select id from public.questions where explanation is not null $$,
  '42501', null,
  'a learner cannot filter questions on explanation'
);

select throws_ok(
  $$ select to_jsonb(q) from public.questions q $$,
  '42501', null,
  'a learner cannot read explanation through a whole-row reference'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Neu?', 3) $$,
  '42501', null,
  'a learner cannot insert a question'
);

select throws_ok(
  $$ update public.questions set text = 'Geändert?'
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot update a question'
);

select throws_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot delete a question'
);

reset role;

-- admin (carol) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, quiz_id, text, image_path, image_alt, multiple_correct, sort_order,
            created_at is not null
     from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid,
             'Welche Farbe hat der Himmel?'::text, 'fragen/himmel.png'::text,
             'Ein blauer Himmel'::text, true, 1, true) $$,
  'an admin sees a question of a visible quiz without explanation'
);

select results_eq(
  $$ select id, quiz_id, text, multiple_correct, sort_order
     from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  $$ values ('e0000000-0000-0000-0000-000000000002'::uuid,
             'd0000000-0000-0000-0000-000000000002'::uuid,
             'Frage im Entwurf?'::text, false, 1) $$,
  'an admin sees a question of an unpublished quiz'
);

select results_eq(
  $$ select id from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  $$ values ('e0000000-0000-0000-0000-000000000003'::uuid) $$,
  'an admin sees a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'an admin still cannot select questions.explanation'
);

select throws_ok(
  $$ select explanation from public.questions
     where id = 'e0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'an admin cannot select the explanation of a question in an unpublished quiz either'
);

select throws_ok(
  $$ select * from public.questions $$,
  '42501', null,
  'an admin still cannot select * from questions'
);

select throws_ok(
  $$ select id from public.questions where explanation is not null $$,
  '42501', null,
  'an admin still cannot filter questions on explanation'
);

select throws_ok(
  $$ select to_jsonb(q) from public.questions q $$,
  '42501', null,
  'an admin still cannot read explanation through a whole-row reference'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Neu?', 3) $$,
  '42501', null,
  'an admin cannot insert a question through the API yet'
);

select throws_ok(
  $$ update public.questions set text = 'Geändert?'
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot update a question through the API yet'
);

select throws_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot delete a question through the API yet'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select text, explanation from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Welche Farbe hat der Himmel?'::text, 'Wegen der Rayleigh-Streuung.'::text) $$,
  'the rejected writes left the question unchanged'
);

select * from finish();
rollback;
