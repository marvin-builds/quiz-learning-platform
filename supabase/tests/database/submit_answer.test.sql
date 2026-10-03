-- public.submit_answer(attempt_id uuid, question_id uuid, answer_ids uuid[]):
-- the only way to the solutions. It runs as security definer with an empty
-- search_path, only authenticated may call it (anonymous users included, anon
-- not), and it returns exactly one row (is_correct, points,
-- correct_answer_ids, explanation) for the asked question. It records and
-- scores the first valid answer per (attempt, question) before revealing
-- anything; a later call, or one that loses the race, gets the stored row.
-- Points follow plan § 7 with one point per question, rounded to 2 decimals;
-- when the stored answers reach max_score the attempt is finished. Every
-- rejection raises SQLSTATE P0001 with exactly 'not available' and stores
-- nothing. Points are compared as text so the scale (2 decimals) is pinned.
-- Fixtures are created here as the owner, independent of seed.sql, and
-- vanish on rollback. now() is fixed within the transaction, so attempts
-- created by start_attempt start at the same instant the fixture questions
-- were created, which must count as "not after". In phase 1 an admin is
-- treated like a learner.
begin;
select plan(86);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  -- three questions: single with explanation, multiple without, single with explanation
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Drei Fragen', 1, true),
  -- one question, used for "a question from another quiz" and the roles
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Eine Frage', 2, true),
  -- unpublished after the attempt started
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001',
   'Wird zurückgezogen', 3, true),
  -- deleted after the attempt started
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001',
   'Wird gelöscht', 4, true),
  -- questions created before, at and after the attempt started
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001',
   'Wächst nach dem Start', 5, true),
  -- three multiple-choice questions with three correct answers each
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001',
   'Drei Mehrfachauswahlfragen', 6, true);

insert into public.questions (id, quiz_id, text, multiple_correct, explanation, sort_order) values
  ('e0000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', false, 'Der Himmel ist blau.', 1),
  ('e0000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000001',
   'Welche Zahlen sind gerade?', true, null, 2),
  ('e0000000-0000-0000-0000-000000000013', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat Gras?', false, 'Gras ist grün.', 3),
  ('e0000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000002',
   'Wie viele Beine hat eine Katze?', false, 'Katzen haben vier Beine.', 1),
  ('e0000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000003',
   'Frage im zurückgezogenen Quiz?', false, null, 1),
  ('e0000000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000004',
   'Frage im gelöschten Quiz?', false, null, 1),
  ('e0000000-0000-0000-0000-000000000061', 'd0000000-0000-0000-0000-000000000006',
   'Erste Mehrfachauswahl?', true, null, 1),
  ('e0000000-0000-0000-0000-000000000062', 'd0000000-0000-0000-0000-000000000006',
   'Zweite Mehrfachauswahl?', true, null, 2),
  ('e0000000-0000-0000-0000-000000000063', 'd0000000-0000-0000-0000-000000000006',
   'Dritte Mehrfachauswahl?', true, null, 3);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order, created_at) values
  ('e0000000-0000-0000-0000-000000000051', 'd0000000-0000-0000-0000-000000000005',
   'Vor dem Start erstellt?', false, 1, '2026-01-01 10:00:00+00'),
  ('e0000000-0000-0000-0000-000000000052', 'd0000000-0000-0000-0000-000000000005',
   'Nach dem Start erstellt?', false, 2, '2026-01-01 12:00:00+00'),
  ('e0000000-0000-0000-0000-000000000053', 'd0000000-0000-0000-0000-000000000005',
   'Genau beim Start erstellt?', false, 3, '2026-01-01 11:00:00+00');

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000111', 'e0000000-0000-0000-0000-000000000011', 'Blau', true, 1),
  ('a0000000-0000-0000-0000-000000000112', 'e0000000-0000-0000-0000-000000000011', 'Rot', false, 2),
  ('a0000000-0000-0000-0000-000000000113', 'e0000000-0000-0000-0000-000000000011', 'Gelb', false, 3),
  -- sort_order runs against the id order (123 first), and 121/122 tie on
  -- sort_order, so the id breaks the tie: expected {123, 121, 122}
  ('a0000000-0000-0000-0000-000000000121', 'e0000000-0000-0000-0000-000000000012', 'Zwei', true, 2),
  ('a0000000-0000-0000-0000-000000000122', 'e0000000-0000-0000-0000-000000000012', 'Vier', true, 2),
  ('a0000000-0000-0000-0000-000000000123', 'e0000000-0000-0000-0000-000000000012', 'Sechs', true, 1),
  ('a0000000-0000-0000-0000-000000000124', 'e0000000-0000-0000-0000-000000000012', 'Drei', false, 3),
  ('a0000000-0000-0000-0000-000000000131', 'e0000000-0000-0000-0000-000000000013', 'Grün', true, 1),
  ('a0000000-0000-0000-0000-000000000132', 'e0000000-0000-0000-0000-000000000013', 'Lila', false, 2),
  ('a0000000-0000-0000-0000-000000000211', 'e0000000-0000-0000-0000-000000000021', 'Vier', true, 1),
  ('a0000000-0000-0000-0000-000000000212', 'e0000000-0000-0000-0000-000000000021', 'Drei', false, 2),
  ('a0000000-0000-0000-0000-000000000311', 'e0000000-0000-0000-0000-000000000031', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-000000000411', 'e0000000-0000-0000-0000-000000000041', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-000000000511', 'e0000000-0000-0000-0000-000000000051', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-000000000521', 'e0000000-0000-0000-0000-000000000052', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-000000000531', 'e0000000-0000-0000-0000-000000000053', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-000000000611', 'e0000000-0000-0000-0000-000000000061', 'A', true, 1),
  ('a0000000-0000-0000-0000-000000000612', 'e0000000-0000-0000-0000-000000000061', 'B', true, 2),
  ('a0000000-0000-0000-0000-000000000613', 'e0000000-0000-0000-0000-000000000061', 'C', true, 3),
  ('a0000000-0000-0000-0000-000000000614', 'e0000000-0000-0000-0000-000000000061', 'D', false, 4),
  ('a0000000-0000-0000-0000-000000000621', 'e0000000-0000-0000-0000-000000000062', 'A', true, 1),
  ('a0000000-0000-0000-0000-000000000622', 'e0000000-0000-0000-0000-000000000062', 'B', true, 2),
  ('a0000000-0000-0000-0000-000000000623', 'e0000000-0000-0000-0000-000000000062', 'C', true, 3),
  ('a0000000-0000-0000-0000-000000000624', 'e0000000-0000-0000-0000-000000000062', 'D', false, 4),
  ('a0000000-0000-0000-0000-000000000631', 'e0000000-0000-0000-0000-000000000063', 'A', true, 1),
  ('a0000000-0000-0000-0000-000000000632', 'e0000000-0000-0000-0000-000000000063', 'B', true, 2),
  ('a0000000-0000-0000-0000-000000000633', 'e0000000-0000-0000-0000-000000000063', 'C', true, 3),
  ('a0000000-0000-0000-0000-000000000634', 'e0000000-0000-0000-0000-000000000063', 'D', false, 4);

-- Alice's attempt on the growing quiz, started at 11:00 (set explicitly).
insert into public.attempts (id, user_id, quiz_id, started_at, max_score) values
  ('f0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000005', '2026-01-01 11:00:00+00', 2);

-- Structure and privileges --------------------------------------------------
-- to_regprocedure returns null while the function is missing, so these fail
-- as assertions instead of aborting the file.

select has_function('public', 'submit_answer', '{uuid,uuid,uuid[]}'::name[],
  'public.submit_answer(uuid, uuid, uuid[]) exists');

select function_returns('public', 'submit_answer', '{uuid,uuid,uuid[]}'::name[], 'setof record',
  'submit_answer returns a table');

select is(
  (select proargnames from pg_proc
   where oid = to_regprocedure('public.submit_answer(uuid,uuid,uuid[])')),
  array['attempt_id', 'question_id', 'answer_ids',
        'is_correct', 'points', 'correct_answer_ids', 'explanation']::text[],
  'submit_answer''s parameters and result columns have the names the API uses'
);

select is(
  (select array_agg(format_type(t.type, null) order by t.ord)
   from pg_proc p, unnest(p.proallargtypes) with ordinality as t(type, ord)
   where p.oid = to_regprocedure('public.submit_answer(uuid,uuid,uuid[])')),
  array['uuid', 'uuid', 'uuid[]', 'boolean', 'numeric', 'uuid[]', 'text']::text[],
  'submit_answer takes (uuid, uuid, uuid[]) and returns (boolean, numeric, uuid[], text)'
);

select is(
  (select proargmodes::text[] from pg_proc
   where oid = to_regprocedure('public.submit_answer(uuid,uuid,uuid[])')),
  array['i', 'i', 'i', 't', 't', 't', 't']::text[],
  'submit_answer has three inputs and four table columns'
);

select is_definer('public', 'submit_answer', '{uuid,uuid,uuid[]}'::name[],
  'submit_answer is security definer');

select ok(
  (select coalesce(proconfig @> array['search_path=""'], false)
   from pg_proc where oid = to_regprocedure('public.submit_answer(uuid,uuid,uuid[])')),
  'submit_answer sets search_path to the empty string'
);

select ok(
  coalesce(has_function_privilege('authenticated',
    to_regprocedure('public.submit_answer(uuid,uuid,uuid[])'), 'execute'), false),
  'authenticated may execute submit_answer'
);

select ok(
  coalesce(not has_function_privilege('anon',
    to_regprocedure('public.submit_answer(uuid,uuid,uuid[])'), 'execute'), false),
  'anon may not execute submit_answer'
);

-- A null ACL means the default, which grants execute to PUBLIC.
select ok(
  to_regprocedure('public.submit_answer(uuid,uuid,uuid[])') is not null
  and not exists (
    select 1
    from pg_proc p,
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid = to_regprocedure('public.submit_answer(uuid,uuid,uuid[])')
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'),
  'PUBLIC has no execute grant on submit_answer'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select * from public.submit_answer('f0000000-0000-0000-0000-000000000005',
       'e0000000-0000-0000-0000-000000000051', '{a0000000-0000-0000-0000-000000000511}') $$,
  '42501', null,
  'anon cannot call submit_answer'
);

reset role;

-- bob: an attempt with a stored answer, used as "another user's attempt" --

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}', true);

select set_config('test.bob',
  public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);

select results_eq(
  $$ select is_correct, points::text from public.submit_answer(
       current_setting('test.bob')::uuid, 'e0000000-0000-0000-0000-000000000011',
       '{a0000000-0000-0000-0000-000000000112}') $$,
  $$ values (false, '0.00') $$,
  'bob answers a question of his own attempt'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select set_config('test.a1', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.a2', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.a3', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.a4', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.a5', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.rej', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.sep', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.race_a', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.race_b', public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true);
select set_config('test.unpub', public.start_attempt('d0000000-0000-0000-0000-000000000003')::text, true);
select set_config('test.deleted', public.start_attempt('d0000000-0000-0000-0000-000000000004')::text, true);
select set_config('test.three', public.start_attempt('d0000000-0000-0000-0000-000000000006')::text, true);

-- Scoring (plan § 7), result and stored row -------------------------------

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.a1')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  $$ values (true, '1.00', '{a0000000-0000-0000-0000-000000000111}'::uuid[],
             'Der Himmel ist blau.') $$,
  'single choice: the correct answer gives 1.00, is correct, and reveals the solution'
);

select results_eq(
  $$ select selected_answer_ids, is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.a1')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000011' $$,
  $$ values ('{a0000000-0000-0000-0000-000000000111}'::uuid[], true, '1.00') $$,
  'single choice: the correct answer is stored with 1.00'
);

select results_eq(
  $$ select score::text, finished_at is null from public.attempts
     where id = current_setting('test.a1')::uuid $$,
  $$ values ('1.00', true) $$,
  'after the first answer the score is that answer''s points and the attempt is not finished'
);

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.a2')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000112}') $$,
  $$ values (false, '0.00', '{a0000000-0000-0000-0000-000000000111}'::uuid[],
             'Der Himmel ist blau.') $$,
  'single choice: a wrong answer gives 0.00 and is not correct'
);

select results_eq(
  $$ select selected_answer_ids, is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.a2')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000011' $$,
  $$ values ('{a0000000-0000-0000-0000-000000000112}'::uuid[], false, '0.00') $$,
  'single choice: a wrong answer is stored with 0.00'
);

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.a2')::uuid,
       'e0000000-0000-0000-0000-000000000012',
       '{a0000000-0000-0000-0000-000000000122,a0000000-0000-0000-0000-000000000121,a0000000-0000-0000-0000-000000000123}') $$,
  $$ values (true, '1.00',
             '{a0000000-0000-0000-0000-000000000123,a0000000-0000-0000-0000-000000000121,a0000000-0000-0000-0000-000000000122}'::uuid[],
             null::text) $$,
  'multiple choice: all correct answers give 1.00; correct ids in sort_order, then id; no explanation gives null'
);

select results_eq(
  $$ select is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.a2')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000012' $$,
  $$ values (true, '1.00') $$,
  'multiple choice: all correct answers are stored with 1.00'
);

select results_eq(
  $$ select score::text from public.attempts where id = current_setting('test.a2')::uuid $$,
  $$ values ('1.00') $$,
  'the score is the running sum of the stored points (0.00 + 1.00)'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a1')::uuid,
       'e0000000-0000-0000-0000-000000000012',
       '{a0000000-0000-0000-0000-000000000123,a0000000-0000-0000-0000-000000000121}') $$,
  $$ values (false, '0.67') $$,
  'multiple choice: 2 of 3 correct answers give 0.67 and are not correct'
);

select results_eq(
  $$ select is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.a1')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000012' $$,
  $$ values (false, '0.67') $$,
  'multiple choice: 2 of 3 is stored with 0.67'
);

select results_eq(
  $$ select score::text, finished_at is null from public.attempts
     where id = current_setting('test.a1')::uuid $$,
  $$ values ('1.67', true) $$,
  'after the second of three answers the score is 1.67 and the attempt is not finished'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a3')::uuid,
       'e0000000-0000-0000-0000-000000000012', '{a0000000-0000-0000-0000-000000000122}') $$,
  $$ values (false, '0.33') $$,
  'multiple choice: 1 of 3 correct answers gives 0.33'
);

select results_eq(
  $$ select is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.a3')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000012' $$,
  $$ values (false, '0.33') $$,
  'multiple choice: 1 of 3 is stored with 0.33'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a4')::uuid,
       'e0000000-0000-0000-0000-000000000012',
       '{a0000000-0000-0000-0000-000000000121,a0000000-0000-0000-0000-000000000122,a0000000-0000-0000-0000-000000000123,a0000000-0000-0000-0000-000000000124}') $$,
  $$ values (false, '0.00') $$,
  'multiple choice: all correct answers plus a wrong one give 0.00'
);

select results_eq(
  $$ select is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.a4')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000012' $$,
  $$ values (false, '0.00') $$,
  'multiple choice: a selection with a wrong pick is stored with 0.00'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a5')::uuid,
       'e0000000-0000-0000-0000-000000000012', '{a0000000-0000-0000-0000-000000000124}') $$,
  $$ values (false, '0.00') $$,
  'multiple choice: only a wrong answer gives 0.00'
);

-- Finishing ---------------------------------------------------------------

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.a1')::uuid,
       'e0000000-0000-0000-0000-000000000013', '{a0000000-0000-0000-0000-000000000132}') $$,
  $$ values (false, '0.00', '{a0000000-0000-0000-0000-000000000131}'::uuid[], 'Gras ist grün.') $$,
  'the last question of an attempt is scored like any other'
);

select results_eq(
  $$ select score::text, finished_at is not null from public.attempts
     where id = current_setting('test.a1')::uuid $$,
  $$ values ('1.67', true) $$,
  'when the stored answers reach max_score the attempt is finished with the sum of the points'
);

select results_eq(
  $$ select points::text from public.submit_answer(current_setting('test.three')::uuid,
       'e0000000-0000-0000-0000-000000000061', '{a0000000-0000-0000-0000-000000000611}') $$,
  $$ values ('0.33') $$,
  'answer 1 of 3: 1 of 3 correct answers gives 0.33'
);

select results_eq(
  $$ select points::text from public.submit_answer(current_setting('test.three')::uuid,
       'e0000000-0000-0000-0000-000000000062', '{a0000000-0000-0000-0000-000000000622}') $$,
  $$ values ('0.33') $$,
  'answer 2 of 3: 1 of 3 correct answers gives 0.33'
);

select results_eq(
  $$ select points::text from public.submit_answer(current_setting('test.three')::uuid,
       'e0000000-0000-0000-0000-000000000063', '{a0000000-0000-0000-0000-000000000633}') $$,
  $$ values ('0.33') $$,
  'answer 3 of 3: 1 of 3 correct answers gives 0.33'
);

select results_eq(
  $$ select score::text, finished_at is not null from public.attempts
     where id = current_setting('test.three')::uuid $$,
  $$ values ('0.99', true) $$,
  'three answers of 0.33 finish the attempt with a score of 0.99'
);

-- Only the asked question -------------------------------------------------

select results_eq(
  $$ select count(*)::int,
            bool_and(not (correct_answer_ids && '{a0000000-0000-0000-0000-000000000131,a0000000-0000-0000-0000-000000000121,a0000000-0000-0000-0000-000000000122,a0000000-0000-0000-0000-000000000123}'::uuid[])),
            bool_and(explanation is distinct from 'Gras ist grün.')
     from public.submit_answer(current_setting('test.sep')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  $$ values (1, true, true) $$,
  'the result is exactly one row and holds no other question''s correct ids or explanation'
);

-- Idempotency and check order: a stored answer wins over new input ------

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.a2')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  $$ values (false, '0.00', '{a0000000-0000-0000-0000-000000000111}'::uuid[],
             'Der Himmel ist blau.') $$,
  'a second call with different ids returns the stored result unchanged'
);

select results_eq(
  $$ select selected_answer_ids, is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.a2')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000011' $$,
  $$ values ('{a0000000-0000-0000-0000-000000000112}'::uuid[], false, '0.00') $$,
  'a second call stores nothing new: the stored row is unchanged and still the only one'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a2')::uuid,
       'e0000000-0000-0000-0000-000000000011', null) $$,
  $$ values (false, '0.00') $$,
  'a replay with a null array returns the stored result (stored answer checked before input)'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a2')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000211}') $$,
  $$ values (false, '0.00') $$,
  'a replay with another question''s answer id returns the stored result'
);

-- The replays above hit a 0.00 row; this one hits a 1.00 row, so an
-- implementation that adds the points again would change the score.
select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a2')::uuid,
       'e0000000-0000-0000-0000-000000000012', '{a0000000-0000-0000-0000-000000000124}') $$,
  $$ values (true, '1.00') $$,
  'a replay of a full-point answer with a wrong pick returns the stored 1.00'
);

select results_eq(
  $$ select score::text from public.attempts where id = current_setting('test.a2')::uuid $$,
  $$ values ('1.00') $$,
  'replays do not change the score'
);

reset role;
update public.attempts set finished_at = '2026-01-01 00:00:00+00'
  where id = current_setting('test.a1')::uuid;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.a1')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000112}') $$,
  $$ values (true, '1.00') $$,
  'a replay on a finished attempt returns the stored result'
);

select results_eq(
  $$ select score::text, finished_at from public.attempts
     where id = current_setting('test.a1')::uuid $$,
  $$ values ('1.67', '2026-01-01 00:00:00+00'::timestamptz) $$,
  'a replay on a finished attempt changes neither score nor finished_at'
);

-- Rejections: unknown, foreign or gone attempts and questions ------------

select throws_ok(
  $$ select * from public.submit_answer('f0000000-0000-0000-0000-0000000000ff',
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  'P0001', 'not available',
  'an unknown attempt is not available'
);

select throws_ok(
  $$ select * from public.submit_answer(null,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  'P0001', 'not available',
  'a null attempt id is not available'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       null, '{a0000000-0000-0000-0000-000000000111}') $$,
  'P0001', 'not available',
  'a null question id is not available'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.bob')::uuid,
       'e0000000-0000-0000-0000-000000000013', '{a0000000-0000-0000-0000-000000000131}') $$,
  'P0001', 'not available',
  'another user''s attempt gives the same error as an unknown one'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.bob')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  'P0001', 'not available',
  'another user''s stored answer is not returned: ownership is checked before the stored answer'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000021', '{a0000000-0000-0000-0000-000000000211}') $$,
  'P0001', 'not available',
  'a question of another quiz is not available'
);

select throws_ok(
  $$ select * from public.submit_answer('f0000000-0000-0000-0000-000000000005',
       'e0000000-0000-0000-0000-000000000052', '{a0000000-0000-0000-0000-000000000521}') $$,
  'P0001', 'not available',
  'a question created after the attempt started is not available'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer('f0000000-0000-0000-0000-000000000005',
       'e0000000-0000-0000-0000-000000000051', '{a0000000-0000-0000-0000-000000000511}') $$,
  $$ values (true, '1.00') $$,
  'a question created before the attempt started can be answered'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer('f0000000-0000-0000-0000-000000000005',
       'e0000000-0000-0000-0000-000000000053', '{a0000000-0000-0000-0000-000000000531}') $$,
  $$ values (true, '1.00') $$,
  'a question created exactly when the attempt started can be answered'
);

-- Rejections: invalid answer ids ------------------------------------------

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000011', null) $$,
  'P0001', 'not available',
  'a null array is rejected'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000012',
       array['a0000000-0000-0000-0000-000000000121', null]::uuid[]) $$,
  'P0001', 'not available',
  'an array with a null element is rejected'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{}') $$,
  'P0001', 'not available',
  'an empty array is rejected'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000011',
       '{a0000000-0000-0000-0000-000000000111,a0000000-0000-0000-0000-000000000112}') $$,
  'P0001', 'not available',
  'two distinct ids on a single-choice question are rejected'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000131}') $$,
  'P0001', 'not available',
  'an answer id of another question is rejected'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000012',
       '{a0000000-0000-0000-0000-000000000121,a0000000-0000-0000-0000-000000000131}') $$,
  'P0001', 'not available',
  'a valid id together with an answer id of another question is rejected'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000012', '{a0000000-0000-0000-0000-0000000000ff}') $$,
  'P0001', 'not available',
  'an unknown answer id is rejected'
);

select results_eq(
  $$ select (select count(*)::int from public.attempt_answers
             where attempt_id = current_setting('test.rej')::uuid),
            score::text, finished_at is null
     from public.attempts where id = current_setting('test.rej')::uuid $$,
  $$ values (0, '0.00', true) $$,
  'rejected calls store nothing and leave score and finished_at unchanged'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = 'f0000000-0000-0000-0000-000000000005'
       and question_id = 'e0000000-0000-0000-0000-000000000052' $$,
  'the rejected question created after the start has no stored answer'
);

-- Check order: the question checks (step 1) come before the stored answer
-- (step 2). Rows the function itself would never store are planted as the
-- owner: one for the question created after the start, and one for a
-- question of another quiz (the foreign key only references questions).
reset role;
insert into public.attempt_answers (attempt_id, question_id, selected_answer_ids, is_correct, points)
values
  ('f0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000052',
   '{a0000000-0000-0000-0000-000000000521}', true, 1.00),
  (current_setting('test.a5')::uuid, 'e0000000-0000-0000-0000-000000000021',
   '{a0000000-0000-0000-0000-000000000211}', true, 1.00);
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select throws_ok(
  $$ select * from public.submit_answer('f0000000-0000-0000-0000-000000000005',
       'e0000000-0000-0000-0000-000000000052', '{a0000000-0000-0000-0000-000000000521}') $$,
  'P0001', 'not available',
  'a stored answer to a question created after the start is not returned'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.a5')::uuid,
       'e0000000-0000-0000-0000-000000000021', '{a0000000-0000-0000-0000-000000000211}') $$,
  'P0001', 'not available',
  'a stored answer to a question of another quiz is not returned'
);

select results_eq(
  $$ select attempt_id, question_id, selected_answer_ids, is_correct, points::text
     from public.attempt_answers
     where (attempt_id = 'f0000000-0000-0000-0000-000000000005'
            and question_id = 'e0000000-0000-0000-0000-000000000052')
        or (attempt_id = current_setting('test.a5')::uuid
            and question_id = 'e0000000-0000-0000-0000-000000000021')
     order by question_id $$,
  $$ values
       (current_setting('test.a5')::uuid, 'e0000000-0000-0000-0000-000000000021'::uuid,
        '{a0000000-0000-0000-0000-000000000211}'::uuid[], true, '1.00'),
       ('f0000000-0000-0000-0000-000000000005'::uuid, 'e0000000-0000-0000-0000-000000000052'::uuid,
        '{a0000000-0000-0000-0000-000000000521}'::uuid[], true, '1.00') $$,
  'the planted rows of rejected questions stay the only ones, unchanged'
);

-- Duplicates are removed --------------------------------------------------

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000011',
       '{a0000000-0000-0000-0000-000000000111,a0000000-0000-0000-0000-000000000111}') $$,
  $$ values (true, '1.00') $$,
  'the same id twice on a single-choice question counts as one pick'
);

select results_eq(
  $$ select selected_answer_ids from public.attempt_answers
     where attempt_id = current_setting('test.rej')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000011' $$,
  $$ values ('{a0000000-0000-0000-0000-000000000111}'::uuid[]) $$,
  'the selected ids are stored without duplicates (single choice)'
);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.rej')::uuid,
       'e0000000-0000-0000-0000-000000000012',
       '{a0000000-0000-0000-0000-000000000121,a0000000-0000-0000-0000-000000000121}') $$,
  $$ values (false, '0.33') $$,
  'the same id twice on a multiple-choice question counts as one pick'
);

select results_eq(
  $$ select selected_answer_ids from public.attempt_answers
     where attempt_id = current_setting('test.rej')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000012' $$,
  $$ values ('{a0000000-0000-0000-0000-000000000121}'::uuid[]) $$,
  'the selected ids are stored without duplicates (multiple choice)'
);

-- Race: the stored row of a concurrent winner is returned -----------------

reset role;
insert into public.attempt_answers (attempt_id, question_id, selected_answer_ids, is_correct, points)
values (current_setting('test.race_a')::uuid, 'e0000000-0000-0000-0000-000000000011',
        '{a0000000-0000-0000-0000-000000000113}', false, 0.33);
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.race_a')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  $$ values (false, '0.33', '{a0000000-0000-0000-0000-000000000111}'::uuid[],
             'Der Himmel ist blau.') $$,
  'a call after a pre-stored row returns that row unchanged'
);

select results_eq(
  $$ select selected_answer_ids, is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.race_a')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000011' $$,
  $$ values ('{a0000000-0000-0000-0000-000000000113}'::uuid[], false, '0.33') $$,
  'the pre-stored row stays the only one, unchanged'
);

-- The pre-insert as the owner never touched the score, so it is still 0.00.
select results_eq(
  $$ select score::text, finished_at is null from public.attempts
     where id = current_setting('test.race_a')::uuid $$,
  $$ values ('0.00', true) $$,
  'a call after a pre-stored row changes neither score nor finished_at'
);

-- The real race: a trigger stores the winner's row right before the
-- function's own insert, after its existence check. A plain insert would
-- fail with 23505; insert ... on conflict do nothing and a re-read return
-- the winner's row.
reset role;
create function public.test_insert_race_winner()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1
     and new.attempt_id = current_setting('test.race_b')::uuid then
    insert into public.attempt_answers
      (attempt_id, question_id, selected_answer_ids, is_correct, points)
    values (new.attempt_id, new.question_id,
            '{a0000000-0000-0000-0000-000000000112}', false, 0.00);
  end if;
  return new;
end;
$$;
create trigger test_insert_race_winner
  before insert on public.attempt_answers
  for each row execute function public.test_insert_race_winner();
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.race_b')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000111}') $$,
  $$ values (false, '0.00', '{a0000000-0000-0000-0000-000000000111}'::uuid[],
             'Der Himmel ist blau.') $$,
  'a first submission that loses a concurrent race returns the winner''s row'
);

select results_eq(
  $$ select selected_answer_ids, is_correct, points::text from public.attempt_answers
     where attempt_id = current_setting('test.race_b')::uuid
       and question_id = 'e0000000-0000-0000-0000-000000000011' $$,
  $$ values ('{a0000000-0000-0000-0000-000000000112}'::uuid[], false, '0.00') $$,
  'the losing submission stores nothing: the winner''s row is the only one'
);

select results_eq(
  $$ select score::text, finished_at is null from public.attempts
     where id = current_setting('test.race_b')::uuid $$,
  $$ values ('0.00', true) $$,
  'the losing submission changes neither score nor finished_at'
);

reset role;
drop trigger test_insert_race_winner on public.attempt_answers;
drop function public.test_insert_race_winner();

-- A security invoker helper, so submit_answer is called as the learner, that
-- returns what a client sees of the error: message, detail and hint.
create function public.test_submit_answer_error(p_attempt uuid, p_question uuid, p_answers uuid[])
returns table (message text, detail text, hint text)
language plpgsql
as $$
declare
  m text;
  d text;
  h text;
begin
  perform * from public.submit_answer(p_attempt, p_question, p_answers);
  return query select 'no error'::text, null::text, null::text;
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail, h = pg_exception_hint;
  return query select m, d, h;
end;
$$;
grant execute on function public.test_submit_answer_error(uuid, uuid, uuid[]) to authenticated;

-- Gone or unpublished quizzes ---------------------------------------------

update public.quizzes set published = false where id = 'd0000000-0000-0000-0000-000000000003';
delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000004';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select is_correct, points::text
     from public.submit_answer(current_setting('test.unpub')::uuid,
       'e0000000-0000-0000-0000-000000000031', '{a0000000-0000-0000-0000-000000000311}') $$,
  $$ values (true, '1.00') $$,
  'an attempt started before its quiz was unpublished can still be answered'
);

select results_eq(
  $$ select score::text, finished_at is not null from public.attempts
     where id = current_setting('test.unpub')::uuid $$,
  $$ values ('1.00', true) $$,
  'an attempt started before its quiz was unpublished can still be finished'
);

-- One rejection at the attempt check (bob's attempt) and one at the answer
-- check (an answer id of another quiz's question on alice's own attempt).
select results_eq(
  $$ select * from public.test_submit_answer_error(current_setting('test.bob')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000211}')
     union all
     select * from public.test_submit_answer_error(current_setting('test.a5')::uuid,
       'e0000000-0000-0000-0000-000000000011', '{a0000000-0000-0000-0000-000000000211}') $$,
  $$ values ('not available', '', ''), ('not available', '', '') $$,
  'no ids are echoed: a rejection has the message ''not available'' and no detail or hint'
);

-- Deleting the quiz cascades to its questions, so this proves the null
-- quiz_id path raises 'not available' but can't tell it apart from "the
-- question is not in the attempt's quiz".
select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.deleted')::uuid,
       'e0000000-0000-0000-0000-000000000041', '{a0000000-0000-0000-0000-000000000411}') $$,
  'P0001', 'not available',
  'an attempt whose quiz was deleted is not available'
);

select results_eq(
  $$ select quiz_id is null, score::text, finished_at is null,
            (select count(*)::int from public.attempt_answers
             where attempt_id = current_setting('test.deleted')::uuid)
     from public.attempts where id = current_setting('test.deleted')::uuid $$,
  $$ values (true, '0.00', true, 0) $$,
  'the attempt of a deleted quiz is left unchanged and without answers'
);

reset role;

-- anonymous user (guest) --------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select set_config('test.guest', public.start_attempt('d0000000-0000-0000-0000-000000000002')::text, true);

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.guest')::uuid,
       'e0000000-0000-0000-0000-000000000021', '{a0000000-0000-0000-0000-000000000211}') $$,
  $$ values (true, '1.00', '{a0000000-0000-0000-0000-000000000211}'::uuid[],
             'Katzen haben vier Beine.') $$,
  'an anonymous user can submit an answer on their own attempt'
);

select results_eq(
  $$ select score::text, finished_at is not null from public.attempts
     where id = current_setting('test.guest')::uuid $$,
  $$ values ('1.00', true) $$,
  'the anonymous user''s one-question attempt is finished with score 1.00'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.sep')::uuid,
       'e0000000-0000-0000-0000-000000000013', '{a0000000-0000-0000-0000-000000000131}') $$,
  'P0001', 'not available',
  'an anonymous user gets ''not available'' on another user''s attempt'
);

reset role;

-- admin (carol), treated like a learner in phase 1 ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select set_config('test.admin', public.start_attempt('d0000000-0000-0000-0000-000000000002')::text, true);

select results_eq(
  $$ select is_correct, points::text, correct_answer_ids, explanation
     from public.submit_answer(current_setting('test.admin')::uuid,
       'e0000000-0000-0000-0000-000000000021', '{a0000000-0000-0000-0000-000000000212}') $$,
  $$ values (false, '0.00', '{a0000000-0000-0000-0000-000000000211}'::uuid[],
             'Katzen haben vier Beine.') $$,
  'an admin can submit an answer on their own attempt'
);

select throws_ok(
  $$ select * from public.submit_answer(current_setting('test.sep')::uuid,
       'e0000000-0000-0000-0000-000000000013', '{a0000000-0000-0000-0000-000000000131}') $$,
  'P0001', 'not available',
  'an admin gets ''not available'' on another user''s attempt in phase 1'
);

reset role;

-- Effects on other users' attempts, checked as the owner ------------------

select results_eq(
  $$ select question_id, selected_answer_ids, points::text from public.attempt_answers
     where attempt_id = current_setting('test.bob')::uuid $$,
  $$ values ('e0000000-0000-0000-0000-000000000011'::uuid,
             '{a0000000-0000-0000-0000-000000000112}'::uuid[], '0.00') $$,
  'calls by others on bob''s attempt stored nothing and changed nothing'
);

select results_eq(
  $$ select question_id from public.attempt_answers
     where attempt_id = current_setting('test.sep')::uuid $$,
  $$ values ('e0000000-0000-0000-0000-000000000011'::uuid) $$,
  'calls by others on alice''s attempt stored nothing'
);

select * from finish();
rollback;
