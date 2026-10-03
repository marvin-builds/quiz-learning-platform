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
begin;
select plan(44);

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

select isnt(
  public.start_attempt('d0000000-0000-0000-0000-000000000001'),
  current_setting('test.learner_attempt')::uuid,
  'starting the same quiz again creates a new attempt'
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
        'd0000000-0000-0000-0000-000000000001'::uuid, 2),
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

select * from finish();
rollback;
