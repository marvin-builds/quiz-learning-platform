-- The rule checks of two admin transactions don't deadlock each other, and
-- submit_answer doesn't answer on a stale category (issue #127, the limits
-- D4 and D5 of the row locks from security review #37).
--
-- D4: the deferred rule triggers lock the row they check (the quiz FOR NO
-- KEY UPDATE for check_quiz_publish_rules, the question for
-- check_question_rules) one by one, in the order of the transaction's
-- writes. Two transactions that touch the same two parents in opposite
-- orders then lock them in opposite orders at commit and one fails with a
-- deadlock (40P01) instead of committing or being refused by the rule
-- (23514). Fixed, both commit when their writes together keep the rules,
-- and the later one is refused with the rule's error when they don't.
--
-- Each case writes one statement per parent, interleaved across the
-- sessions (a: P1, b: P2, a: P2, b: P1), so a fix that only orders the
-- locks within one statement fails it too (the second statements would
-- deadlock). The order of the commits is fixed by a third admin session
-- `c`, which has written a third parent X and checked it (`set constraints
-- all immediate`), so it holds X's lock or whatever the fix serializes the
-- checks with. `a` also writes X, between P1 and P2, and commits first: it
-- waits for `c`. `b` then commits and waits for `a`. Only when `c` commits
-- do `a` and `b` run on. Today `a` holds P1 and waits for X, `b` holds P2
-- and waits for P1, and once `c` is gone `a` waits for P2: a deadlock. X's
-- id is the largest of each case's parents, so a fix that locks the
-- parents in id order also holds P1 and P2 while it waits for X.
--
-- This pins when the fix takes its locks: when the deferred checks run
-- (at commit, or at `set constraints all immediate`), not when the writes
-- run. A fix that serializes the checks with row locks or an advisory lock
-- taken by the writes themselves (say, in an AFTER STATEMENT trigger) makes
-- `a`'s first write wait for `c`; after the lock timeout the run errors and
-- the file aborts instead of failing an assertion.
--
-- Cases: the question rule (answer writes of two questions), keeping the
-- rules and breaking them together; the quiz rule (question deletes of two
-- published quizzes); and a mixed case, where `a` triggers a quiz check and
-- then a question check and `b` the reverse. Any order across tables stays
-- parents first (the quiz before the question), like the delete cascades
-- and submit_answer.
--
-- D5: submit_answer reads the quiz's category, locks it FOR SHARE, then
-- locks the quiz. A quiz moved to another category while the call waits
-- for the quiz lock leaves the new category unlocked. Fixed, the call
-- re-reads the quiz's category after the quiz lock and, if it changed,
-- refuses with 'not available' and stores nothing; the next call runs
-- normally. A change of the quiz that keeps its category (a new title)
-- while the call waits is no reason to refuse: the call waits and answers. Locking the new category after the quiz instead would invert
-- the parents-first order that keeps a category delete from deadlocking
-- with submit_answer.
--
-- Setup as in rule_trigger_races.test.sql, whose helpers this file copies
-- (that file stays unchanged): real sessions through dblink, fixtures
-- committed through `setup` and deleted again at the start and the end,
-- `pg_temp.abandon` closes the sessions and deletes the fixtures when a
-- statement raises. The fixture ids start with fb, so neither file's
-- cleanup removes the other's data. Two fixture categories are published
-- (D5 needs a quiz a learner can play); the D4 fixtures sit in an
-- unpublished category. Writes of `a`, `b` and `c` run as the table owner
-- (the rules are triggers, so RLS doesn't matter for them; moving a quiz to
-- another category isn't granted to admins yet). Every session waits at
-- most 5 seconds for a lock; the deadlock check runs after 1 second.
begin;
select plan(30);

create extension dblink;

-- Helpers (copies of rule_trigger_races.test.sql's, plus session c) -------

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
    delete from auth.users where id = 'fb500000-0000-0000-0000-000000000001';
    delete from public.categories where id in (
      'fb100000-0000-0000-0000-000000000001',
      'fb100000-0000-0000-0000-000000000002',
      'fb100000-0000-0000-0000-000000000003')
  $sql$);
end;
$fn$;

-- After an error: ends the sessions `a`, `b` and `c` (their transactions
-- roll back), deletes the committed fixtures and leaves the error to the
-- caller. A failure of the cleanup itself only warns, so the original error
-- wins.
create function pg_temp.abandon()
returns void
language plpgsql
as $fn$
declare
  conn text;
begin
  foreach conn in array array['a', 'b', 'c'] loop
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
select pg_temp.open('c');

select pg_temp.cleanup();

-- Fixtures, committed -----------------------------------------------------
--
-- Question ids: fb3...0000000000qq, answer ids fb4...000000000qqn (answer n
-- of question qq).

select pg_temp.run('setup', $sql$
  insert into public.categories (id, name, sort_order, published) values
    ('fb100000-0000-0000-0000-000000000001', 'Sperrreihenfolge (Entwurf)', 911, false),
    ('fb100000-0000-0000-0000-000000000002', 'Sperrreihenfolge', 912, true),
    ('fb100000-0000-0000-0000-000000000003', 'Sperrreihenfolge, neu', 913, true);

  insert into public.quizzes (id, category_id, title, sort_order, published) values
    -- D4, question rule: unpublished, the answers are written
    ('fb200000-0000-0000-0000-000000000001', 'fb100000-0000-0000-0000-000000000001',
     'Antworten', 1, false),
    -- D4, quiz rule: P1, P2 and X, published, three questions each
    ('fb200000-0000-0000-0000-000000000011', 'fb100000-0000-0000-0000-000000000001',
     'Erstes', 2, true),
    ('fb200000-0000-0000-0000-000000000012', 'fb100000-0000-0000-0000-000000000001',
     'Zweites', 3, true),
    ('fb200000-0000-0000-0000-000000000013', 'fb100000-0000-0000-0000-000000000001',
     'Drittes', 4, true),
    -- D4, mixed: published, three questions
    ('fb200000-0000-0000-0000-000000000021', 'fb100000-0000-0000-0000-000000000001',
     'Gemischt', 5, true),
    -- D5: published in a published category, moved to another one
    ('fb200000-0000-0000-0000-000000000031', 'fb100000-0000-0000-0000-000000000002',
     'Umgezogen', 1, true);

  insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
    -- D4, question rule: Q1, Q2 (keeping the rules), Q3, Q4 (breaking them),
    -- Q5 (mixed) and X (the blocker, largest id)
    ('fb300000-0000-0000-0000-000000000001', 'fb200000-0000-0000-0000-000000000001', 'Q1?', true, 1),
    ('fb300000-0000-0000-0000-000000000002', 'fb200000-0000-0000-0000-000000000001', 'Q2?', true, 2),
    ('fb300000-0000-0000-0000-000000000003', 'fb200000-0000-0000-0000-000000000001', 'Q3?', true, 3),
    ('fb300000-0000-0000-0000-000000000004', 'fb200000-0000-0000-0000-000000000001', 'Q4?', true, 4),
    ('fb300000-0000-0000-0000-000000000005', 'fb200000-0000-0000-0000-000000000001', 'Q5?', true, 5),
    ('fb300000-0000-0000-0000-0000000000ff', 'fb200000-0000-0000-0000-000000000001', 'X?', true, 6),
    -- D4, quiz rule
    ('fb300000-0000-0000-0000-000000000011', 'fb200000-0000-0000-0000-000000000011', 'P1 eins?', false, 1),
    ('fb300000-0000-0000-0000-000000000012', 'fb200000-0000-0000-0000-000000000011', 'P1 zwei?', false, 2),
    ('fb300000-0000-0000-0000-000000000013', 'fb200000-0000-0000-0000-000000000011', 'P1 drei?', false, 3),
    ('fb300000-0000-0000-0000-000000000021', 'fb200000-0000-0000-0000-000000000012', 'P2 eins?', false, 1),
    ('fb300000-0000-0000-0000-000000000022', 'fb200000-0000-0000-0000-000000000012', 'P2 zwei?', false, 2),
    ('fb300000-0000-0000-0000-000000000023', 'fb200000-0000-0000-0000-000000000012', 'P2 drei?', false, 3),
    ('fb300000-0000-0000-0000-000000000031', 'fb200000-0000-0000-0000-000000000013', 'X eins?', false, 1),
    ('fb300000-0000-0000-0000-000000000032', 'fb200000-0000-0000-0000-000000000013', 'X zwei?', false, 2),
    ('fb300000-0000-0000-0000-000000000033', 'fb200000-0000-0000-0000-000000000013', 'X drei?', false, 3),
    -- D4, mixed
    ('fb300000-0000-0000-0000-000000000041', 'fb200000-0000-0000-0000-000000000021', 'G eins?', false, 1),
    ('fb300000-0000-0000-0000-000000000042', 'fb200000-0000-0000-0000-000000000021', 'G zwei?', false, 2),
    ('fb300000-0000-0000-0000-000000000043', 'fb200000-0000-0000-0000-000000000021', 'G drei?', false, 3),
    -- D5
    ('fb300000-0000-0000-0000-000000000051', 'fb200000-0000-0000-0000-000000000031', 'Umzug?', false, 1);

  -- Multiple choice: A and B correct, C wrong. Single choice: A correct, B wrong.
  insert into public.answers (id, question_id, text, is_correct, sort_order)
  select
    ('fb400000-0000-0000-0000-000000000' || right(q.id::text, 2) || n)::uuid,
    q.id,
    chr(64 + n),
    case when q.multiple_correct then n <= 2 else n = 1 end,
    n
  from public.questions q
  cross join generate_series(1, 3) as n
  where q.id::text like 'fb300000-%'
    and (q.multiple_correct or n <= 2);

  insert into auth.users (id, email) values
    ('fb500000-0000-0000-0000-000000000001', 'sperrreihenfolge@example.test')
$sql$);

-- The learner's attempts, started after the question exists: the first for
-- the move, the second for the title change.
select pg_temp.run('setup', $sql$
  insert into public.attempts (id, user_id, quiz_id, max_score) values
    ('fb600000-0000-0000-0000-000000000001', 'fb500000-0000-0000-0000-000000000001',
     'fb200000-0000-0000-0000-000000000031', 1),
    ('fb600000-0000-0000-0000-000000000002', 'fb500000-0000-0000-0000-000000000001',
     'fb200000-0000-0000-0000-000000000031', 1)
$sql$);

select is(
  (select count(*) from public.answers where id::text like 'fb400000-%'),
  44::bigint,
  'the committed fixtures are visible to this session (positive control)'
);

-- D4, question rule: answer writes of two questions, keeping the rules ------

select pg_temp.run('c', 'begin');
select pg_temp.run('c', $$ update public.answers set text = 'c' where id = 'fb400000-0000-0000-0000-000000000ff1' $$);
select pg_temp.run('c', 'set constraints all immediate');

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.answers set text = 'a' where id = 'fb400000-0000-0000-0000-000000000011' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ update public.answers set text = 'b' where id = 'fb400000-0000-0000-0000-000000000022' $$);
select pg_temp.run('a', $$ update public.answers set text = 'a' where id = 'fb400000-0000-0000-0000-000000000ff2' $$);
select pg_temp.run('a', $$ update public.answers set text = 'a' where id = 'fb400000-0000-0000-0000-000000000021' $$);
select pg_temp.run('b', $$ update public.answers set text = 'b' where id = 'fb400000-0000-0000-0000-000000000012' $$);

select pg_temp.send('a', 'commit');

select ok(
  pg_temp.waits('a'),
  'question rule: the first commit waits for a third admin''s checked write'
);

select pg_temp.send('b', 'commit');

select ok(
  pg_temp.waits('b'),
  'question rule: the commit touching the same two questions in the opposite order waits for the first'
);

select pg_temp.run('c', 'commit');

select is(
  pg_temp.outcome('a'),
  'OK',
  'question rule: the first transaction commits, no deadlock'
);

select is(
  pg_temp.outcome('b'),
  'OK',
  'question rule: the transaction writing the questions in the opposite order commits too, no deadlock'
);

select results_eq(
  $$ select id::text, text from public.answers
     where id in ('fb400000-0000-0000-0000-000000000011', 'fb400000-0000-0000-0000-000000000012',
                  'fb400000-0000-0000-0000-000000000021', 'fb400000-0000-0000-0000-000000000022')
     order by id $$,
  $$ values ('fb400000-0000-0000-0000-000000000011', 'a'),
            ('fb400000-0000-0000-0000-000000000012', 'b'),
            ('fb400000-0000-0000-0000-000000000021', 'a'),
            ('fb400000-0000-0000-0000-000000000022', 'b') $$,
  'question rule: the answers show both transactions'' changes'
);

-- D4, question rule: together the writes break the rule ---------------------
--
-- Q3 has two correct answers; `a` and `b` each mark one of them wrong.

select pg_temp.run('c', 'begin');
select pg_temp.run('c', $$ update public.answers set text = 'c2' where id = 'fb400000-0000-0000-0000-000000000ff1' $$);
select pg_temp.run('c', 'set constraints all immediate');

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.answers set is_correct = false where id = 'fb400000-0000-0000-0000-000000000031' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ update public.answers set text = 'b' where id = 'fb400000-0000-0000-0000-000000000042' $$);
select pg_temp.run('a', $$ update public.answers set text = 'a2' where id = 'fb400000-0000-0000-0000-000000000ff2' $$);
select pg_temp.run('a', $$ update public.answers set text = 'a' where id = 'fb400000-0000-0000-0000-000000000041' $$);
select pg_temp.run('b', $$ update public.answers set is_correct = false where id = 'fb400000-0000-0000-0000-000000000032' $$);

select pg_temp.send('a', 'commit');

select ok(
  pg_temp.waits('a'),
  'question rule, broken: the first commit waits for a third admin''s checked write'
);

select pg_temp.send('b', 'commit');

select ok(
  pg_temp.waits('b'),
  'question rule, broken: the commit touching the same two questions in the opposite order waits for the first'
);

select pg_temp.run('c', 'commit');

select is(
  pg_temp.outcome('a'),
  'OK',
  'question rule, broken: the first transaction commits, no deadlock'
);

-- Anchored at the error line, so a deadlock error (40P01) fails this too.
select matches(
  pg_temp.outcome('b'),
  '^ERROR:\s+question_answers_rules\M',
  'question rule, broken: the later transaction is refused by the rule, not by a deadlock'
);

select results_eq(
  $$ select id::text, is_correct, text from public.answers
     where question_id in ('fb300000-0000-0000-0000-000000000003', 'fb300000-0000-0000-0000-000000000004')
       and id::text not like '%3'
     order by id $$,
  $$ values ('fb400000-0000-0000-0000-000000000031', false, 'A'),
            ('fb400000-0000-0000-0000-000000000032', true, 'B'),
            ('fb400000-0000-0000-0000-000000000041', true, 'a'),
            ('fb400000-0000-0000-0000-000000000042', true, 'B') $$,
  'question rule, broken: only the first transaction''s changes are stored'
);

-- D4, quiz rule: question deletes of two published quizzes ------------------

select pg_temp.run('c', 'begin');
select pg_temp.run('c', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000033' $$);
select pg_temp.run('c', 'set constraints all immediate');

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000011' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000022' $$);
select pg_temp.run('a', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000032' $$);
select pg_temp.run('a', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000021' $$);
select pg_temp.run('b', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000012' $$);

select pg_temp.send('a', 'commit');

select ok(
  pg_temp.waits('a'),
  'quiz rule: the first commit waits for a third admin''s checked delete'
);

select pg_temp.send('b', 'commit');

select ok(
  pg_temp.waits('b'),
  'quiz rule: the commit touching the same two quizzes in the opposite order waits for the first'
);

select pg_temp.run('c', 'commit');

select is(
  pg_temp.outcome('a'),
  'OK',
  'quiz rule: the first transaction commits, no deadlock'
);

select is(
  pg_temp.outcome('b'),
  'OK',
  'quiz rule: the transaction deleting in the opposite order commits too, no deadlock'
);

select results_eq(
  $$ select z.id::text, z.published, array_agg(q.id::text order by q.id) from public.quizzes z
     left join public.questions q on q.quiz_id = z.id
     where z.id in ('fb200000-0000-0000-0000-000000000011', 'fb200000-0000-0000-0000-000000000012',
                    'fb200000-0000-0000-0000-000000000013')
     group by z.id, z.published order by z.id $$,
  $$ values ('fb200000-0000-0000-0000-000000000011', true, array['fb300000-0000-0000-0000-000000000013']),
            ('fb200000-0000-0000-0000-000000000012', true, array['fb300000-0000-0000-0000-000000000023']),
            ('fb200000-0000-0000-0000-000000000013', true, array['fb300000-0000-0000-0000-000000000031']) $$,
  'quiz rule: the quizzes are still published, each with the question both deletes left'
);

-- D4, mixed: a quiz check and a question check in opposite orders -----------
--
-- `a` deletes a question of the published quiz (quiz rule), then writes an
-- answer of Q5 (question rule); `b` writes another answer of Q5, then
-- deletes another question of the quiz.

select pg_temp.run('c', 'begin');
select pg_temp.run('c', $$ update public.answers set text = 'c3' where id = 'fb400000-0000-0000-0000-000000000ff1' $$);
select pg_temp.run('c', 'set constraints all immediate');

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000041' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', $$ update public.answers set text = 'b' where id = 'fb400000-0000-0000-0000-000000000052' $$);
select pg_temp.run('a', $$ update public.answers set text = 'a3' where id = 'fb400000-0000-0000-0000-000000000ff2' $$);
select pg_temp.run('a', $$ update public.answers set text = 'a' where id = 'fb400000-0000-0000-0000-000000000051' $$);
select pg_temp.run('b', $$ delete from public.questions where id = 'fb300000-0000-0000-0000-000000000042' $$);

select pg_temp.send('a', 'commit');

select ok(
  pg_temp.waits('a'),
  'mixed: the first commit waits for a third admin''s checked write'
);

select pg_temp.send('b', 'commit');

select ok(
  pg_temp.waits('b'),
  'mixed: the commit checking the question before the quiz waits for the first'
);

select pg_temp.run('c', 'commit');

select is(
  pg_temp.outcome('a'),
  'OK',
  'mixed: the first transaction commits, no deadlock'
);

select is(
  pg_temp.outcome('b'),
  'OK',
  'mixed: the transaction checking in the opposite order commits too, no deadlock'
);

select results_eq(
  $$ select 'quiz', array_agg(q.id::text order by q.id) from public.questions q
     where q.quiz_id = 'fb200000-0000-0000-0000-000000000021'
     union all
     select 'answers', array_agg(a.text order by a.id) from public.answers a
     where a.question_id = 'fb300000-0000-0000-0000-000000000005' $$,
  $$ values ('quiz', array['fb300000-0000-0000-0000-000000000043']),
            ('answers', array['a', 'b', 'C']) $$,
  'mixed: the quiz keeps the question both deletes left and the answers show both changes'
);

-- D5: submit_answer while its quiz gets a new title -------------------------
--
-- `a` renames the quiz and keeps the transaction open. The learner's answer
-- (on the second attempt) waits at the quiz lock. The category is still
-- the one it locked, so once the rename commits the answer is stored.

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.quizzes set title = 'Umbenannt'
  where id = 'fb200000-0000-0000-0000-000000000031' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "fb500000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$
  select count(*)::text from public.submit_answer(
    'fb600000-0000-0000-0000-000000000002', 'fb300000-0000-0000-0000-000000000051',
    array['fb400000-0000-0000-0000-000000000511']::uuid[]) $$);

select ok(
  pg_temp.waits('b'),
  'an answer to a quiz being renamed waits at the quiz lock'
);

select pg_temp.run('a', 'commit');

select is(
  pg_temp.outcome('b'),
  'OK',
  'once the rename commits, the answer is not refused: the quiz kept its category'
);

select pg_temp.run('b', 'commit');

select results_eq(
  $$ select is_correct, points from public.attempt_answers
     where attempt_id = 'fb600000-0000-0000-0000-000000000002' $$,
  $$ values (true, 1.00::numeric(6, 2)) $$,
  'the answer that waited for the rename is stored'
);

-- D5: submit_answer while its quiz moves to another category ----------------
--
-- `a` moves the quiz to a second published category and keeps the
-- transaction open. The learner's answer locks the old category and waits
-- at the quiz lock. Once the move commits, the category it locked is no
-- longer the quiz's, so the answer is refused and stores nothing.

select pg_temp.run('a', 'begin');
select pg_temp.run('a', $$ update public.quizzes set category_id = 'fb100000-0000-0000-0000-000000000003'
  where id = 'fb200000-0000-0000-0000-000000000031' $$);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "fb500000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$
  select count(*)::text from public.submit_answer(
    'fb600000-0000-0000-0000-000000000001', 'fb300000-0000-0000-0000-000000000051',
    array['fb400000-0000-0000-0000-000000000511']::uuid[]) $$);

select ok(
  pg_temp.waits('b'),
  'an answer to a quiz being moved to another category waits at the quiz lock'
);

select pg_temp.run('a', 'commit');

-- Anchored at the error line, so a deadlock error (40P01) fails this too.
select matches(
  pg_temp.outcome('b'),
  '^ERROR:\s+not available\M',
  'once the move commits, the answer locked a stale category and is refused with ''not available'''
);

select pg_temp.run('b', 'commit');

select is_empty(
  $$ select 1 from public.attempt_answers where attempt_id = 'fb600000-0000-0000-0000-000000000001' $$,
  'no answer was stored for the call that locked the stale category'
);

-- Control: when nothing moves, the same call runs normally.

select pg_temp.run('b', 'begin');
select pg_temp.run('b', 'set local role authenticated');
select pg_temp.run('b', $$ set local request.jwt.claims =
  '{"sub": "fb500000-0000-0000-0000-000000000001", "role": "authenticated"}' $$);
select pg_temp.send('b', $$
  select count(*)::text from public.submit_answer(
    'fb600000-0000-0000-0000-000000000001', 'fb300000-0000-0000-0000-000000000051',
    array['fb400000-0000-0000-0000-000000000511']::uuid[]) $$);

select is(
  pg_temp.outcome('b'),
  'OK',
  'the next call, with nothing moving, is answered (control)'
);

select pg_temp.run('b', 'commit');

select results_eq(
  $$ select is_correct, points from public.attempt_answers
     where attempt_id = 'fb600000-0000-0000-0000-000000000001' $$,
  $$ values (true, 1.00::numeric(6, 2)) $$,
  'the next call stores the answer (control)'
);

-- Cleanup -------------------------------------------------------------------

select pg_temp.cleanup();

select is_empty(
  $$ select 1 from public.categories where id::text like 'fb100000-%'
     union all select 1 from auth.users where id = 'fb500000-0000-0000-0000-000000000001' $$,
  'the committed fixtures are gone again'
);

select dblink_disconnect('a');
select dblink_disconnect('b');
select dblink_disconnect('c');
select dblink_disconnect('setup');

select * from finish();
rollback;
