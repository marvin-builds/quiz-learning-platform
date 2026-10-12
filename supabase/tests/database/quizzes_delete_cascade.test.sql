-- Deleting a quiz through the API, as an admin, when learners have played it
-- (#81), as with categories (#80): its questions and answers go with it
-- (foreign-key cascades, which bypass RLS), the attempts' recorded answers
-- cascade away through the questions, and every attempt stays with
-- quiz_id set null: a finished one keeps score, max_score and finished_at,
-- an in-progress one keeps its stored score (it can't be continued, since
-- submit_answer needs a visible quiz). A second quiz in the same category is
-- the control. Fixtures are created here as the owner, independent of
-- seed.sql, and vanish on rollback.
begin;
select plan(11);

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
   'Wird gelöscht', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Bleibt', 2, true);

insert into public.questions (id, quiz_id, text, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Erste Frage?', 1),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'Zweite Frage?', 2),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002',
   'Frage, die bleibt?', 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Richtig', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002',
   'Richtig', true, 1),
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003',
   'Richtig', true, 1);

-- Alice finished the quiz that is deleted (1.5 of 2), Bob is half-way
-- through it, and Alice finished the other quiz too.
insert into public.attempts (id, user_id, quiz_id, finished_at, score, max_score) values
  ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000001', '2026-10-01 12:00:00+00', 1.5, 2),
  ('f0000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'd0000000-0000-0000-0000-000000000001', null, 1, 2),
  ('f0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000002', '2026-10-01 13:00:00+00', 1, 1);

insert into public.attempt_answers
  (attempt_id, question_id, selected_answer_ids, is_correct, points) values
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',
   '{a0000000-0000-0000-0000-000000000002}', true, 0.5),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003',
   '{a0000000-0000-0000-0000-000000000003}', true, 1);

-- The admin deletes the quiz -------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  'an admin can delete a quiz that learners have played'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  'the quiz is gone'
);

select is_empty(
  $$ select 1 from public.questions
     where id in ('e0000000-0000-0000-0000-000000000001',
                  'e0000000-0000-0000-0000-000000000002') $$,
  'its questions are gone'
);

select is_empty(
  $$ select 1 from public.answers
     where id in ('a0000000-0000-0000-0000-000000000001',
                  'a0000000-0000-0000-0000-000000000002') $$,
  'its answers are gone'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id in ('f0000000-0000-0000-0000-000000000001',
                          'f0000000-0000-0000-0000-000000000002') $$,
  'the recorded answers of its attempts are gone with the questions'
);

select results_eq(
  $$ select user_id, quiz_id, finished_at, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, null::uuid,
             '2026-10-01 12:00:00+00'::timestamptz, 1.5::numeric(6, 2), 2) $$,
  'the finished attempt stays, with its score, max_score and finished_at, and quiz_id null'
);

select results_eq(
  $$ select user_id, quiz_id, finished_at, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000002' $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, null::uuid,
             null::timestamptz, 1::numeric(6, 2), 2) $$,
  'the in-progress attempt stays with its stored score and quiz_id null'
);

-- Control: the other quiz is untouched.

select results_eq(
  $$ select
       (select count(*)::integer from public.quizzes
         where id = 'd0000000-0000-0000-0000-000000000002'),
       (select count(*)::integer from public.questions
         where id = 'e0000000-0000-0000-0000-000000000003'),
       (select count(*)::integer from public.answers
         where id = 'a0000000-0000-0000-0000-000000000003') $$,
  $$ values (1, 1, 1) $$,
  'the other quiz, its question and its answer stay'
);

select results_eq(
  $$ select a.quiz_id, a.score, a.max_score,
            (select count(*)::integer from public.attempt_answers aa where aa.attempt_id = a.id)
     from public.attempts a
     where a.id = 'f0000000-0000-0000-0000-000000000003' $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid, 1::numeric(6, 2), 1, 1) $$,
  'the attempt of the other quiz keeps its quiz, score and recorded answer'
);

-- The learner still sees their result ---------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select quiz_id, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  $$ values (null::uuid, 1.5::numeric(6, 2), 2) $$,
  'the learner still reads the attempt''s score and max_score'
);

reset role;

select ok(
  not has_table_privilege('authenticated', 'public.attempts', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('authenticated', 'public.attempt_answers', 'INSERT, UPDATE, DELETE'),
  'the cascade works without write grants on attempts or attempt_answers'
);

select * from finish();
rollback;
