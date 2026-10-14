-- When a quiz may be published (#82): not while it has no questions, and
-- not while one of its questions breaks the answer rules (at least two
-- answers, at least one correct, exactly one for single choice; see
-- question_rules.test.sql). A refusal is SQLSTATE 23514 (check_violation),
-- checked by deferred constraint triggers at the end of the transaction.
--
-- Refused: inserting a quiz with published = true (it has no questions
-- yet), publishing a quiz without questions or with a question that breaks
-- the rules, and deleting the last question of a published quiz (the quiz
-- is not silently unpublished). Accepted: publishing a quiz whose questions
-- all keep the rules, unpublishing, deleting one of several questions, and
-- deleting a published quiz or its category (a quiz that is gone needs no
-- questions). Categories get no new rule: an empty one may be published.
--
-- The checks apply to new writes only. Rows written before this rule (the
-- hosted database may hold an empty published quiz or a question without
-- answers from #81) are modelled here by inserting them with triggers off
-- (session_replication_role = replica); they stay as they are, an edit of
-- such a published quiz's title is accepted, and it may be unpublished.
--
-- `supabase test db` rolls every file back, so pg_temp.checked() forces the
-- pending checks with `set constraints all immediate`, as a commit would.
-- Every fixture written with triggers on keeps the rules. Writes run as the
-- admin (carol). Fixtures are created here as the owner, independent of
-- seed.sql, and vanish on rollback.
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(27);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Leeres Thema', 2, false),
  ('c0000000-0000-0000-0000-000000000003', 'Zum Löschen', 3, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  -- published, two valid questions
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlicht mit zwei Fragen', 1, true),
  -- unpublished, one valid question
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Bereit zum Veröffentlichen', 2, false),
  -- unpublished, no questions
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001',
   'Leer', 3, false),
  -- published, one valid question
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlicht mit einer Frage', 5, true),
  -- published, in the category that is deleted
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000003',
   'Im gelöschten Thema', 1, true);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Eins?', false, 1),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'Zwei?', true, 2),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002', 'Drei?', false, 1),
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000005', 'Fünf?', false, 1),
  ('e0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000006', 'Sechs?', false, 1);

insert into public.answers (question_id, text, is_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000001', 'Nein', false, 2),
  ('e0000000-0000-0000-0000-000000000002', 'A', true, 1),
  ('e0000000-0000-0000-0000-000000000002', 'B', true, 2),
  ('e0000000-0000-0000-0000-000000000003', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000003', 'Nein', false, 2),
  ('e0000000-0000-0000-0000-000000000005', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000005', 'Nein', false, 2),
  ('e0000000-0000-0000-0000-000000000006', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000006', 'Nein', false, 2);

-- Rows from before the rules, written with triggers off: unpublished quizzes
-- whose question has no answers, a single-choice question with two correct
-- answers, or one with answers but none correct; and a published quiz
-- without questions.
set local session_replication_role = replica;

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001',
   'Mit kaputter Frage', 4, false),
  ('d0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000001',
   'Alt und leer veröffentlicht', 7, true),
  ('d0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000001',
   'Mit zwei richtigen bei Einfachauswahl', 8, false),
  ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001',
   'Mit keiner richtigen', 9, false);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004',
   'Ohne Antworten?', false, 1),
  ('e0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000008',
   'Zwei richtig?', false, 1),
  ('e0000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000009',
   'Keine richtig?', true, 1);

insert into public.answers (question_id, text, is_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000008', 'A', true, 1),
  ('e0000000-0000-0000-0000-000000000008', 'B', true, 2),
  ('e0000000-0000-0000-0000-000000000009', 'A', false, 1),
  ('e0000000-0000-0000-0000-000000000009', 'B', false, 2);

set local session_replication_role = origin;

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

-- admin (carol) -------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select lives_ok(
  $$ select pg_temp.checked('select 1') $$,
  'the fixtures keep the rules (positive control for the forced checks)'
);

-- Inserting -------------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.checked($q$
       insert into public.quizzes (category_id, title, published)
       values ('c0000000-0000-0000-0000-000000000001', 'Gleich veröffentlicht', true) $q$) $$,
  '23514', null,
  'inserting a published quiz, which has no questions yet, is refused'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       insert into public.quizzes (category_id, title, published)
       values ('c0000000-0000-0000-0000-000000000001', 'Neuer Entwurf', false) $q$) $$,
  'inserting an unpublished quiz without questions is accepted'
);

-- Publishing ------------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = true
       where id = 'd0000000-0000-0000-0000-000000000003' $q$) $$,
  '23514', null,
  'publishing a quiz without questions is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = true
       where id = 'd0000000-0000-0000-0000-000000000004' $q$) $$,
  '23514', null,
  'publishing a quiz with a question that has no answers is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = true
       where id = 'd0000000-0000-0000-0000-000000000008' $q$) $$,
  '23514', null,
  'publishing a quiz with a single-choice question that has two correct answers is refused'
);

select throws_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = true
       where id = 'd0000000-0000-0000-0000-000000000009' $q$) $$,
  '23514', null,
  'publishing a quiz with a question whose answers include no correct one is refused'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = true
       where id = 'd0000000-0000-0000-0000-000000000002' $q$) $$,
  'publishing a quiz whose questions keep the rules is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set title = 'Veröffentlicht, umbenannt'
       where id = 'd0000000-0000-0000-0000-000000000001' $q$) $$,
  'editing the title of a published quiz is accepted'
);

-- Rows from before the rule ---------------------------------------------------

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set title = 'Alt, umbenannt'
       where id = 'd0000000-0000-0000-0000-000000000007' $q$) $$,
  'editing the title of a quiz published without questions before the rule is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = false
       where id = 'd0000000-0000-0000-0000-000000000007' $q$) $$,
  'unpublishing a quiz published without questions before the rule is accepted'
);

-- Deleting questions and quizzes ------------------------------------------------

select throws_ok(
  $$ select pg_temp.checked($q$
       delete from public.questions where id = 'e0000000-0000-0000-0000-000000000005' $q$) $$,
  '23514', null,
  'deleting the last question of a published quiz is refused'
);

select results_eq(
  $$ select q.id, z.published from public.questions q
     join public.quizzes z on z.id = q.quiz_id
     where q.id = 'e0000000-0000-0000-0000-000000000005' $$,
  $$ values ('e0000000-0000-0000-0000-000000000005'::uuid, true) $$,
  'after the refused delete the question is still there and its quiz still published'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $q$) $$,
  'deleting one of two questions of a published quiz is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.questions where id = 'e0000000-0000-0000-0000-000000000004' $q$) $$,
  'deleting the last question of an unpublished quiz is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000005' $q$) $$,
  'deleting a published quiz with its questions is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.categories where id = 'c0000000-0000-0000-0000-000000000003' $q$) $$,
  'deleting a category with a published quiz in it is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.quizzes set published = false
       where id = 'd0000000-0000-0000-0000-000000000001' $q$) $$,
  'unpublishing a quiz is accepted'
);

select lives_ok(
  $$ select pg_temp.checked($q$
       delete from public.questions where quiz_id = 'd0000000-0000-0000-0000-000000000001' $q$) $$,
  'once unpublished, the quiz''s last question may be deleted'
);

-- Categories --------------------------------------------------------------------

select lives_ok(
  $$ select pg_temp.checked($q$
       update public.categories set published = true
       where id = 'c0000000-0000-0000-0000-000000000002' $q$) $$,
  'publishing a category without quizzes is accepted (no rule for categories)'
);

reset role;

-- Effects, checked as the owner ---------------------------------------------------

select results_eq(
  $$ select id, published from public.quizzes
     where id in ('d0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000003',
                  'd0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000007',
                  'd0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000009')
     order by id $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid, true),
            ('d0000000-0000-0000-0000-000000000003'::uuid, false),
            ('d0000000-0000-0000-0000-000000000004'::uuid, false),
            ('d0000000-0000-0000-0000-000000000007'::uuid, false),
            ('d0000000-0000-0000-0000-000000000008'::uuid, false),
            ('d0000000-0000-0000-0000-000000000009'::uuid, false) $$,
  'only the quiz that keeps the rules was published; the refused ones stay unpublished'
);

select is_empty(
  $$ select 1 from public.quizzes where title = 'Gleich veröffentlicht' $$,
  'the refused published insert left no quiz behind'
);

select results_eq(
  $$ select title, published from public.quizzes where title = 'Neuer Entwurf' $$,
  $$ values ('Neuer Entwurf'::text, false) $$,
  'the unpublished insert is stored'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000005' $$,
  'the deleted published quiz is gone'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000005' $$,
  'its last question went with the quiz'
);

select is_empty(
  $$ select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-000000000006' $$,
  'the quiz of the deleted category is gone'
);

select results_eq(
  $$ select published from public.categories where id = 'c0000000-0000-0000-0000-000000000002' $$,
  $$ values (true) $$,
  'the empty category was published'
);

select * from finish();
rollback;
