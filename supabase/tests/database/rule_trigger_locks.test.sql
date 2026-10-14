-- The deferred rule triggers lock the row they check (security review #37,
-- finding D1). Without a lock, two transactions can each pass a rule check
-- on a snapshot that misses the other's write and both commit (write skew):
-- two admins deleting the two questions of a published quiz leave it empty,
-- two admins deleting two of three answers leave one.
--
-- So internal.check_quiz_publish_rules() locks the quiz row and
-- internal.check_question_rules() the question row, FOR NO KEY UPDATE: a
-- lock that conflicts with itself (FOR SHARE wouldn't: two deletes would both
-- get it) and with the UPDATE that publishes a quiz, but not with the FOR KEY
-- SHARE that foreign key checks take (FOR UPDATE would block every
-- start_attempt and question insert of the quiz). That the lock closes the
-- race, and is taken before the check rather than in the same statement, is
-- shown by the two-session test rule_trigger_races.test.sql.
--
-- submit_answer (finding D3) locks the quiz row and its category row FOR
-- SHARE before it checks the quiz is visible: a lock that waits for an
-- admin's unpublish (an UPDATE) but not for another learner's answer (two
-- FOR SHARE locks don't conflict), so learners don't queue behind each other.
--
-- How: pending checks fire with `set constraints all immediate`, as a commit
-- would. The writes run at the top level, not inside a pgTAP assertion, so
-- the locks belong to this transaction and not a subtransaction. pgrowlocks
-- (created here, gone on rollback) reports the row locks and their modes.
-- Fixtures are created as the owner, independent of seed.sql, with triggers
-- off (session_replication_role = replica; they keep the rules anyway), so
-- no check of theirs is pending and every lock seen comes from the write
-- under test. Writes run as the admin (carol), the answer as the learner
-- (dave).
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(11);

create extension pgrowlocks;

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'dave@example.test');

set local session_replication_role = replica;

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-0000000000a1', 'Sperrthema', 1, false),
  -- published: its quiz is answered through submit_answer
  ('c0000000-0000-0000-0000-0000000000a2', 'Sperrthema, sichtbar', 2, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  -- published, two questions: one of them is deleted
  ('d0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-0000000000a1',
   'Veröffentlicht mit zwei Fragen', 1, true),
  -- unpublished, untouched: its row must stay unlocked
  ('d0000000-0000-0000-0000-0000000000a2', 'c0000000-0000-0000-0000-0000000000a1',
   'Entwurf', 2, false),
  -- unpublished, its questions' answers are written
  ('d0000000-0000-0000-0000-0000000000a3', 'c0000000-0000-0000-0000-0000000000a1',
   'Antwortentwurf', 3, false),
  -- published in a published category: the learner answers it
  ('d0000000-0000-0000-0000-0000000000a4', 'c0000000-0000-0000-0000-0000000000a2',
   'Sichtbar', 1, true);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1', 'Eins?', false, 1),
  ('e0000000-0000-0000-0000-0000000000a2', 'd0000000-0000-0000-0000-0000000000a1', 'Zwei?', false, 2),
  ('e0000000-0000-0000-0000-0000000000a3', 'd0000000-0000-0000-0000-0000000000a2', 'Drei?', false, 1),
  -- one question per kind of answer write
  ('e0000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000a3', 'Löschen?', true, 1),
  ('e0000000-0000-0000-0000-0000000000b2', 'd0000000-0000-0000-0000-0000000000a3', 'Ändern?', true, 2),
  ('e0000000-0000-0000-0000-0000000000b3', 'd0000000-0000-0000-0000-0000000000a3', 'Einfügen?', true, 3),
  ('e0000000-0000-0000-0000-0000000000c1', 'd0000000-0000-0000-0000-0000000000a4', 'Sichtbar?', false, 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-0000000000a1', 'e0000000-0000-0000-0000-0000000000a1', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-0000000000a2', 'e0000000-0000-0000-0000-0000000000a1', 'Nein', false, 2),
  ('a0000000-0000-0000-0000-0000000000a3', 'e0000000-0000-0000-0000-0000000000a2', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-0000000000a4', 'e0000000-0000-0000-0000-0000000000a2', 'Nein', false, 2),
  ('a0000000-0000-0000-0000-0000000000a5', 'e0000000-0000-0000-0000-0000000000a3', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-0000000000a6', 'e0000000-0000-0000-0000-0000000000a3', 'Nein', false, 2),
  ('a0000000-0000-0000-0000-0000000000b1', 'e0000000-0000-0000-0000-0000000000b1', 'A', true, 1),
  ('a0000000-0000-0000-0000-0000000000b2', 'e0000000-0000-0000-0000-0000000000b1', 'B', true, 2),
  ('a0000000-0000-0000-0000-0000000000b3', 'e0000000-0000-0000-0000-0000000000b1', 'C', false, 3),
  ('a0000000-0000-0000-0000-0000000000b4', 'e0000000-0000-0000-0000-0000000000b2', 'A', true, 1),
  ('a0000000-0000-0000-0000-0000000000b5', 'e0000000-0000-0000-0000-0000000000b2', 'B', true, 2),
  ('a0000000-0000-0000-0000-0000000000b6', 'e0000000-0000-0000-0000-0000000000b2', 'C', false, 3),
  ('a0000000-0000-0000-0000-0000000000b7', 'e0000000-0000-0000-0000-0000000000b3', 'A', true, 1),
  ('a0000000-0000-0000-0000-0000000000b8', 'e0000000-0000-0000-0000-0000000000b3', 'B', false, 2),
  ('a0000000-0000-0000-0000-0000000000c1', 'e0000000-0000-0000-0000-0000000000c1', 'Ja', true, 1),
  ('a0000000-0000-0000-0000-0000000000c2', 'e0000000-0000-0000-0000-0000000000c1', 'Nein', false, 2);

insert into public.attempts (id, user_id, quiz_id, max_score) values
  ('f0000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444',
   'd0000000-0000-0000-0000-0000000000a4', 1);

set local session_replication_role = origin;

-- This transaction's lock modes on one row of a table with an id column, as
-- pgrowlocks reports them; null when this transaction holds no lock on it.
create function pg_temp.my_lock_modes(tbl regclass, row_id uuid)
returns text[]
language plpgsql
as $fn$
declare
  result text[];
begin
  execute format(
    'select l.modes from pgrowlocks(%L) l join %s t on t.ctid = l.locked_row
     where t.id = $1 and pg_current_xact_id()::xid = any (l.xids)',
    tbl::text, tbl)
  into result
  using row_id;
  return result;
end;
$fn$;

-- Positive control for the helper: a lock taken by hand is reported.
select id from public.quizzes where id = 'd0000000-0000-0000-0000-0000000000a2' for share;

select is(
  pg_temp.my_lock_modes('public.quizzes', 'd0000000-0000-0000-0000-0000000000a2'),
  array['For Share'],
  'the helper reports a row lock this transaction took (positive control)'
);

-- The quiz rule: deleting a question of a published quiz --------------------

select is(
  pg_temp.my_lock_modes('public.quizzes', 'd0000000-0000-0000-0000-0000000000a1'),
  null::text[],
  'before the delete, the published quiz''s row is not locked'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

delete from public.questions where id = 'e0000000-0000-0000-0000-0000000000a2';
set constraints all immediate;
set constraints all deferred;

reset role;

select is(
  pg_temp.my_lock_modes('public.quizzes', 'd0000000-0000-0000-0000-0000000000a1'),
  array['For No Key Update'],
  'checking a question delete locks the quiz row FOR NO KEY UPDATE (not FOR SHARE, not FOR UPDATE)'
);

select ok(
  exists (select 1 from public.quizzes where id = 'd0000000-0000-0000-0000-0000000000a1' and published),
  'the quiz with one question left is still published (the check passed)'
);

-- The question rule: every kind of answer write -----------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

-- One write per question, so each question's lock comes from its write.
delete from public.answers where id = 'a0000000-0000-0000-0000-0000000000b3';
update public.answers set is_correct = false where id = 'a0000000-0000-0000-0000-0000000000b5';
insert into public.answers (question_id, text, is_correct)
  values ('e0000000-0000-0000-0000-0000000000b3', 'C', false);
set constraints all immediate;
set constraints all deferred;

reset role;

select is(
  pg_temp.my_lock_modes('public.questions', 'e0000000-0000-0000-0000-0000000000b1'),
  array['For No Key Update'],
  'checking an answer delete locks the question row FOR NO KEY UPDATE'
);

select is(
  pg_temp.my_lock_modes('public.questions', 'e0000000-0000-0000-0000-0000000000b2'),
  array['For No Key Update'],
  'checking an answer update locks the question row FOR NO KEY UPDATE'
);

select is(
  pg_temp.my_lock_modes('public.questions', 'e0000000-0000-0000-0000-0000000000b3'),
  array['For No Key Update'],
  'checking an answer insert locks the question row FOR NO KEY UPDATE'
);

-- Untouched rows stay unlocked: the triggers lock only what they check.
select is(
  pg_temp.my_lock_modes('public.quizzes', 'd0000000-0000-0000-0000-0000000000a3'),
  null::text[],
  'answer writes don''t lock the quiz of their question'
);

-- Cascades: deleting a question deletes its answers, whose checks find the
-- question gone and need nothing (no lock, no error).
select lives_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-0000000000a3';
     set constraints all immediate;
     set constraints all deferred; $$,
  'deleting a question with its answers still passes the checks'
);

-- submit_answer: the quiz and its category, FOR SHARE ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated"}', true);

select count(*) from public.submit_answer(
  'f0000000-0000-0000-0000-0000000000a1', 'e0000000-0000-0000-0000-0000000000c1',
  array['a0000000-0000-0000-0000-0000000000c1']::uuid[]);

reset role;

select is(
  pg_temp.my_lock_modes('public.quizzes', 'd0000000-0000-0000-0000-0000000000a4'),
  array['For Share'],
  'an answer locks its quiz row FOR SHARE (not FOR NO KEY UPDATE, not FOR UPDATE)'
);

select is(
  pg_temp.my_lock_modes('public.categories', 'c0000000-0000-0000-0000-0000000000a2'),
  array['For Share'],
  'an answer locks its quiz''s category row FOR SHARE (not FOR NO KEY UPDATE, not FOR UPDATE)'
);

select * from finish();
rollback;
