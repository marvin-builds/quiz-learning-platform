-- Deleting a category through the API, as an admin, when it holds a quiz
-- with a finished attempt (#80): its quizzes, questions and answers go with
-- it (foreign-key cascades, which bypass RLS, so the admin needs no write
-- grant on the child tables), the attempt's answers cascade away through
-- their questions, and the attempt itself stays with its score and max_score
-- and quiz_id null, so the learner keeps their result. A second category is
-- the control: nothing of it changes. Fixtures are created here as the
-- owner, independent of seed.sql, and vanish on rollback. Storage objects
-- the deleted questions point to are left alone (orphan cleanup is a
-- follow-up for the image upload slice).
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(13);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Wird gelöscht', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Bleibt', 2, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Quiz im gelöschten Thema', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
   'Quiz im bleibenden Thema', 1, true);

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
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Falsch', false, 2),
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002',
   'Richtig', true, 1),
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000003',
   'Richtig', true, 1);

-- Alice finished the quiz in the category that is deleted (1.5 of 2 points)
-- and one in the category that stays.
insert into public.attempts (id, user_id, quiz_id, finished_at, score, max_score) values
  ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000001', '2026-10-01 12:00:00+00', 1.5, 2),
  ('f0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000002', '2026-10-01 13:00:00+00', 1, 1);

insert into public.attempt_answers
  (attempt_id, question_id, selected_answer_ids, is_correct, points) values
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   '{a0000000-0000-0000-0000-000000000001}', true, 1),
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',
   '{a0000000-0000-0000-0000-000000000003}', true, 0.5),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000003',
   '{a0000000-0000-0000-0000-000000000004}', true, 1);

-- The admin deletes the category ---------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select lives_ok(
  $$ delete from public.categories where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'an admin can delete a category that holds a quiz with a finished attempt'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select is_empty(
  $$ select 1 from public.categories where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'the category is gone'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000001' $$,
  'its quiz is gone'
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
                  'a0000000-0000-0000-0000-000000000002',
                  'a0000000-0000-0000-0000-000000000003') $$,
  'its answers are gone'
);

select results_eq(
  $$ select user_id, quiz_id, finished_at, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, null::uuid,
             '2026-10-01 12:00:00+00'::timestamptz, 1.5::numeric(6, 2), 2) $$,
  'the finished attempt stays, with its score and max_score, and quiz_id null'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000001' $$,
  'the answers of that attempt are gone with their questions'
);

-- Control: the other category is untouched.

select results_eq(
  $$ select count(*)::integer from public.categories
     where id = 'c0000000-0000-0000-0000-000000000002' $$,
  $$ values (1) $$,
  'the other category stays'
);

select results_eq(
  $$ select
       (select count(*)::integer from public.quizzes
         where id = 'd0000000-0000-0000-0000-000000000002'),
       (select count(*)::integer from public.questions
         where id = 'e0000000-0000-0000-0000-000000000003'),
       (select count(*)::integer from public.answers
         where id = 'a0000000-0000-0000-0000-000000000004') $$,
  $$ values (1, 1, 1) $$,
  'the other category''s quiz, question and answer stay'
);

select results_eq(
  $$ select quiz_id, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000002' $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid, 1::numeric(6, 2), 1) $$,
  'the attempt in the other category keeps its quiz'
);

select results_eq(
  $$ select count(*)::integer from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000002' $$,
  $$ values (1) $$,
  'the answers of the attempt in the other category stay'
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

-- The cascade needs no write grant on the attempts: scores stay out of the
-- client's reach. (The quizzes, questions and answers files check that the
-- admin can't write those tables yet.)

select ok(
  not has_table_privilege('authenticated', 'public.attempts', 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('authenticated', 'public.attempt_answers', 'INSERT, UPDATE, DELETE'),
  'the cascade works without write grants on attempts or attempt_answers'
);

select * from finish();
rollback;
