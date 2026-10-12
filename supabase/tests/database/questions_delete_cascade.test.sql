-- Deleting a question through the API, as an admin, when learners have
-- recorded answers to it (#81). Decided at gate 1: the delete cascades to
-- its answers and to the attempt_answers that point at it (foreign keys,
-- which bypass RLS, so the admin needs no write grant on them), and the
-- attempts themselves are left as they are:
-- - a finished attempt keeps score, max_score and finished_at, so the
--   learner keeps their result;
-- - an in-progress attempt keeps its stored score and max_score; the delete
--   itself recomputes nothing. Accepted gap (decisions log): max_score still
--   counts the deleted question, so that attempt can't finish any more, and
--   its next submit_answer recomputes the score without the deleted
--   question's points. The same holds when the learner hadn't answered the
--   deleted question yet.
-- The other questions, answers and recorded answers are the control.
-- Fixtures are created here as the owner, independent of seed.sql, and
-- vanish on rollback.
begin;
select plan(17);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Quiz', 1, true);

insert into public.questions (id, quiz_id, text, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Wird gelöscht?', 1),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'Bleibt?', 2),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001',
   'Noch unbeantwortet, wird gelöscht?', 3);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Richtig', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Falsch', false, 2),
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002',
   'Richtig', true, 1),
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000003',
   'Richtig', true, 1);

-- Alice finished the quiz (2 of 3 points); Bob is half-way: he answered the
-- first two questions (1 point), not the third.
insert into public.attempts (id, user_id, quiz_id, finished_at, score, max_score) values
  ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000001', '2026-10-01 12:00:00+00', 2, 3),
  ('f0000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'd0000000-0000-0000-0000-000000000001', null, 1, 3);

insert into public.attempt_answers
  (attempt_id, question_id, selected_answer_ids, is_correct, points) values
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',
   '{a0000000-0000-0000-0000-000000000003}', true, 1),
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000003',
   '{}', false, 0),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002',
   '{a0000000-0000-0000-0000-000000000004}', false, 0);

-- The admin deletes a question with recorded answers -------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  'an admin can delete a question that learners have answered'
);

reset role;

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  'the question is gone'
);

select is_empty(
  $$ select 1 from public.answers
     where id in ('a0000000-0000-0000-0000-000000000001',
                  'a0000000-0000-0000-0000-000000000002') $$,
  'its answers are gone'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where question_id = 'e0000000-0000-0000-0000-000000000001' $$,
  'the recorded answers to it are gone, in every attempt'
);

select results_eq(
  $$ select quiz_id, finished_at, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid,
             '2026-10-01 12:00:00+00'::timestamptz, 2::numeric(6, 2), 3) $$,
  'the finished attempt keeps its score, max_score and finished_at'
);

select results_eq(
  $$ select quiz_id, finished_at, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000002' $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid, null::timestamptz,
             1::numeric(6, 2), 3) $$,
  'the in-progress attempt keeps its stored score and max_score: the delete recomputes nothing'
);

select results_eq(
  $$ select attempt_id, question_id from public.attempt_answers
     order by attempt_id, question_id $$,
  $$ values ('f0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000002'::uuid),
            ('f0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000003'::uuid),
            ('f0000000-0000-0000-0000-000000000002'::uuid,
             'e0000000-0000-0000-0000-000000000002'::uuid) $$,
  'the recorded answers to the other questions stay'
);

select results_eq(
  $$ select
       (select count(*)::integer from public.questions
         where id in ('e0000000-0000-0000-0000-000000000002',
                      'e0000000-0000-0000-0000-000000000003')),
       (select count(*)::integer from public.answers
         where id in ('a0000000-0000-0000-0000-000000000003',
                      'a0000000-0000-0000-0000-000000000004')) $$,
  $$ values (2, 2) $$,
  'the quiz''s other questions and their answers stay'
);

-- The learners still read their attempts ------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select finished_at is not null, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  $$ values (true, 2::numeric(6, 2), 3) $$,
  'the learner still reads the finished attempt''s score and max_score'
);

reset role;

-- The admin deletes a question Bob hasn't answered yet ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  'an admin can delete a question that an in-progress attempt has not answered yet'
);

reset role;

select is_empty(
  $$ select 1 from public.attempt_answers
     where question_id = 'e0000000-0000-0000-0000-000000000003' $$,
  'the finished attempt''s recorded answer to that question is gone'
);

select results_eq(
  $$ select finished_at, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  $$ values ('2026-10-01 12:00:00+00'::timestamptz, 2::numeric(6, 2), 3) $$,
  'the finished attempt still keeps its score, max_score and finished_at'
);

select results_eq(
  $$ select finished_at, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000002' $$,
  $$ values (null::timestamptz, 1::numeric(6, 2), 3) $$,
  'the in-progress attempt is unchanged: max_score still counts the deleted question'
);

select results_eq(
  $$ select count(*)::integer from public.questions
     where quiz_id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values (1) $$,
  'one question is left in the quiz'
);

-- No way for the client to touch the attempts ---------------------------------

select ok(
  not has_table_privilege('authenticated', 'public.attempts', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('authenticated', 'public.attempt_answers', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('anon', 'public.attempts', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('anon', 'public.attempt_answers', 'INSERT, UPDATE, DELETE'),
  'the cascade works without write grants on attempts or attempt_answers'
);

-- A learner can't delete a question to drop a wrong answer of their own.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}', true);

select lives_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  'a learner''s delete of a question they answered raises no error (RLS filters it)'
);

reset role;

select results_eq(
  $$ select
       (select count(*)::integer from public.questions
         where id = 'e0000000-0000-0000-0000-000000000002'),
       (select count(*)::integer from public.attempt_answers
         where attempt_id = 'f0000000-0000-0000-0000-000000000002') $$,
  $$ values (1, 1) $$,
  'the learner''s delete removed neither the question nor their recorded answer'
);

select * from finish();
rollback;
