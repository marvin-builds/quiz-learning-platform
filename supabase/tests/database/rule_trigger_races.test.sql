-- Two transactions at once can't break the rules (security review #37,
-- findings D1 and D3). Each case runs two real sessions, `a` and `b`,
-- through dblink: `a` writes and passes its checks but doesn't commit yet;
-- `b` then does the conflicting write and its checks. Today `b` passes on a
-- snapshot that misses `a`'s write, and both commit (write skew). Fixed, `b`
-- waits for `a`'s row lock, then checks again with a fresh snapshot and is
-- refused. Each case asserts that `b` waits, that it is refused once `a`
-- commits, and what is stored afterwards.
--
-- D1, quiz rule: two deletes of the two questions of a published quiz, and
-- a publish against a delete of the quiz's only question.
-- D1, question rule (it applies to every question, published or not): two
-- deletes of two of three answers, and two updates setting is_correct =
-- false on the two correct answers of a multiple-choice question.
-- D3, submit_answer: a learner's answer while an admin unpublishes the quiz,
-- or its category, reveals nothing once the unpublish commits.
-- D3, deadlock path: submit_answer takes the quiz's locks before the
-- attempt's, the order of a quiz delete (quiz row, then the attempts its
-- cascade sets to null). A learner's answer while an admin deletes the quiz
-- is refused with 'not available' once the delete commits, never with a
-- deadlock (40P01), and stores nothing.
-- Guards: the quiz lock doesn't block the FOR KEY SHARE that foreign keys
-- take, so a learner can start an attempt on a quiz while an admin deletes
-- one of its questions (FOR UPDATE would make them wait); and submit_answer's
-- FOR SHARE locks don't conflict with each other, so two answers on
-- different attempts of one quiz don't wait for each other.
--
-- The interleaving is fixed by the test, not by timing: `b`'s check is sent
-- asynchronously and `a` commits only after a pause in which a non-blocking
-- check would long have finished. If `b` never waits, the commit order is
-- the same as with a lock, so the stored result shows the skew.
--
-- Sessions see only committed data, so the fixtures are committed through a
-- third session (`setup`) and deleted again at the start and the end; ids
-- start with f so they can't meet seed or other test data. Two of the
-- fixture categories are published (D3 needs a quiz a learner can play), so
-- a run that stops early must not leave them behind: when a statement of a
-- session raises (a lock timeout, a deadlock, a broken connection),
-- `pg_temp.abandon` cancels and closes `a` and `b`, so their open
-- transactions roll back and release their locks, deletes the fixtures
-- through `setup` and re-raises the error. Only a crash of the test run
-- itself can still leave them until the next run of this file. The D1 fixtures
-- sit in an unpublished category, so learners never see them. Writes of
-- `a` (the admin's side) run as the table owner: the rules are triggers, so
-- RLS doesn't matter for them. dblink (created here, gone on rollback)
-- connects to the same server with the local stack's well-known owner
-- password, over the address this test's own connection uses (the local
-- trust rules for 127.0.0.1 don't satisfy dblink). Every session waits at
-- most 5 seconds for a lock.
begin;
select plan(28);

create extension dblink;

-- Helpers -----------------------------------------------------------------

create function pg_temp.open(conn text)
returns void
language plpgsql
as $fn$
begin
  perform dblink_connect(conn, format(
    'host=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()), inet_server_port(), current_database()));
  perform dblink_exec(conn, 'set lock_timeout = ''5s''');
end;
$fn$;

create function pg_temp.cleanup()
returns void
language plpgsql
as $fn$
begin
  perform dblink_exec('setup', $sql$
    delete from auth.users where id = 'f5000000-0000-0000-0000-000000000001';
    delete from public.categories where id in (
      'f1000000-0000-0000-0000-000000000001',
      'f1000000-0000-0000-0000-000000000002',
      'f1000000-0000-0000-0000-000000000003')
  $sql$);
end;
$fn$;

-- After an error: ends the sessions `a` and `b` (their transactions roll
-- back), deletes the committed fixtures and leaves the error to the caller.
-- A failure of the cleanup itself only warns, so the original error wins.
create function pg_temp.abandon()
returns void
language plpgsql
as $fn$
declare
  conn text;
begin
  foreach conn in array array['a', 'b'] loop
    if conn = any (coalesce(dblink_get_connections(), '{}')) then
      begin
        if dblink_is_busy(conn) = 1 then
          perform dblink_cancel_query(conn);
        end if;
        perform dblink_disconnect(conn);
      exception when others then
        raise warning 'closing session % failed: %', conn, sqlerrm;
      end;
    end if;
  end loop;
  if 'setup' = any (coalesce(dblink_get_connections(), '{}')) then
    begin
      perform pg_temp.cleanup();
    exception when others then
      raise warning 'deleting the fixtures failed: %', sqlerrm;
    end;
  end if;
end;
$fn$;

-- Runs one statement in a session and waits for it. On an error it
-- abandons the run (see above) and re-raises.
create function pg_temp.run(conn text, statement text)
returns void
language plpgsql
as $fn$
begin
  perform dblink_exec(conn, statement);
exception when others then
  perform pg_temp.abandon();
  raise;
end;
$fn$;

-- Sends one statement to a session without waiting for it.
create function pg_temp.send(conn text, statement text)
returns void
language plpgsql
as $fn$
begin
  perform dblink_send_query(conn, statement);
exception when others then
  perform pg_temp.abandon();
  raise;
end;
$fn$;

-- Waits for the statement sent to a session and returns its error message,
-- or 'OK' when it succeeded.
create function pg_temp.outcome(conn text)
returns text
language plpgsql
as $fn$
declare
  message text;
begin
  perform * from dblink_get_result(conn, false) as t(x text);
  message := dblink_error_message(conn);
  perform * from dblink_get_result(conn, false) as t(x text);
  return message;
exception when others then
  perform pg_temp.abandon();
  raise;
end;
$fn$;

-- Whether the statement sent to a session is still running after a pause.
create function pg_temp.waits(conn text)
returns boolean
language plpgsql
as $fn$
begin
  perform pg_sleep(0.5);
  return dblink_is_busy(conn) = 1;
end;
$fn$;

select pg_temp.open('setup');
select pg_temp.open('a');
select pg_temp.open('b');

select pg_temp.cleanup();

-- Fixtures, committed -----------------------------------------------------

select pg_temp.run('setup', $sql$
  insert into public.categories (id, name, sort_order, published) values
    ('f1000000-0000-0000-0000-000000000001', 'Nebenläufig (Entwurf)', 901, false),
    ('f1000000-0000-0000-0000-000000000002', 'Nebenläufig', 902, true),
    ('f1000000-0000-0000-0000-000000000003', 'Nebenläufig, Thema', 903, true);

  insert into public.quizzes (id, category_id, title, sort_order, published) values
    -- D1: published, two questions
    ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001',
     'Zwei Fragen', 1, true),
    -- D1: unpublished, one question
    ('f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001',
     'Eine Frage', 2, false),
    -- D1: unpublished, the answer cases
    ('f2000000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000001',
     'Antworten', 3, false),
    -- D3: the quiz is unpublished
    ('f2000000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000002',
     'Sichtbar', 1, true),
    -- D3: its category is unpublished
    ('f2000000-0000-0000-0000-000000000005', 'f1000000-0000-0000-0000-000000000003',
     'Sichtbar im Thema', 1, true),
    -- Guard: start_attempt while a question is deleted
    ('f2000000-0000-0000-0000-000000000006', 'f1000000-0000-0000-0000-000000000002',
     'Drei Fragen', 2, true),
    -- D3: the quiz is deleted
    ('f2000000-0000-0000-0000-000000000007', 'f1000000-0000-0000-0000-000000000002',
     'Gelöscht', 3, true),
    -- Guard: two answers on two attempts of one quiz
    ('f2000000-0000-0000-0000-000000000008', 'f1000000-0000-0000-0000-000000000002',
     'Zwei Versuche', 4, true);

  insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
    ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Eins?', false, 1),
    ('f3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'Zwei?', false, 2),
    ('f3000000-0000-0000-0000-000000000003', 'f2000000-0000-0000-0000-000000000002', 'Drei?', false, 1),
    ('f3000000-0000-0000-0000-000000000004', 'f2000000-0000-0000-0000-000000000003', 'Löschen?', true, 1),
    ('f3000000-0000-0000-0000-000000000005', 'f2000000-0000-0000-0000-000000000003', 'Ändern?', true, 2),
    ('f3000000-0000-0000-0000-000000000006', 'f2000000-0000-0000-0000-000000000004', 'Sechs?', false, 1),
    ('f3000000-0000-0000-0000-000000000007', 'f2000000-0000-0000-0000-000000000005', 'Sieben?', false, 1),
    ('f3000000-0000-0000-0000-000000000008', 'f2000000-0000-0000-0000-000000000006', 'Acht?', false, 1),
    ('f3000000-0000-0000-0000-000000000009', 'f2000000-0000-0000-0000-000000000006', 'Neun?', false, 2),
    ('f3000000-0000-0000-0000-00000000000a', 'f2000000-0000-0000-0000-000000000006', 'Zehn?', false, 3),
    ('f3000000-0000-0000-0000-00000000000b', 'f2000000-0000-0000-0000-000000000007', 'Elf?', false, 1),
    ('f3000000-0000-0000-0000-00000000000c', 'f2000000-0000-0000-0000-000000000008', 'Zwölf?', false, 1);

  insert into public.answers (id, question_id, text, is_correct, sort_order) values
    ('f4000000-0000-0000-0000-000000000011', 'f3000000-0000-0000-0000-000000000001', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-000000000012', 'f3000000-0000-0000-0000-000000000001', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-000000000021', 'f3000000-0000-0000-0000-000000000002', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-000000000022', 'f3000000-0000-0000-0000-000000000002', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-000000000031', 'f3000000-0000-0000-0000-000000000003', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-000000000032', 'f3000000-0000-0000-0000-000000000003', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-000000000041', 'f3000000-0000-0000-0000-000000000004', 'A', true, 1),
    ('f4000000-0000-0000-0000-000000000042', 'f3000000-0000-0000-0000-000000000004', 'B', true, 2),
    ('f4000000-0000-0000-0000-000000000043', 'f3000000-0000-0000-0000-000000000004', 'C', false, 3),
    ('f4000000-0000-0000-0000-000000000051', 'f3000000-0000-0000-0000-000000000005', 'A', true, 1),
    ('f4000000-0000-0000-0000-000000000052', 'f3000000-0000-0000-0000-000000000005', 'B', true, 2),
    ('f4000000-0000-0000-0000-000000000053', 'f3000000-0000-0000-0000-000000000005', 'C', false, 3),
    ('f4000000-0000-0000-0000-000000000061', 'f3000000-0000-0000-0000-000000000006', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-000000000062', 'f3000000-0000-0000-0000-000000000006', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-000000000071', 'f3000000-0000-0000-0000-000000000007', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-000000000072', 'f3000000-0000-0000-0000-000000000007', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-000000000081', 'f3000000-0000-0000-0000-000000000008', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-000000000082', 'f3000000-0000-0000-0000-000000000008', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-000000000091', 'f3000000-0000-0000-0000-000000000009', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-000000000092', 'f3000000-0000-0000-0000-000000000009', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-0000000000a1', 'f3000000-0000-0000-0000-00000000000a', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-0000000000a2', 'f3000000-0000-0000-0000-00000000000a', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-0000000000b1', 'f3000000-0000-0000-0000-00000000000b', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-0000000000b2', 'f3000000-0000-0000-0000-00000000000b', 'Nein', false, 2),
    ('f4000000-0000-0000-0000-0000000000c1', 'f3000000-0000-0000-0000-00000000000c', 'Ja', true, 1),
    ('f4000000-0000-0000-0000-0000000000c2', 'f3000000-0000-0000-0000-00000000000c', 'Nein', false, 2);

  insert into auth.users (id, email) values
    ('f5000000-0000-0000-0000-000000000001', 'nebenlaeufig@example.test')
$sql$);

-- The learner's attempts, started after the questions exist.
select pg_temp.run('setup', $sql$
  insert into public.attempts (id, user_id, quiz_id, max_score) values
    ('f6000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000004', 1),
    ('f6000000-0000-0000-0000-000000000002', 'f5000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000005', 1),
    ('f6000000-0000-0000-0000-000000000003', 'f5000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000007', 1),
    ('f6000000-0000-0000-0000-000000000004', 'f5000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000008', 1),
    ('f6000000-0000-0000-0000-000000000005', 'f5000000-0000-0000-0000-000000000001',
     'f2000000-0000-0000-0000-000000000008', 1)
$sql$);

select is(
  (select count(*) from public.questions where id::text like 'f3000000-%'),
  12::bigint,
  'the committed fixtures are visible to this session (positive control)'
);

-- D1: two deletes of the two questions of a published quiz -----------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ delete from public.questions where id = 'f3000000-0000-0000-0000-000000000001' $$);
select pg_temp.run('a', 'set constraints all immediate');
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ delete from public.questions where id = 'f3000000-0000-0000-0000-000000000002' $$);
select pg_temp.send('b', 'set constraints all immediate');

select ok(
  pg_temp.waits('b'),
  'deleting the other question of the published quiz waits for the first delete'
);

select pg_temp.run('a', 'commit');

select matches(
  pg_temp.outcome('b'),
  'quiz_publish_rules',
  'once the first delete commits, deleting the quiz''s last question is refused'
);

select pg_temp.run('b', 'commit');

select results_eq(
  $$ select z.published, count(q.id) from public.quizzes z
     left join public.questions q on q.quiz_id = z.id
     where z.id = 'f2000000-0000-0000-0000-000000000001' group by z.published $$,
  $$ values (true, 1::bigint) $$,
  'the quiz is still published with one question'
);

-- D1: a publish against a delete of the quiz's only question ----------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.quizzes set published = true where id = 'f2000000-0000-0000-0000-000000000002' $$);
select pg_temp.run('a', 'set constraints all immediate');
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ delete from public.questions where id = 'f3000000-0000-0000-0000-000000000003' $$);
select pg_temp.send('b', 'set constraints all immediate');

select ok(
  pg_temp.waits('b'),
  'deleting the only question of a quiz being published waits for the publish'
);

select pg_temp.run('a', 'commit');

select matches(
  pg_temp.outcome('b'),
  'quiz_publish_rules',
  'once the publish commits, deleting the quiz''s only question is refused'
);

select pg_temp.run('b', 'commit');

select results_eq(
  $$ select z.published, count(q.id) from public.quizzes z
     left join public.questions q on q.quiz_id = z.id
     where z.id = 'f2000000-0000-0000-0000-000000000002' group by z.published $$,
  $$ values (true, 1::bigint) $$,
  'the published quiz keeps its question'
);

-- D1: two deletes of two of three answers ------------------------------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ delete from public.answers where id = 'f4000000-0000-0000-0000-000000000042' $$);
select pg_temp.run('a', 'set constraints all immediate');
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ delete from public.answers where id = 'f4000000-0000-0000-0000-000000000043' $$);
select pg_temp.send('b', 'set constraints all immediate');

select ok(
  pg_temp.waits('b'),
  'deleting a second answer of the question waits for the first delete'
);

select pg_temp.run('a', 'commit');

select matches(
  pg_temp.outcome('b'),
  'question_answers_rules',
  'once the first delete commits, deleting a second answer is refused'
);

select pg_temp.run('b', 'commit');

select results_eq(
  $$ select id::text from public.answers
     where question_id = 'f3000000-0000-0000-0000-000000000004' order by id $$,
  $$ values ('f4000000-0000-0000-0000-000000000041'), ('f4000000-0000-0000-0000-000000000043') $$,
  'the question keeps two answers'
);

-- D1: two updates of the two correct answers to wrong ------------------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.answers set is_correct = false where id = 'f4000000-0000-0000-0000-000000000051' $$);
select pg_temp.run('a', 'set constraints all immediate');
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ update public.answers set is_correct = false where id = 'f4000000-0000-0000-0000-000000000052' $$);
select pg_temp.send('b', 'set constraints all immediate');

select ok(
  pg_temp.waits('b'),
  'marking the other correct answer wrong waits for the first update'
);

select pg_temp.run('a', 'commit');

select matches(
  pg_temp.outcome('b'),
  'question_answers_rules',
  'once the first update commits, marking the last correct answer wrong is refused'
);

select pg_temp.run('b', 'commit');

select results_eq(
  $$ select id::text from public.answers
     where question_id = 'f3000000-0000-0000-0000-000000000005' and is_correct order by id $$,
  $$ values ('f4000000-0000-0000-0000-000000000052') $$,
  'the question keeps one correct answer'
);

-- Guard: start_attempt while an admin deletes a question of the quiz --------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ delete from public.questions where id = 'f3000000-0000-0000-0000-00000000000a' $$);
select pg_temp.run('a', 'set constraints all immediate');
select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "f5000000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$ select public.start_attempt('f2000000-0000-0000-0000-000000000006')::text $$);

select ok(
  not pg_temp.waits('b'),
  'starting an attempt doesn''t wait for an admin deleting a question of the quiz'
);

select is(
  pg_temp.outcome('b'),
  'OK',
  'the attempt is started'
);

select pg_temp.run('b', 'rollback');
select pg_temp.run('a', 'commit');

-- D3: submit_answer while the quiz is unpublished ----------------------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.quizzes set published = false where id = 'f2000000-0000-0000-0000-000000000004' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "f5000000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$
  select count(*)::text from public.submit_answer(
    'f6000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000006',
    array['f4000000-0000-0000-0000-000000000061']::uuid[]) $$);

select ok(
  pg_temp.waits('b'),
  'an answer to a quiz being unpublished waits for the unpublish'
);

select pg_temp.run('a', 'commit');

select matches(
  pg_temp.outcome('b'),
  'not available',
  'once the unpublish commits, the answer is refused with ''not available'''
);

select pg_temp.run('b', 'commit');

select is_empty(
  $$ select 1 from public.attempt_answers where attempt_id = 'f6000000-0000-0000-0000-000000000001' $$,
  'no answer was stored for the unpublished quiz'
);

-- D3: submit_answer while the quiz's category is unpublished ----------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.categories set published = false where id = 'f1000000-0000-0000-0000-000000000003' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "f5000000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$
  select count(*)::text from public.submit_answer(
    'f6000000-0000-0000-0000-000000000002', 'f3000000-0000-0000-0000-000000000007',
    array['f4000000-0000-0000-0000-000000000071']::uuid[]) $$);

select ok(
  pg_temp.waits('b'),
  'an answer to a quiz whose category is being unpublished waits for the unpublish'
);

select pg_temp.run('a', 'commit');

select matches(
  pg_temp.outcome('b'),
  'not available',
  'once the category unpublish commits, the answer is refused with ''not available'''
);

select pg_temp.run('b', 'commit');

select is_empty(
  $$ select 1 from public.attempt_answers where attempt_id = 'f6000000-0000-0000-0000-000000000002' $$,
  'no answer was stored for the quiz in the unpublished category'
);

-- D3: submit_answer while the quiz is deleted (deadlock path) ---------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ delete from public.quizzes where id = 'f2000000-0000-0000-0000-000000000007' $$);
select pg_temp.run('a', 'set constraints all immediate');
select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "f5000000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$
  select count(*)::text from public.submit_answer(
    'f6000000-0000-0000-0000-000000000003', 'f3000000-0000-0000-0000-00000000000b',
    array['f4000000-0000-0000-0000-0000000000b1']::uuid[]) $$);

select ok(
  pg_temp.waits('b'),
  'an answer to a quiz being deleted waits for the delete'
);

select pg_temp.run('a', 'commit');

-- Anchored at the error line, so a deadlock error (40P01) fails this too.
select matches(
  pg_temp.outcome('b'),
  '^ERROR:\s+not available\M',
  'once the delete commits, the answer is refused with ''not available'', not a deadlock'
);

select pg_temp.run('b', 'commit');

select is_empty(
  $$ select 1 from public.attempt_answers where attempt_id = 'f6000000-0000-0000-0000-000000000003' $$,
  'no answer was stored for the deleted quiz'
);

-- Guard: two answers on two attempts of one quiz ------------------------------

select pg_temp.run('a', 'begin');
select pg_temp.run('a', 'set local role authenticated');
select pg_temp.run('a', $$ set local request.jwt.claims =
  '{"sub": "f5000000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.run('a', $$ do $do$ begin
  perform public.submit_answer(
    'f6000000-0000-0000-0000-000000000004', 'f3000000-0000-0000-0000-00000000000c',
    array['f4000000-0000-0000-0000-0000000000c1']::uuid[]);
end $do$ $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "f5000000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$
  select count(*)::text from public.submit_answer(
    'f6000000-0000-0000-0000-000000000005', 'f3000000-0000-0000-0000-00000000000c',
    array['f4000000-0000-0000-0000-0000000000c1']::uuid[]) $$);

select ok(
  not pg_temp.waits('b'),
  'an answer on one attempt doesn''t wait for an answer on another attempt of the quiz'
);

select is(
  pg_temp.outcome('b'),
  'OK',
  'the second answer is accepted'
);

select pg_temp.run('b', 'commit');
select pg_temp.run('a', 'commit');

select results_eq(
  $$ select attempt_id::text from public.attempt_answers
     where question_id = 'f3000000-0000-0000-0000-00000000000c' order by attempt_id $$,
  $$ values ('f6000000-0000-0000-0000-000000000004'), ('f6000000-0000-0000-0000-000000000005') $$,
  'both answers are stored'
);

-- Cleanup -------------------------------------------------------------------

select pg_temp.cleanup();

select is_empty(
  $$ select 1 from public.categories where id::text like 'f1000000-%'
     union all select 1 from auth.users where id = 'f5000000-0000-0000-0000-000000000001' $$,
  'the committed fixtures are gone again'
);

select dblink_disconnect('a');
select dblink_disconnect('b');
select dblink_disconnect('setup');

select * from finish();
rollback;
