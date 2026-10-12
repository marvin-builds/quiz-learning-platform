-- public.start_attempt(quiz_id uuid) returns uuid: the only way to create an
-- attempt. It runs as security definer with an empty search_path, only
-- authenticated may call it (anonymous users included, anon not), and it
-- creates an attempt for auth.uid() with score 0 and max_score = the quiz's
-- number of questions. It refuses a quiz that is unknown, invisible (the quiz
-- or its category unpublished), empty, or has a question that can't be scored
-- (no correct answer, or a single-choice question with more than one) with
-- SQLSTATE P0001 and exactly the message 'not available', never echoing ids.
-- Fixtures are created here as the owner, independent of seed.sql, and vanish
-- on rollback. In phase 1 an admin is treated like a learner.
--
-- Reuse and ceiling (#74): start_attempt returns the caller's own unfinished
-- attempt on the same quiz while it has no stored answers and is still
-- consistent (no question created after its start, max_score = the current
-- question count), the newest by started_at, then id; otherwise it creates
-- one. Creating one is refused with the same P0001 'not available' while the
-- caller has the ceiling's number of unfinished attempts with a quiz started
-- within the window (started_at >= now() - window), across all quizzes;
-- reusing still works at the ceiling. internal.attempt_limits() holds both
-- numbers, owner-only, and the tests read them from there. The refusals above
-- come first, then a per-user advisory lock, reuse, the ceiling, the insert.
begin;
select plan(89);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Verstecktes Thema', 2, false);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  -- visible, three scorable questions (two single-choice, one multiple-choice)
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Drei Fragen', 1, true),
  -- visible, one scorable question
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Eine Frage', 2, true),
  -- unpublished quiz in a published category
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 3, false),
  -- published quiz in an unpublished category
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002',
   'Quiz im versteckten Thema', 1, true),
  -- visible, no questions
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001',
   'Leeres Quiz', 4, true),
  -- visible, a scorable question and a single-choice question without a correct answer
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001',
   'Ohne richtige Antwort', 5, true),
  -- visible, a scorable question and a single-choice question with two correct answers
  ('d0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000001',
   'Zwei richtige bei Einfachauswahl', 6, true),
  -- visible, a scorable question and a multiple-choice question without a correct answer
  ('d0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000001',
   'Mehrfachauswahl ohne richtige Antwort', 7, true);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', false, 1),
  ('e0000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000001',
   'Welche Zahlen sind gerade?', true, 2),
  ('e0000000-0000-0000-0000-000000000013', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat Gras?', false, 3),
  ('e0000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000002',
   'Wie viele Beine hat eine Katze?', false, 1),
  ('e0000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000003',
   'Frage im Entwurf?', false, 1),
  ('e0000000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000004',
   'Frage im versteckten Thema?', false, 1),
  ('e0000000-0000-0000-0000-000000000061', 'd0000000-0000-0000-0000-000000000006',
   'Gute Frage?', false, 1),
  ('e0000000-0000-0000-0000-000000000062', 'd0000000-0000-0000-0000-000000000006',
   'Frage ohne richtige Antwort?', false, 2),
  ('e0000000-0000-0000-0000-000000000071', 'd0000000-0000-0000-0000-000000000007',
   'Gute Frage?', false, 1),
  ('e0000000-0000-0000-0000-000000000072', 'd0000000-0000-0000-0000-000000000007',
   'Einfachauswahl mit zwei richtigen?', false, 2),
  ('e0000000-0000-0000-0000-000000000081', 'd0000000-0000-0000-0000-000000000008',
   'Gute Frage?', false, 1),
  ('e0000000-0000-0000-0000-000000000082', 'd0000000-0000-0000-0000-000000000008',
   'Mehrfachauswahl ohne richtige?', true, 2);

insert into public.answers (question_id, text, is_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000011', 'Blau', true, 1),
  ('e0000000-0000-0000-0000-000000000011', 'Rot', false, 2),
  ('e0000000-0000-0000-0000-000000000012', 'Zwei', true, 1),
  ('e0000000-0000-0000-0000-000000000012', 'Vier', true, 2),
  ('e0000000-0000-0000-0000-000000000012', 'Drei', false, 3),
  ('e0000000-0000-0000-0000-000000000013', 'Grün', true, 1),
  ('e0000000-0000-0000-0000-000000000013', 'Lila', false, 2),
  ('e0000000-0000-0000-0000-000000000013', 'Gelb', false, 3),
  ('e0000000-0000-0000-0000-000000000021', 'Vier', true, 1),
  ('e0000000-0000-0000-0000-000000000021', 'Drei', false, 2),
  ('e0000000-0000-0000-0000-000000000031', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000041', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000061', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000062', 'Nein', false, 1),
  ('e0000000-0000-0000-0000-000000000062', 'Vielleicht', false, 2),
  ('e0000000-0000-0000-0000-000000000071', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000072', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000072', 'Auch ja', true, 2),
  ('e0000000-0000-0000-0000-000000000081', 'Ja', true, 1),
  ('e0000000-0000-0000-0000-000000000082', 'Nein', false, 1),
  ('e0000000-0000-0000-0000-000000000082', 'Auch nein', false, 2);

-- Structure and privileges --------------------------------------------------

select has_function('public', 'start_attempt', '{uuid}'::name[],
  'public.start_attempt(uuid) exists');

select function_returns('public', 'start_attempt', '{uuid}'::name[], 'uuid',
  'start_attempt(uuid) returns uuid');

select is(
  (select proargnames from pg_proc where oid = 'public.start_attempt(uuid)'::regprocedure),
  array['quiz_id']::text[],
  'start_attempt''s parameter is named quiz_id, the name the API call uses'
);

select is_definer('public', 'start_attempt', '{uuid}'::name[],
  'start_attempt(uuid) is security definer');

select ok(
  (select coalesce(proconfig @> array['search_path=""'], false)
   from pg_proc where oid = 'public.start_attempt(uuid)'::regprocedure),
  'start_attempt(uuid) sets search_path to the empty string'
);

select ok(
  has_function_privilege('authenticated', 'public.start_attempt(uuid)', 'execute'),
  'authenticated may execute start_attempt(uuid)'
);

select ok(
  not has_function_privilege('anon', 'public.start_attempt(uuid)', 'execute'),
  'anon may not execute start_attempt(uuid)'
);

-- A null ACL means the default, which grants execute to PUBLIC.
select is_empty(
  $$ select 1
     from pg_proc p,
          aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
     where p.oid = 'public.start_attempt(uuid)'::regprocedure
       and acl.grantee = 0
       and acl.privilege_type = 'EXECUTE' $$,
  'PUBLIC has no execute grant on start_attempt(uuid)'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000001') $$,
  '42501', null,
  'anon cannot start an attempt on a visible quiz'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-0000000000ff') $$,
  '42501', null,
  'anon gets a permission error for an unknown quiz too, not a hint about the quiz'
);

reset role;

-- anonymous user (guest) --------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select isnt(
  set_config('test.guest_attempt',
    public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true),
  null,
  'an anonymous user can start an attempt on a visible quiz'
);

select results_eq(
  $$ select user_id, quiz_id, score = 0, max_score, started_at = now(), finished_at is null
     from public.attempts where id = current_setting('test.guest_attempt')::uuid $$,
  $$ values ('44444444-4444-4444-4444-444444444444'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid, true, 3, true, true) $$,
  'the anonymous user''s new attempt is theirs, on the quiz, with score 0 and max_score 3'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-0000000000ff') $$,
  'P0001', 'not available',
  'an anonymous user cannot start an unknown quiz'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000003') $$,
  'P0001', 'not available',
  'an anonymous user cannot start an unpublished quiz'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000004') $$,
  'P0001', 'not available',
  'an anonymous user cannot start a published quiz in an unpublished category'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000005') $$,
  'P0001', 'not available',
  'an anonymous user cannot start a quiz without questions'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000006') $$,
  'P0001', 'not available',
  'an anonymous user cannot start a quiz with a question that has no correct answer'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000007') $$,
  'P0001', 'not available',
  'an anonymous user cannot start a quiz with a single-choice question with two correct answers'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000008') $$,
  'P0001', 'not available',
  'an anonymous user cannot start a quiz with a multiple-choice question without a correct answer'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select isnt(
  set_config('test.learner_attempt',
    public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true),
  null,
  'a learner can start an attempt on a visible quiz'
);

select results_eq(
  $$ select user_id, quiz_id, score = 0, max_score, started_at = now(), finished_at is null
     from public.attempts where id = current_setting('test.learner_attempt')::uuid $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid, true, 3, true, true) $$,
  'the learner''s new attempt is theirs, on the quiz, with score 0 and max_score 3'
);

select isnt(
  set_config('test.learner_second_attempt',
    public.start_attempt('d0000000-0000-0000-0000-000000000002')::text, true),
  null,
  'a learner can start an attempt on another visible quiz'
);

select results_eq(
  $$ select quiz_id, max_score
     from public.attempts where id = current_setting('test.learner_second_attempt')::uuid $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid, 1) $$,
  'max_score is the number of questions of the started quiz'
);

select is(
  public.start_attempt('d0000000-0000-0000-0000-000000000001'),
  current_setting('test.learner_attempt')::uuid,
  'starting the same quiz again returns the learner''s unfinished attempt while it has no answers'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-0000000000ff') $$,
  'P0001', 'not available',
  'a learner cannot start an unknown quiz'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000003') $$,
  'P0001', 'not available',
  'a learner cannot start an unpublished quiz'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000004') $$,
  'P0001', 'not available',
  'a learner cannot start a published quiz in an unpublished category'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000005') $$,
  'P0001', 'not available',
  'a learner cannot start a quiz without questions'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000006') $$,
  'P0001', 'not available',
  'a learner cannot start a quiz with a question that has no correct answer'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000007') $$,
  'P0001', 'not available',
  'a learner cannot start a quiz with a single-choice question with two correct answers'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000008') $$,
  'P0001', 'not available',
  'a learner cannot start a quiz with a multiple-choice question without a correct answer'
);

select throws_ok(
  $$ select public.start_attempt(null) $$,
  'P0001', 'not available',
  'a learner cannot start an attempt without a quiz id'
);

reset role;

-- admin (carol), treated like a learner in phase 1 ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select isnt(
  set_config('test.admin_attempt',
    public.start_attempt('d0000000-0000-0000-0000-000000000001')::text, true),
  null,
  'an admin can start an attempt on a visible quiz'
);

select results_eq(
  $$ select user_id, quiz_id, score = 0, max_score, started_at = now(), finished_at is null
     from public.attempts where id = current_setting('test.admin_attempt')::uuid $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid, true, 3, true, true) $$,
  'the admin''s new attempt is theirs, on the quiz, with score 0 and max_score 3'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-0000000000ff') $$,
  'P0001', 'not available',
  'an admin cannot start an unknown quiz'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000003') $$,
  'P0001', 'not available',
  'an admin cannot start an unpublished quiz in phase 1'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000004') $$,
  'P0001', 'not available',
  'an admin cannot start a published quiz in an unpublished category in phase 1'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000005') $$,
  'P0001', 'not available',
  'an admin cannot start a quiz without questions'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000006') $$,
  'P0001', 'not available',
  'an admin cannot start a quiz with a question that has no correct answer'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000007') $$,
  'P0001', 'not available',
  'an admin cannot start a quiz with a single-choice question with two correct answers'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000008') $$,
  'P0001', 'not available',
  'an admin cannot start a quiz with a multiple-choice question without a correct answer'
);

reset role;

-- The new attempts are visible only to their owners -----------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is_empty(
  $$ select 1 from public.attempts
     where id in (current_setting('test.guest_attempt')::uuid,
                  current_setting('test.admin_attempt')::uuid) $$,
  'a learner cannot read attempts others started'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select user_id, quiz_id, count(*)::int from public.attempts
     where user_id in ('11111111-1111-1111-1111-111111111111',
                       '33333333-3333-3333-3333-333333333333',
                       '44444444-4444-4444-4444-444444444444')
     group by user_id, quiz_id
     order by user_id, quiz_id $$,
  $$ values
       ('11111111-1111-1111-1111-111111111111'::uuid,
        'd0000000-0000-0000-0000-000000000001'::uuid, 1),
       ('11111111-1111-1111-1111-111111111111'::uuid,
        'd0000000-0000-0000-0000-000000000002'::uuid, 1),
       ('33333333-3333-3333-3333-333333333333'::uuid,
        'd0000000-0000-0000-0000-000000000001'::uuid, 1),
       ('44444444-4444-4444-4444-444444444444'::uuid,
        'd0000000-0000-0000-0000-000000000001'::uuid, 1) $$,
  'only the successful calls created attempts, none for rejected quizzes'
);

select is_empty(
  $$ select 1 from public.attempts
     where quiz_id in ('d0000000-0000-0000-0000-000000000003',
                       'd0000000-0000-0000-0000-000000000004',
                       'd0000000-0000-0000-0000-000000000005',
                       'd0000000-0000-0000-0000-000000000006',
                       'd0000000-0000-0000-0000-000000000007',
                       'd0000000-0000-0000-0000-000000000008') $$,
  'no attempt exists on a quiz that cannot be started'
);

-- Reuse and the ceiling (#74) ------------------------------------------------
-- Everything below runs after the effect checks above, with its own users,
-- so those counts stay as they are. now() is fixed within the transaction,
-- so every started_at and created_at that matters is set explicitly.

-- The limits, read as the owner from their one place, internal.attempt_limits().
-- Dynamic SQL, so a missing helper leaves them empty and the cases below fail
-- as assertions instead of aborting the file.
do $$
declare
  max_unfinished integer;
  window_length interval;
begin
  execute 'select max_unfinished, window_length from internal.attempt_limits()'
    into max_unfinished, window_length;
  perform set_config('test.cap', coalesce(max_unfinished::text, ''), true);
  perform set_config('test.window', coalesce(window_length::text, ''), true);
exception when others then
  perform set_config('test.cap', '', true);
  perform set_config('test.window', '', true);
end;
$$;

create function pg_temp.cap()
returns integer
language sql
as $$ select nullif(current_setting('test.cap'), '')::integer $$;

create function pg_temp.window_length()
returns interval
language sql
as $$ select nullif(current_setting('test.window'), '')::interval $$;

-- n unfinished attempts of a user on a quiz, as start_attempt would create
-- them (max_score = the quiz's question count), started at the given time.
-- With answered, each gets a stored answer to the quiz's first question, so
-- it can't be reused and a call on that quiz reaches the ceiling check.
create function pg_temp.add_attempts(
  user_id uuid, quiz_id uuid, n integer, started_at timestamptz, answered boolean)
returns void
language sql
as $$
  with new_attempts as (
    insert into public.attempts (user_id, quiz_id, started_at, max_score)
    select add_attempts.user_id, add_attempts.quiz_id, add_attempts.started_at,
           (select count(*)::int from public.questions q
            where q.quiz_id = add_attempts.quiz_id)
    from generate_series(1, add_attempts.n)
    where add_attempts.started_at is not null
    returning id
  )
  insert into public.attempt_answers
    (attempt_id, question_id, selected_answer_ids, is_correct, points)
  select na.id, fq.id,
         array[(select a.id from public.answers a
                where a.question_id = fq.id order by a.sort_order limit 1)],
         false, 0
  from new_attempts na
  cross join lateral (
    select q.id from public.questions q
    where q.quiz_id = add_attempts.quiz_id
    order by q.sort_order limit 1
  ) fq
  where add_attempts.answered
$$;

create function pg_temp.attempt_count(user_id uuid)
returns integer
language sql
as $$ select count(*)::int from public.attempts a where a.user_id = attempt_count.user_id $$;

-- start_attempt for the current caller, or null if it raises, so an
-- unexpected refusal fails one assertion instead of the file.
create function pg_temp.try_start(quiz_id uuid)
returns uuid
language plpgsql
as $$
begin
  return public.start_attempt(quiz_id);
exception when others then
  return null;
end;
$$;

-- The full text of the error start_attempt raises for the current caller, as
-- in start_attempt_no_user.test.sql: SQLSTATE, message, detail and hint, the
-- last two left out when empty.
create function pg_temp.start_attempt_error(quiz_id uuid)
returns text
language plpgsql
as $$
declare
  state text;
  message text;
  detail text;
  hint text;
begin
  perform public.start_attempt(quiz_id);
  return null;
exception when others then
  get stacked diagnostics
    state = returned_sqlstate, message = message_text,
    detail = pg_exception_detail, hint = pg_exception_hint;
  return concat_ws(' | ', state, message, nullif(detail, ''), nullif(hint, ''));
end;
$$;

grant execute on function pg_temp.try_start(uuid) to authenticated;
grant execute on function pg_temp.start_attempt_error(uuid) to authenticated;

-- Advisory locks this transaction holds, for the lock checks.
create function pg_temp.advisory_locks()
returns integer
language sql
as $$
  select count(*)::int from pg_catalog.pg_locks
  where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid() and granted
$$;

-- Users: a7… for the ceiling, b7… for reuse, c7… for the lock.
insert into auth.users (id, email) values
  ('a7000000-0000-0000-0000-000000000001', 'cap-learner@example.test'),
  ('a7000000-0000-0000-0000-000000000003', 'cap-admin@example.test'),
  ('a7000000-0000-0000-0000-000000000011', 'window-outside@example.test'),
  ('a7000000-0000-0000-0000-000000000012', 'window-inside@example.test'),
  ('a7000000-0000-0000-0000-000000000013', 'window-edge@example.test'),
  ('a7000000-0000-0000-0000-000000000014', 'quiz-null@example.test'),
  ('a7000000-0000-0000-0000-000000000015', 'finished@example.test'),
  ('a7000000-0000-0000-0000-000000000016', 'others@example.test'),
  ('a7000000-0000-0000-0000-000000000017', 'invisible@example.test'),
  ('b7000000-0000-0000-0000-000000000001', 'reuse-answered@example.test'),
  ('b7000000-0000-0000-0000-000000000002', 'reuse-finished@example.test'),
  ('b7000000-0000-0000-0000-000000000003', 'reuse-other-user@example.test'),
  ('b7000000-0000-0000-0000-000000000004', 'reuse-other-quiz@example.test'),
  ('b7000000-0000-0000-0000-000000000005', 'reuse-max-score@example.test'),
  ('b7000000-0000-0000-0000-000000000006', 'reuse-new-question@example.test'),
  ('b7000000-0000-0000-0000-000000000007', 'reuse-owner@example.test'),
  ('b7000000-0000-0000-0000-000000000011', 'reuse-newest@example.test'),
  ('b7000000-0000-0000-0000-000000000012', 'reuse-tie@example.test'),
  ('b7000000-0000-0000-0000-000000000013', 'reuse-old@example.test'),
  ('c7000000-0000-0000-0000-000000000001', 'lock-one@example.test'),
  ('c7000000-0000-0000-0000-000000000002', 'lock-two@example.test');

insert into auth.users (id, is_anonymous) values
  ('a7000000-0000-0000-0000-000000000002', true);

update public.profiles set role = 'admin' where id = 'a7000000-0000-0000-0000-000000000003';

-- A visible quiz whose only question was created long ago, so an attempt
-- started after it but before the window is still consistent.
insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001',
   'Alte Frage', 8, true);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order, created_at) values
  ('e0000000-0000-0000-0000-000000000091', 'd0000000-0000-0000-0000-000000000009',
   'Alte Frage?', false, 1, '2020-01-01 00:00:00+00');

insert into public.answers (question_id, text, is_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000091', 'Ja', true, 1);

-- The limits ----------------------------------------------------------------

select ok(
  to_regprocedure('internal.attempt_limits()') is not null,
  'internal.attempt_limits() exists, the one place for the ceiling and its window'
);

select results_eq(
  $$ select pg_temp.cap(), pg_temp.window_length() $$,
  $$ values (20, interval '24 hours') $$,
  'the ceiling is 20 unfinished attempts started in the last 24 hours'
);

select is(
  has_function_privilege('anon', to_regprocedure('internal.attempt_limits()'), 'execute'),
  false,
  'anon may not execute internal.attempt_limits()'
);

select is(
  has_function_privilege('authenticated', to_regprocedure('internal.attempt_limits()'), 'execute'),
  false,
  'authenticated may not execute internal.attempt_limits()'
);

-- Ceiling: learner ------------------------------------------------------------
-- One below the ceiling, all on the quiz called and answered, so the call at
-- the limit creates the ceiling-th attempt.

select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001', pg_temp.cap() - 1, now() - interval '1 hour', true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);

select isnt(
  set_config('test.cap_learner',
    coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true),
  '',
  'at the limit: a learner one below the ceiling can start one more attempt'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000002') $$,
  'P0001', 'not available',
  'one past the limit: a learner at the ceiling cannot start another quiz'
);

select is(
  pg_temp.start_attempt_error('d0000000-0000-0000-0000-000000000002'),
  'P0001 | not available',
  'a learner''s ceiling refusal has no detail or hint: no count, quiz id or user id'
);

reset role;

select is(
  pg_temp.attempt_count('a7000000-0000-0000-0000-000000000001'),
  pg_temp.cap(),
  'the learner''s refused calls stored no attempt'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);

select is(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000001'),
  nullif(current_setting('test.cap_learner'), '')::uuid,
  'at the ceiling a learner still gets their empty attempt on the same quiz back'
);

reset role;

select is(
  pg_temp.attempt_count('a7000000-0000-0000-0000-000000000001'),
  pg_temp.cap(),
  'reusing the learner''s empty attempt at the ceiling stored no attempt'
);

-- Ceiling: anonymous user -----------------------------------------------------
-- One below the ceiling, spread over two quizzes: the ceiling spans quizzes.

select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-000000000001', (pg_temp.cap() - 1) / 2,
  now() - interval '1 hour', true);
select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-000000000002', (pg_temp.cap() - 1) - (pg_temp.cap() - 1) / 2,
  now() - interval '1 hour', true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000002", "role": "authenticated", "is_anonymous": true}',
  true);

select isnt(
  set_config('test.cap_guest',
    coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true),
  '',
  'at the limit: an anonymous user one below the ceiling can start one more attempt'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000002') $$,
  'P0001', 'not available',
  'one past the limit: an anonymous user at the ceiling cannot start another quiz'
);

select is(
  pg_temp.start_attempt_error('d0000000-0000-0000-0000-000000000002'),
  'P0001 | not available',
  'an anonymous user''s ceiling refusal has no detail or hint: no count, quiz id or user id'
);

reset role;

select is(
  pg_temp.attempt_count('a7000000-0000-0000-0000-000000000002'),
  pg_temp.cap(),
  'the anonymous user''s refused calls stored no attempt'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000002", "role": "authenticated", "is_anonymous": true}',
  true);

select is(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000001'),
  nullif(current_setting('test.cap_guest'), '')::uuid,
  'at the ceiling an anonymous user still gets their empty attempt on the same quiz back'
);

reset role;

select is(
  pg_temp.attempt_count('a7000000-0000-0000-0000-000000000002'),
  pg_temp.cap(),
  'reusing the anonymous user''s empty attempt at the ceiling stored no attempt'
);

-- Ceiling: admin --------------------------------------------------------------
-- One below the ceiling, all on another quiz than the one called at the limit.

select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000003',
  'd0000000-0000-0000-0000-000000000002', pg_temp.cap() - 1, now() - interval '1 hour', true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);

select isnt(
  set_config('test.cap_admin',
    coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true),
  '',
  'at the limit: an admin one below the ceiling can start one more attempt'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000002') $$,
  'P0001', 'not available',
  'one past the limit: an admin at the ceiling cannot start another quiz'
);

select is(
  pg_temp.start_attempt_error('d0000000-0000-0000-0000-000000000002'),
  'P0001 | not available',
  'an admin''s ceiling refusal has no detail or hint: no count, quiz id or user id'
);

reset role;

select is(
  pg_temp.attempt_count('a7000000-0000-0000-0000-000000000003'),
  pg_temp.cap(),
  'the admin''s refused calls stored no attempt'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);

select is(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000001'),
  nullif(current_setting('test.cap_admin'), '')::uuid,
  'at the ceiling an admin still gets their empty attempt on the same quiz back'
);

reset role;

select is(
  pg_temp.attempt_count('a7000000-0000-0000-0000-000000000003'),
  pg_temp.cap(),
  'reusing the admin''s empty attempt at the ceiling stored no attempt'
);

-- What the ceiling counts -------------------------------------------------------
-- Each user has one below the ceiling, answered, on d…01, an hour ago, plus
-- the attempt under test. Where it must not count, a call on d…02 succeeds
-- and the next call on d…01 is refused (the others do count); where it must
-- count, the call on d…02 is refused.

select pg_temp.add_attempts(u.id, 'd0000000-0000-0000-0000-000000000001',
  pg_temp.cap() - 1, now() - interval '1 hour', true)
from (values
  ('a7000000-0000-0000-0000-000000000011'::uuid),
  ('a7000000-0000-0000-0000-000000000012'::uuid),
  ('a7000000-0000-0000-0000-000000000013'::uuid),
  ('a7000000-0000-0000-0000-000000000014'::uuid),
  ('a7000000-0000-0000-0000-000000000015'::uuid),
  ('a7000000-0000-0000-0000-000000000016'::uuid),
  ('a7000000-0000-0000-0000-000000000017'::uuid)) as u (id);

-- just outside the window: started window + 1 second ago
select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000011',
  'd0000000-0000-0000-0000-000000000001', 1,
  now() - pg_temp.window_length() - interval '1 second', true);
-- just inside the window: started window - 1 second ago
select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000012',
  'd0000000-0000-0000-0000-000000000001', 1,
  now() - pg_temp.window_length() + interval '1 second', true);
-- on the edge: started exactly window ago
select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000013',
  'd0000000-0000-0000-0000-000000000001', 1,
  now() - pg_temp.window_length(), true);
-- an attempt whose quiz was deleted (quiz_id null), so it can never finish
insert into public.attempts (user_id, quiz_id, started_at, max_score) values
  ('a7000000-0000-0000-0000-000000000014', null, now() - interval '1 hour', 3);
-- a finished attempt
insert into public.attempts (user_id, quiz_id, started_at, finished_at, score, max_score) values
  ('a7000000-0000-0000-0000-000000000015', 'd0000000-0000-0000-0000-000000000001',
   now() - interval '1 hour', now() - interval '30 minutes', 2, 3);
-- an unfinished attempt on a quiz that is no longer visible
select pg_temp.add_attempts('a7000000-0000-0000-0000-000000000017',
  'd0000000-0000-0000-0000-000000000003', 1, now() - interval '1 hour', true);

set local role authenticated;

select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000011", "role": "authenticated"}', true);

select isnt(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000002'),
  null,
  'an unfinished attempt started just outside the window (window plus 1 second ago) does not count'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000001') $$,
  'P0001', 'not available',
  'next to one outside the window, the attempts inside it fill the ceiling'
);

select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000012", "role": "authenticated"}', true);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000002') $$,
  'P0001', 'not available',
  'an unfinished attempt started just inside the window (window minus 1 second ago) counts'
);

select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000013", "role": "authenticated"}', true);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000002') $$,
  'P0001', 'not available',
  'an unfinished attempt started exactly the window ago counts'
);

select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000014", "role": "authenticated"}', true);

select isnt(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000002'),
  null,
  'an unfinished attempt without a quiz (quiz_id null) does not count'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000001') $$,
  'P0001', 'not available',
  'next to one without a quiz, the attempts with a quiz fill the ceiling'
);

select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000015", "role": "authenticated"}', true);

select isnt(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000002'),
  null,
  'a finished attempt does not count'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000001') $$,
  'P0001', 'not available',
  'next to a finished one, the unfinished attempts fill the ceiling'
);

-- By now the three ceiling users above hold a full ceiling each.
select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000016", "role": "authenticated"}', true);

select isnt(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000002'),
  null,
  'other users'' unfinished attempts do not count'
);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000001') $$,
  'P0001', 'not available',
  'the caller''s own unfinished attempts fill the ceiling'
);

select set_config('request.jwt.claims',
  '{"sub": "a7000000-0000-0000-0000-000000000017", "role": "authenticated"}', true);

select throws_ok(
  $$ select public.start_attempt('d0000000-0000-0000-0000-000000000002') $$,
  'P0001', 'not available',
  'an unfinished attempt on a quiz that is no longer visible still counts'
);

reset role;

-- Which attempt is reused ---------------------------------------------------------
-- Each case has one attempt that misses one reuse condition. The first call
-- must create a new attempt, and the second must reuse that new one, which
-- shows reuse works for that caller and quiz otherwise.

insert into public.attempts (id, user_id, quiz_id, started_at, finished_at, max_score) values
  -- has a stored answer
  ('f7000000-0000-0000-0000-000000000041', 'b7000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000001', now(), null, 3),
  -- finished, without answers
  ('f7000000-0000-0000-0000-000000000042', 'b7000000-0000-0000-0000-000000000002',
   'd0000000-0000-0000-0000-000000000001', now(), now(), 3),
  -- another user's empty attempt
  ('f7000000-0000-0000-0000-000000000043', 'b7000000-0000-0000-0000-000000000007',
   'd0000000-0000-0000-0000-000000000001', now(), null, 3),
  -- empty, on another quiz
  ('f7000000-0000-0000-0000-000000000044', 'b7000000-0000-0000-0000-000000000004',
   'd0000000-0000-0000-0000-000000000002', now(), null, 1),
  -- max_score differs from the quiz's current question count (3)
  ('f7000000-0000-0000-0000-000000000045', 'b7000000-0000-0000-0000-000000000005',
   'd0000000-0000-0000-0000-000000000001', now(), null, 2),
  -- started a minute before the quiz's questions were created (now())
  ('f7000000-0000-0000-0000-000000000046', 'b7000000-0000-0000-0000-000000000006',
   'd0000000-0000-0000-0000-000000000001', now() - interval '1 minute', null, 3);

insert into public.attempt_answers
  (attempt_id, question_id, selected_answer_ids, is_correct, points)
values
  ('f7000000-0000-0000-0000-000000000041', 'e0000000-0000-0000-0000-000000000011',
   array[(select id from public.answers
          where question_id = 'e0000000-0000-0000-0000-000000000011' and is_correct)],
   true, 1);

set local role authenticated;

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select set_config('test.r1_first',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);
select set_config('test.r1_second',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);

select results_eq(
  $$ values (current_setting('test.r1_first') not in ('', 'f7000000-0000-0000-0000-000000000041'),
             current_setting('test.r1_second') = current_setting('test.r1_first')) $$,
  $$ values (true, true) $$,
  'an attempt with a stored answer is not reused: a new one is created, and that one is reused'
);

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select set_config('test.r2_first',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);
select set_config('test.r2_second',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);

select results_eq(
  $$ values (current_setting('test.r2_first') not in ('', 'f7000000-0000-0000-0000-000000000042'),
             current_setting('test.r2_second') = current_setting('test.r2_first')) $$,
  $$ values (true, true) $$,
  'a finished attempt is not reused: a new one is created, and that one is reused'
);

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select set_config('test.r3_first',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);
select set_config('test.r3_second',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);

select results_eq(
  $$ values (current_setting('test.r3_first') not in ('', 'f7000000-0000-0000-0000-000000000043'),
             current_setting('test.r3_second') = current_setting('test.r3_first')) $$,
  $$ values (true, true) $$,
  'another user''s empty attempt is not reused: a new one is created, and that one is reused'
);

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select set_config('test.r4_first',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);
select set_config('test.r4_second',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);

select results_eq(
  $$ values (current_setting('test.r4_first') not in ('', 'f7000000-0000-0000-0000-000000000044'),
             current_setting('test.r4_second') = current_setting('test.r4_first')) $$,
  $$ values (true, true) $$,
  'an empty attempt on another quiz is not reused: a new one is created, and that one is reused'
);

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select set_config('test.r5_first',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);
select set_config('test.r5_second',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);

select results_eq(
  $$ values (current_setting('test.r5_first') not in ('', 'f7000000-0000-0000-0000-000000000045'),
             current_setting('test.r5_second') = current_setting('test.r5_first')) $$,
  $$ values (true, true) $$,
  'an empty attempt whose max_score differs from the question count is not reused: a new one is created, and that one is reused'
);

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select set_config('test.r6_first',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);
select set_config('test.r6_second',
  coalesce(pg_temp.try_start('d0000000-0000-0000-0000-000000000001')::text, ''), true);

select results_eq(
  $$ values (current_setting('test.r6_first') not in ('', 'f7000000-0000-0000-0000-000000000046'),
             current_setting('test.r6_second') = current_setting('test.r6_first')) $$,
  $$ values (true, true) $$,
  'an empty attempt with a question created after its start is not reused: a new one is created, and that one is reused'
);

reset role;

-- Several attempts qualify: the newest by started_at, then the larger id. The
-- newer attempt has the smaller id, and the tie's larger id is inserted first,
-- so neither id order nor insertion order gives the right answer by chance.
insert into public.attempts (id, user_id, quiz_id, started_at, max_score) values
  ('f7000000-0000-0000-0000-000000000011', 'b7000000-0000-0000-0000-000000000011',
   'd0000000-0000-0000-0000-000000000009', '2020-07-01 00:00:00+00', 1),
  ('f7000000-0000-0000-0000-000000000012', 'b7000000-0000-0000-0000-000000000011',
   'd0000000-0000-0000-0000-000000000009', '2020-06-01 00:00:00+00', 1),
  ('f7000000-0000-0000-0000-000000000022', 'b7000000-0000-0000-0000-000000000012',
   'd0000000-0000-0000-0000-000000000009', '2020-06-01 00:00:00+00', 1),
  ('f7000000-0000-0000-0000-000000000021', 'b7000000-0000-0000-0000-000000000012',
   'd0000000-0000-0000-0000-000000000009', '2020-06-01 00:00:00+00', 1),
  -- reuse has no age limit: older than the window, still consistent
  ('f7000000-0000-0000-0000-000000000031', 'b7000000-0000-0000-0000-000000000013',
   'd0000000-0000-0000-0000-000000000009', '2020-06-01 00:00:00+00', 1);

set local role authenticated;

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000011", "role": "authenticated"}', true);

select is(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000009'),
  'f7000000-0000-0000-0000-000000000011'::uuid,
  'of two empty attempts on the quiz the one started last is reused'
);

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000012", "role": "authenticated"}', true);

select is(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000009'),
  'f7000000-0000-0000-0000-000000000022'::uuid,
  'of two empty attempts started at the same time the one with the larger id is reused'
);

select set_config('request.jwt.claims',
  '{"sub": "b7000000-0000-0000-0000-000000000013", "role": "authenticated"}', true);

select is(
  pg_temp.try_start('d0000000-0000-0000-0000-000000000009'),
  'f7000000-0000-0000-0000-000000000031'::uuid,
  'an empty attempt started before the window is still reused'
);

reset role;

select results_eq(
  $$ select count(*)::int, max(started_at) from public.attempts
     where user_id = 'b7000000-0000-0000-0000-000000000013' $$,
  $$ values (1, '2020-06-01 00:00:00+00'::timestamptz) $$,
  'reusing an attempt keeps its original start time and stores no new attempt'
);

-- Lock: one per user, held until the transaction ends ----------------------------
-- Concurrency itself is a reviewed design point; this checks a call takes a
-- lock keyed by the caller, so two users' calls hold two locks.

select set_config('test.locks_before', pg_temp.advisory_locks()::text, true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select pg_temp.try_start('d0000000-0000-0000-0000-000000000002');
reset role;

select cmp_ok(
  pg_temp.advisory_locks(),
  '>',
  current_setting('test.locks_before')::int,
  'start_attempt takes a transaction-scoped advisory lock for its caller'
);

select set_config('test.locks_before', pg_temp.advisory_locks()::text, true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "c7000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select pg_temp.try_start('d0000000-0000-0000-0000-000000000002');
reset role;

select cmp_ok(
  pg_temp.advisory_locks(),
  '>',
  current_setting('test.locks_before')::int,
  'another user''s call takes a lock of its own, so the lock is per user'
);

select * from finish();
rollback;
