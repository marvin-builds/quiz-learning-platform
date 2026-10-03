-- public.attempt_answers: structure, constraints, cascades and access per role
-- (anon, anonymous user, learner, admin). One row per question of an attempt,
-- written only by submit_answer(), never directly by an API role. A user reads
-- the answers of their own attempts and nobody else's. is_correct here is the
-- scored result of the user's own, already submitted answer, not the answer
-- key in answers.is_correct. Fixtures are created here as the owner,
-- independent of seed.sql, and vanish on rollback. In phase 1 an admin is
-- treated like a learner; phase 2 changes the admin tests on purpose.
begin;
select plan(49);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'dave@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlichtes Quiz', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Quiz, das gelöscht wird', 2, true);

insert into public.questions (id, quiz_id, text, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', 1),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat Gras?', 2),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002',
   'Frage im Quiz, das gelöscht wird?', 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Blau', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Rot', false, 2),
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002',
   'Grün', true, 1),
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000003',
   'Ja', true, 1);

insert into public.attempts (id, user_id, quiz_id, score, max_score) values
  ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000001', 1, 2),
  ('f0000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'd0000000-0000-0000-0000-000000000001', 0, 2),
  ('f0000000-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333',
   'd0000000-0000-0000-0000-000000000001', 1, 2),
  ('f0000000-0000-0000-0000-000000000004', '44444444-4444-4444-4444-444444444444',
   'd0000000-0000-0000-0000-000000000001', 1, 2),
  -- Dave's attempts are only for the cascade checks.
  ('f0000000-0000-0000-0000-000000000005', '55555555-5555-5555-5555-555555555555',
   'd0000000-0000-0000-0000-000000000002', 1, 1),
  ('f0000000-0000-0000-0000-000000000006', '55555555-5555-5555-5555-555555555555',
   'd0000000-0000-0000-0000-000000000001', 1, 2),
  ('f0000000-0000-0000-0000-000000000007', '55555555-5555-5555-5555-555555555555',
   'd0000000-0000-0000-0000-000000000001', 1, 2);

insert into public.attempt_answers
  (attempt_id, question_id, selected_answer_ids, is_correct, points) values
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000002}', false, 0),
  ('f0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000003',
   '{a0000000-0000-0000-0000-000000000004}', true, 1),
  ('f0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000002',
   '{a0000000-0000-0000-0000-000000000003}', true, 1),
  ('f0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1);

-- Structure ---------------------------------------------------------------

select has_table('public', 'attempt_answers', 'attempt_answers table exists');

select columns_are('public', 'attempt_answers',
  array['attempt_id', 'question_id', 'selected_answer_ids', 'is_correct', 'points',
        'answered_at'],
  'attempt_answers has exactly the planned columns');

select col_is_pk('public', 'attempt_answers', array['attempt_id', 'question_id'],
  'attempt_answers has the primary key (attempt_id, question_id)');

select col_type_is('public', 'attempt_answers', 'attempt_id', 'uuid',
  'attempt_answers.attempt_id is a uuid');
select col_not_null('public', 'attempt_answers', 'attempt_id',
  'attempt_answers.attempt_id is required');
select fk_ok('public', 'attempt_answers', 'attempt_id', 'public', 'attempts', 'id',
  'attempt_answers.attempt_id references attempts.id');

select col_type_is('public', 'attempt_answers', 'question_id', 'uuid',
  'attempt_answers.question_id is a uuid');
select col_not_null('public', 'attempt_answers', 'question_id',
  'attempt_answers.question_id is required');
select fk_ok('public', 'attempt_answers', 'question_id', 'public', 'questions', 'id',
  'attempt_answers.question_id references questions.id');

select col_type_is('public', 'attempt_answers', 'selected_answer_ids', 'uuid[]',
  'attempt_answers.selected_answer_ids is a uuid array');
select col_not_null('public', 'attempt_answers', 'selected_answer_ids',
  'attempt_answers.selected_answer_ids is required');

select col_type_is('public', 'attempt_answers', 'is_correct', 'boolean',
  'attempt_answers.is_correct is a boolean');
select col_not_null('public', 'attempt_answers', 'is_correct',
  'attempt_answers.is_correct is required, an answer is scored when it is stored');

select col_type_is('public', 'attempt_answers', 'points', 'numeric(6,2)',
  'attempt_answers.points is a numeric(6,2)');
select col_not_null('public', 'attempt_answers', 'points',
  'attempt_answers.points is required, an answer is scored when it is stored');

select col_type_is('public', 'attempt_answers', 'answered_at', 'timestamp with time zone',
  'attempt_answers.answered_at is a timestamptz');
select col_not_null('public', 'attempt_answers', 'answered_at',
  'attempt_answers.answered_at is required');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.attempt_answers'::regclass
      and a.attname = 'question_id'
  ),
  'an index leads with attempt_answers.question_id'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.attempt_answers'::regclass),
  'attempt_answers has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

select results_eq(
  $$ select answered_at = now() from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000001'
       and question_id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values (true) $$,
  'a new attempt answer gets answered_at = now() by default'
);

select throws_ok(
  $$ insert into public.attempt_answers
       (attempt_id, question_id, selected_answer_ids, is_correct, points)
     values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
             '{a0000000-0000-0000-0000-000000000002}', false, 0) $$,
  '23505', null,
  'a second answer to the same question of an attempt is rejected'
);

select throws_ok(
  $$ insert into public.attempt_answers
       (attempt_id, question_id, selected_answer_ids, is_correct, points)
     values ('f0000000-0000-0000-0000-0000000000ff', 'e0000000-0000-0000-0000-000000000002',
             '{a0000000-0000-0000-0000-000000000003}', true, 1) $$,
  '23503', null,
  'an answer to an attempt that does not exist is rejected'
);

select throws_ok(
  $$ insert into public.attempt_answers
       (attempt_id, question_id, selected_answer_ids, is_correct, points)
     values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-0000000000ff',
             '{a0000000-0000-0000-0000-000000000003}', true, 1) $$,
  '23503', null,
  'an answer to a question that does not exist is rejected'
);

-- Cascades (as the owner) -------------------------------------------------

-- Deleting a quiz deletes its questions, and with them the attempt answers;
-- the attempt itself stays with its stored score.
delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000002';

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000005' $$,
  'deleting a question deletes the attempt answers to it'
);

select results_eq(
  $$ select quiz_id, score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000005' $$,
  $$ values (null::uuid, 1::numeric) $$,
  'deleting a quiz keeps the score of its attempts although their answers are gone'
);

delete from public.attempts where id = 'f0000000-0000-0000-0000-000000000006';

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000006' $$,
  'deleting an attempt deletes its answers'
);

delete from auth.users where id = '55555555-5555-5555-5555-555555555555';

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000007' $$,
  'deleting the auth user deletes the answers of their attempts'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select * from public.attempt_answers $$,
  '42501', null,
  'anon cannot read attempt answers'
);

select throws_ok(
  $$ insert into public.attempt_answers
       (attempt_id, question_id, selected_answer_ids, is_correct, points)
     values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',
             '{a0000000-0000-0000-0000-000000000003}', true, 1) $$,
  '42501', null,
  'anon cannot insert an attempt answer'
);

select throws_ok(
  $$ update public.attempt_answers set points = 1
     where attempt_id = 'f0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'anon cannot update an attempt answer'
);

select throws_ok(
  $$ delete from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete an attempt answer'
);

reset role;

-- anonymous user (guest) --------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select attempt_id, question_id, selected_answer_ids, is_correct, points
     from public.attempt_answers $$,
  $$ values ('f0000000-0000-0000-0000-000000000004'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             '{a0000000-0000-0000-0000-000000000001}'::uuid[], true, 1::numeric) $$,
  'an anonymous user reads the answers of their own attempts and no others'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000001' $$,
  'an anonymous user cannot read the answers of a learner''s attempt'
);

select throws_ok(
  $$ insert into public.attempt_answers
       (attempt_id, question_id, selected_answer_ids, is_correct, points)
     values ('f0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000002',
             '{a0000000-0000-0000-0000-000000000003}', true, 1) $$,
  '42501', null,
  'an anonymous user cannot insert an answer into their own attempt directly'
);

select throws_ok(
  $$ update public.attempt_answers set points = 0
     where attempt_id = 'f0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an anonymous user cannot update the answers of their own attempt'
);

select throws_ok(
  $$ delete from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an anonymous user cannot delete the answers of their own attempt'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select attempt_id, question_id, selected_answer_ids, is_correct, points
     from public.attempt_answers $$,
  $$ values ('f0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             '{a0000000-0000-0000-0000-000000000001}'::uuid[], true, 1::numeric) $$,
  'a learner reads the answers of their own attempts and no others'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000002' $$,
  'a learner cannot read the answers of another learner''s attempt'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000004' $$,
  'a learner cannot read the answers of an anonymous user''s attempt'
);

select throws_ok(
  $$ insert into public.attempt_answers
       (attempt_id, question_id, selected_answer_ids, is_correct, points)
     values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',
             '{a0000000-0000-0000-0000-000000000003}', true, 1) $$,
  '42501', null,
  'a learner cannot insert an answer into their own attempt directly'
);

select throws_ok(
  $$ update public.attempt_answers set points = 0
     where attempt_id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot update the answers of their own attempt'
);

select throws_ok(
  $$ update public.attempt_answers set points = 1, is_correct = true
     where attempt_id = 'f0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'a learner cannot update the answers of another learner''s attempt'
);

select throws_ok(
  $$ delete from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot delete the answers of their own attempt'
);

reset role;

-- admin (carol), treated like a learner in phase 1 ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select attempt_id, question_id, selected_answer_ids, is_correct, points
     from public.attempt_answers $$,
  $$ values ('f0000000-0000-0000-0000-000000000003'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             '{a0000000-0000-0000-0000-000000000001}'::uuid[], true, 1::numeric) $$,
  'an admin reads the answers of their own attempts and no others in phase 1'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000002' $$,
  'an admin cannot read the answers of a learner''s attempt in phase 1'
);

select throws_ok(
  $$ insert into public.attempt_answers
       (attempt_id, question_id, selected_answer_ids, is_correct, points)
     values ('f0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002',
             '{a0000000-0000-0000-0000-000000000003}', true, 1) $$,
  '42501', null,
  'an admin cannot insert an attempt answer directly in phase 1'
);

select throws_ok(
  $$ update public.attempt_answers set points = 1
     where attempt_id = 'f0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'an admin cannot update an attempt answer in phase 1'
);

select throws_ok(
  $$ delete from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'an admin cannot delete an attempt answer in phase 1'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select attempt_id, question_id, is_correct, points from public.attempt_answers
     order by attempt_id, question_id $$,
  $$ values
       ('f0000000-0000-0000-0000-000000000001'::uuid,
        'e0000000-0000-0000-0000-000000000001'::uuid, true, 1::numeric),
       ('f0000000-0000-0000-0000-000000000002'::uuid,
        'e0000000-0000-0000-0000-000000000001'::uuid, false, 0::numeric),
       ('f0000000-0000-0000-0000-000000000003'::uuid,
        'e0000000-0000-0000-0000-000000000001'::uuid, true, 1::numeric),
       ('f0000000-0000-0000-0000-000000000004'::uuid,
        'e0000000-0000-0000-0000-000000000001'::uuid, true, 1::numeric) $$,
  'the rejected writes left the attempt answers unchanged'
);

select * from finish();
rollback;
