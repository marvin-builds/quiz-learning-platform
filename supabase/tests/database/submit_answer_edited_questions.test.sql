-- submit_answer() keeps scoring correctly for questions the admin writes
-- through save_question() (#82). A single-choice and a multiple-choice
-- question are created through save_question, the quiz is published, and a
-- learner's answers are scored against the current is_correct flags. Then
-- the admin edits which answers are correct (allowed while attempts have
-- recorded answers): a new attempt is scored against the new flags, and an
-- answer stored before the edit keeps its points and is_correct (the stored
-- row wins), while correct_answer_ids show the current flags.
-- submit_answer.test.sql has the function's other rules. Points are compared
-- as text so the scale (2 decimals) is pinned. Fixtures are created here as
-- the owner, independent of seed.sql, and vanish on rollback.
begin;
select plan(14);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Neu angelegt', 1, false);

-- Runs a statement and fires every pending deferred check, as a commit
-- would, then defers them again.
create function pg_temp.checked(statement text)
returns void
language plpgsql
as $fn$
begin
  execute statement;
  set constraints all immediate;
  set constraints all deferred;
end;
$fn$;

grant execute on function pg_temp.checked(text) to authenticated;

-- An answer's id by its question's and its own text, read as the owner, or
-- null while the question doesn't exist.
create function pg_temp.answer(question_text text, answer_text text)
returns uuid
language sql
stable
as $fn$
  select a.id from public.answers a
  join public.questions q on q.id = a.question_id
  where q.text = question_text and a.text = answer_text
$fn$;

grant execute on function pg_temp.answer(text, text) to authenticated;

create function pg_temp.question(question_text text)
returns uuid
language sql
stable
as $fn$
  select q.id from public.questions q where q.text = question_text
$fn$;

grant execute on function pg_temp.question(text) to authenticated;

-- admin (carol) writes the quiz ----------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
       text => 'Was ist die Hauptstadt von Italien?', explanation => 'Rom.',
       multiple_correct => false,
       answers => '[{"text": "Mailand", "is_correct": false},
                    {"text": "Rom", "is_correct": true},
                    {"text": "Neapel", "is_correct": false}]') $$,
  'the admin saves a single-choice question with its answers'
);

select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
       text => 'Welche Städte liegen an der Donau?', explanation => null,
       multiple_correct => true,
       answers => '[{"text": "Wien", "is_correct": true},
                    {"text": "Prag", "is_correct": false},
                    {"text": "Budapest", "is_correct": true}]') $$,
  'the admin saves a multiple-choice question with two correct answers'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = true
       where id = 'd0000000-0000-0000-0000-000000000001' $q$) $$,
  'the admin publishes the quiz'
);

reset role;

-- alice answers before the edit -------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select set_config('test.alice',
  coalesce(public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, ''), true)
where pg_temp.question('Was ist die Hauptstadt von Italien?') is not null;

select results_eq(
  $$ select s.is_correct, s.points::text, s.correct_answer_ids
     from public.submit_answer(
       nullif(current_setting('test.alice', true), '')::uuid,
       pg_temp.question('Was ist die Hauptstadt von Italien?'),
       array[pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Rom')]) s $$,
  $$ select true, '1.00'::text,
            array[pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Rom')] $$,
  'the single-choice question scores its correct answer with 1 point'
);

select results_eq(
  $$ select s.is_correct, s.points::text, s.correct_answer_ids
     from public.submit_answer(
       nullif(current_setting('test.alice', true), '')::uuid,
       pg_temp.question('Welche Städte liegen an der Donau?'),
       array[pg_temp.answer('Welche Städte liegen an der Donau?', 'Wien')]) s $$,
  $$ select false, '0.50'::text,
            array[pg_temp.answer('Welche Städte liegen an der Donau?', 'Wien'),
                  pg_temp.answer('Welche Städte liegen an der Donau?', 'Budapest')] $$,
  'the multiple-choice question scores one of its two correct answers with 0.50 points'
);

reset role;

-- carol edits the correct answers -------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => pg_temp.question('Was ist die Hauptstadt von Italien?'),
       text => 'Was ist die Hauptstadt von Italien?', explanation => 'Rom.',
       multiple_correct => false,
       answers => jsonb_build_array(
         jsonb_build_object('id', pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Mailand'),
                            'text', 'Mailand', 'is_correct', true),
         jsonb_build_object('id', pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Rom'),
                            'text', 'Rom', 'is_correct', false),
         jsonb_build_object('id', pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Neapel'),
                            'text', 'Neapel', 'is_correct', false))) $$,
  'the admin moves the correct mark of a question with recorded answers to another answer'
);

select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => pg_temp.question('Welche Städte liegen an der Donau?'),
       text => 'Welche Städte liegen an der Donau?', explanation => null,
       multiple_correct => true,
       answers => jsonb_build_array(
         jsonb_build_object('id', pg_temp.answer('Welche Städte liegen an der Donau?', 'Wien'),
                            'text', 'Wien', 'is_correct', true),
         jsonb_build_object('id', pg_temp.answer('Welche Städte liegen an der Donau?', 'Prag'),
                            'text', 'Prag', 'is_correct', true),
         jsonb_build_object('id', pg_temp.answer('Welche Städte liegen an der Donau?', 'Budapest'),
                            'text', 'Budapest', 'is_correct', true))) $$,
  'the admin marks a third answer of the multiple-choice question as correct'
);

select lives_ok(
  $$ select pg_temp.checked('select 1') $$,
  'the edited quiz keeps the rules'
);

reset role;

-- alice's stored answers win ------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select s.is_correct, s.points::text, s.correct_answer_ids
     from public.submit_answer(
       nullif(current_setting('test.alice', true), '')::uuid,
       pg_temp.question('Was ist die Hauptstadt von Italien?'),
       array[pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Mailand')]) s $$,
  $$ select true, '1.00'::text,
            array[pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Mailand')] $$,
  'an answer stored before the edit keeps its points and is_correct; the correct ids are the current ones'
);

reset role;

select results_eq(
  $$ select aa.is_correct, aa.points::text from public.attempt_answers aa
     where aa.attempt_id = nullif(current_setting('test.alice', true), '')::uuid
     order by aa.points desc $$,
  $$ values (true, '1.00'::text), (false, '0.50'::text) $$,
  'the edit left the stored rows of the earlier attempt unchanged'
);

select results_eq(
  $$ select score::text from public.attempts
     where id = nullif(current_setting('test.alice', true), '')::uuid $$,
  $$ values ('1.50'::text) $$,
  'the earlier attempt''s score is the sum of its stored points'
);

-- bob answers after the edit --------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}', true);

select set_config('test.bob',
  coalesce(public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, ''), true)
where pg_temp.question('Was ist die Hauptstadt von Italien?') is not null;

select results_eq(
  $$ select s.is_correct, s.points::text
     from public.submit_answer(
       nullif(current_setting('test.bob', true), '')::uuid,
       pg_temp.question('Was ist die Hauptstadt von Italien?'),
       array[pg_temp.answer('Was ist die Hauptstadt von Italien?', 'Rom')]) s $$,
  $$ values (false, '0.00'::text) $$,
  'after the edit the formerly correct answer scores 0 points'
);

select results_eq(
  $$ select s.is_correct, s.points::text
     from public.submit_answer(
       nullif(current_setting('test.bob', true), '')::uuid,
       pg_temp.question('Welche Städte liegen an der Donau?'),
       array[pg_temp.answer('Welche Städte liegen an der Donau?', 'Wien')]) s $$,
  $$ values (false, '0.33'::text) $$,
  'after the edit one of three correct answers scores 0.33 points'
);

reset role;

select results_eq(
  $$ select score::text, finished_at is not null from public.attempts
     where id = nullif(current_setting('test.bob', true), '')::uuid $$,
  $$ values ('0.33'::text, true) $$,
  'the later attempt is finished with the score of the current flags'
);

select * from finish();
rollback;
