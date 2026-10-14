-- The rules a question's answers must keep (#82), enforced in the database
-- and not only in the form: a question has at least two answers and at least
-- one correct one, and a single-choice question (multiple_correct = false)
-- has exactly one. A refusal is SQLSTATE 23514 (check_violation).
--
-- Answers are written row by row, so the rules are checked by deferred
-- constraint triggers at the end of the transaction, on questions (insert,
-- and update of multiple_correct) and on answers (insert, update, delete):
-- a transaction may pass through a state that breaks them, as long as it
-- ends in one that keeps them. save_question() (save_question.test.sql)
-- writes a question with its answers in one transaction for the editor; the
-- triggers are the backstop for direct table writes. A question that is
-- gone by the end of the transaction needs no answers, so deleting a
-- question or its quiz (whose foreign keys cascade) is never refused.
--
-- `supabase test db` rolls every file back, so a deferred check never fires
-- on its own here: pg_temp.checked() runs a statement and then forces every
-- pending check with `set constraints all immediate`, as a commit would.
-- Every fixture keeps the rules, so the forced checks can't fail because of
-- them; the first assertion shows that. Writes run as the admin (carol), the
-- only role that may write answers. Fixtures are created here as the owner,
-- independent of seed.sql, and vanish on rollback.
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(35);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Thema', 1, false);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 1, false),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Zum Löschen', 2, false);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  -- single choice, three answers
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Was ist die Hauptstadt von Frankreich?', false, 1),
  -- multiple choice, two correct answers of three
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'Welche Städte liegen an der Donau?', true, 2),
  -- single choice, exactly two answers
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001',
   'Ist die Erde rund?', false, 3),
  -- multiple choice, exactly one correct answer: may become single choice
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001',
   'Welcher Fluss fließt durch Wien?', true, 4),
  -- in the quiz that is deleted at the end
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002',
   'Wird mitgelöscht?', false, 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Paris', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'Lyon', false, 2),
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'Marseille', false, 3),
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000002', 'Wien', true, 1),
  ('a0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000002', 'Prag', false, 2),
  ('a0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000002', 'Budapest', true, 3),
  ('a0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000003', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000000003', 'Nein', false, 2),
  ('a0000000-0000-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000004', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000004', 'Nein', false, 2),
  ('a0000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000005', 'Donau', true, 1),
  ('a0000000-0000-0000-0000-000000000012', 'e0000000-0000-0000-0000-000000000005', 'Rhein', false, 2);

-- Runs a statement and fires every pending deferred check, as a commit
-- would, then defers them again. A refusal rolls the statement back (the
-- assertion's own subtransaction).
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

-- The stored answers of a question, as 'text:is_correct' by sort_order.
create function pg_temp.answers_of(question uuid)
returns text
language sql
as $fn$
  select coalesce(string_agg(a.text || ':' || a.is_correct, ', ' order by a.sort_order), '')
  from public.answers a
  where a.question_id = question
$fn$;

-- The triggers (catalog) ----------------------------------------------------

-- Deferrable, initially deferred constraint triggers whose function lives in
-- schema internal and no API role may execute. tgtype's bits: 4 insert,
-- 8 delete, 16 update; one trigger or several per table.
create temporary view rule_triggers as
  select c.relname::text collate "default" as table_name, t.tgtype
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = p.pronamespace
  where t.tgrelid in ('public.answers'::regclass, 'public.questions'::regclass)
    and not t.tgisinternal
    and t.tgconstraint <> 0
    and t.tgdeferrable and t.tginitdeferred
    and n.nspname = 'internal'
    and not has_function_privilege('anon', t.tgfoid, 'execute')
    and not has_function_privilege('authenticated', t.tgfoid, 'execute');

select ok(
  coalesce((
    select bool_or(tgtype & 4 <> 0) and bool_or(tgtype & 8 <> 0) and bool_or(tgtype & 16 <> 0)
    from pg_temp.rule_triggers where table_name = 'answers'
  ), false),
  'answers has deferred constraint triggers after insert, update and delete, run by functions in schema internal'
);

select ok(
  coalesce((
    select bool_or(tgtype & 4 <> 0) and bool_or(tgtype & 16 <> 0)
    from pg_temp.rule_triggers where table_name = 'questions'
  ), false),
  'questions has deferred constraint triggers after insert and update, run by functions in schema internal'
);

-- admin (carol) -------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select lives_ok(
  $$ select pg_temp.checked('select 1') $$,
  'the fixtures keep the rules (positive control for the forced checks)'
);

-- New questions ---------------------------------------------------------------

select lives_ok(
  $$ select pg_temp.checked($q$
       with q as (
         insert into public.questions (quiz_id, text, multiple_correct)
         values ('d0000000-0000-0000-0000-000000000001', 'Gültig?', false)
         returning id)
       insert into public.answers (question_id, text, is_correct)
       select q.id, x.text, x.is_correct
       from q, (values ('Ja', true), ('Nein', false)) as x(text, is_correct) $q$) $$,
  'a new single-choice question with two answers, one correct, is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       with q as (
         insert into public.questions (quiz_id, text, multiple_correct)
         values ('d0000000-0000-0000-0000-000000000001', 'Mehrere gültig?', true)
         returning id)
       insert into public.answers (question_id, text, is_correct)
       select q.id, x.text, x.is_correct
       from q, (values ('A', true), ('B', true), ('C', false)) as x(text, is_correct) $q$) $$,
  'a new multiple-choice question with two correct answers of three is accepted'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       insert into public.questions (quiz_id, text)
       values ('d0000000-0000-0000-0000-000000000001', 'Ohne Antworten?') $q$) $$,
  '23514', null,
  'a new question without answers is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       with q as (
         insert into public.questions (quiz_id, text, multiple_correct)
         values ('d0000000-0000-0000-0000-000000000001', 'Eine Antwort?', false)
         returning id)
       insert into public.answers (question_id, text, is_correct)
       select q.id, 'Ja', true from q $q$) $$,
  '23514', null,
  'a new question with only one answer is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       with q as (
         insert into public.questions (quiz_id, text, multiple_correct)
         values ('d0000000-0000-0000-0000-000000000001', 'Keine richtig?', true)
         returning id)
       insert into public.answers (question_id, text, is_correct)
       select q.id, x.text, x.is_correct
       from q, (values ('A', false), ('B', false)) as x(text, is_correct) $q$) $$,
  '23514', null,
  'a new question without a correct answer is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       with q as (
         insert into public.questions (quiz_id, text, multiple_correct)
         values ('d0000000-0000-0000-0000-000000000001', 'Zwei richtig?', false)
         returning id)
       insert into public.answers (question_id, text, is_correct)
       select q.id, x.text, x.is_correct
       from q, (values ('A', true), ('B', true)) as x(text, is_correct) $q$) $$,
  '23514', null,
  'a new single-choice question with two correct answers is refused'
);

-- Answers of an existing question -----------------------------------------------

select throws_ok(
  $$ select pg_temp.checked($q$
       insert into public.answers (question_id, text, is_correct)
       values ('e0000000-0000-0000-0000-000000000001', 'Nizza', true) $q$) $$,
  '23514', null,
  'adding a second correct answer to a single-choice question is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.answers set is_correct = true
       where id = 'a0000000-0000-0000-0000-000000000002' $q$) $$,
  '23514', null,
  'marking a second answer of a single-choice question as correct is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.answers set is_correct = false
       where id = 'a0000000-0000-0000-0000-000000000001' $q$) $$,
  '23514', null,
  'unmarking the only correct answer of a single-choice question is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.answers set is_correct = false
       where question_id = 'e0000000-0000-0000-0000-000000000002' $q$) $$,
  '23514', null,
  'unmarking every correct answer of a multiple-choice question is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       delete from public.answers where id = 'a0000000-0000-0000-0000-000000000008' $q$) $$,
  '23514', null,
  'deleting an answer so that one is left is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       delete from public.answers where question_id = 'e0000000-0000-0000-0000-000000000001' $q$) $$,
  '23514', null,
  'deleting every answer of a question is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       delete from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $q$) $$,
  '23514', null,
  'deleting the only correct answer is refused'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.answers set text = 'Paris (Île-de-France)'
       where id = 'a0000000-0000-0000-0000-000000000001' $q$) $$,
  'changing an answer''s text is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.answers set is_correct = (id = 'a0000000-0000-0000-0000-000000000002')
       where question_id = 'e0000000-0000-0000-0000-000000000001' $q$) $$,
  'moving the correct mark of a single-choice question to another answer in one transaction is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.answers set is_correct = true
       where id = 'a0000000-0000-0000-0000-000000000005' $q$) $$,
  'marking a third answer of a multiple-choice question as correct is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $q$) $$,
  'deleting an answer so that two are left is accepted'
);

-- Switching between single and multiple choice ----------------------------------

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.questions set multiple_correct = false
       where id = 'e0000000-0000-0000-0000-000000000002' $q$) $$,
  '23514', null,
  'switching a question with more than one correct answer from multiple to single choice is refused'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.questions set multiple_correct = true
       where id = 'e0000000-0000-0000-0000-000000000003' $q$) $$,
  'switching a question from single to multiple choice is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.questions set multiple_correct = false
       where id = 'e0000000-0000-0000-0000-000000000005' $q$) $$,
  'switching a question with exactly one correct answer from multiple to single choice is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.questions set text = 'Ist die Erde eine Kugel?'
       where id = 'e0000000-0000-0000-0000-000000000003' $q$) $$,
  'changing a question''s text is accepted'
);

reset role;

select results_eq(
  $$ select multiple_correct from public.questions
     where id = 'e0000000-0000-0000-0000-000000000002' $$,
  $$ values (true) $$,
  'the refused switch left the question multiple choice, not silently changed'
);

select results_eq(
  $$ select multiple_correct from public.questions
     where id = 'e0000000-0000-0000-0000-000000000005' $$,
  $$ values (false) $$,
  'the accepted switch made the question with one correct answer single choice'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  'Wien:true, Prag:true, Budapest:true',
  'the refused switch left every correct mark as it was'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  'Paris (Île-de-France):false, Lyon:true',
  'only the accepted writes changed the single-choice question''s answers'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000003'),
  'Ja:true, Nein:false',
  'the refused delete left both answers of the two-answer question'
);

select is_empty(
  $$ select 1 from public.questions
     where text in ('Ohne Antworten?', 'Eine Antwort?', 'Keine richtig?', 'Zwei richtig?') $$,
  'the refused new questions left no row behind'
);

select is_empty(
  $$ select 1 from public.answers where text = 'Nizza' $$,
  'the refused new answer left no row behind'
);

-- Deletes that cascade ------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $q$) $$,
  'deleting a question with its answers is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000002' $q$) $$,
  'deleting a quiz with its questions and answers is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.categories where id = 'c0000000-0000-0000-0000-000000000001' $q$) $$,
  'deleting a category with its quizzes, questions and answers is accepted'
);

reset role;

select is_empty(
  $$ select 1 from public.answers
     where question_id in ('e0000000-0000-0000-0000-000000000003',
                           'e0000000-0000-0000-0000-000000000004') $$,
  'the deleted questions'' answers are gone with them'
);

select * from finish();
rollback;
