-- public.save_question refuses a payload that names the same answer id
-- twice (#82, review finding after bbc8d23). Counted per element, such a
-- payload would pass the in-call rules check (two answers, one correct)
-- although it keeps only one answer; the deferred rule triggers would refuse
-- it only at commit. The pre-check counts distinct answers instead, so the
-- call itself raises 23514 and leaves the stored rows as they were.
--
-- Security review #37 (D2): the duplicate check compares the ids as uuids,
-- not as text, so one answer id in two spellings (upper case, braces, no
-- hyphens) counts as named twice. Such a payload on a multiple-choice
-- question could otherwise keep the rules after the writes (two answers,
-- one correct) and commit, so it is refused in the call, before any write.
-- An id that is no uuid at all raises 22P02 from the cast, as before.
-- Fixtures are created here as the owner, independent of seed.sql, and
-- vanish on rollback.
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(10);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 1, false);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
   'Was ist die Hauptstadt von Frankreich?', false, 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Paris', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Lyon', false, 2);

-- A multiple-choice question with two answers, for the spelling cases.
insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-000000000002',
   'Welche Zahlen sind gerade?', true, 2);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-00000000000b', 'e0000000-0000-0000-0000-00000000000b',
   'Zwei', true, 1),
  ('a0000000-0000-0000-0000-00000000000c', 'e0000000-0000-0000-0000-00000000000b',
   'Drei', false, 2);

-- admin (carol) -------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Was ist die Hauptstadt von Frankreich?', explanation => null,
       multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": false}]') $$,
  '23514', null,
  'a payload naming the same answer twice is refused in the call'
);

-- One answer id in two spellings. Without the check, the writes would leave
-- two valid answers (Zwei correct, Drei wrong) and the save would commit.
select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-00000000000b',
       text => 'Welche Zahlen sind gerade? (geändert)', explanation => null,
       multiple_correct => true,
       answers => '[{"id": "a0000000-0000-0000-0000-00000000000b", "text": "Zwei", "is_correct": true},
                    {"id": "A0000000-0000-0000-0000-00000000000B", "text": "Vier", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-00000000000c", "text": "Drei", "is_correct": false}]') $$,
  '23514', 'question_answers_rules',
  'a payload naming one answer in lower and upper case is refused in the call'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-00000000000b',
       text => 'Welche Zahlen sind gerade? (geändert)', explanation => null,
       multiple_correct => true,
       answers => '[{"id": "a0000000-0000-0000-0000-00000000000b", "text": "Zwei", "is_correct": true},
                    {"id": "{a0000000-0000-0000-0000-00000000000b}", "text": "Vier", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-00000000000c", "text": "Drei", "is_correct": false}]') $$,
  '23514', 'question_answers_rules',
  'a payload naming one answer with and without braces is refused in the call'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-00000000000b',
       text => 'Welche Zahlen sind gerade? (geändert)', explanation => null,
       multiple_correct => true,
       answers => '[{"id": "a0000000-0000-0000-0000-00000000000b", "text": "Zwei", "is_correct": true},
                    {"id": "a000000000000000000000000000000b", "text": "Vier", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-00000000000c", "text": "Drei", "is_correct": false}]') $$,
  '23514', 'question_answers_rules',
  'a payload naming one answer with and without hyphens is refused in the call'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-00000000000b',
       text => 'Welche Zahlen sind gerade?', explanation => null,
       multiple_correct => true,
       answers => '[{"id": "a0000000-0000-0000-0000-00000000000b", "text": "Zwei", "is_correct": true},
                    {"id": "keine-uuid", "text": "Drei", "is_correct": false}]') $$,
  '22P02', null,
  'a payload with an answer id that is no uuid is refused with 22P02'
);

reset role;

select results_eq(
  $$ select id::text, text, is_correct from public.answers
     where question_id = 'e0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('a0000000-0000-0000-0000-000000000001', 'Paris', true),
            ('a0000000-0000-0000-0000-000000000002', 'Lyon', false) $$,
  'the refused save left the answers as they were'
);

select is(
  (select text from public.questions where id = 'e0000000-0000-0000-0000-000000000001'),
  'Was ist die Hauptstadt von Frankreich?',
  'the refused save left the question as it was'
);

select results_eq(
  $$ select id::text, text, is_correct from public.answers
     where question_id = 'e0000000-0000-0000-0000-00000000000b' order by sort_order $$,
  $$ values ('a0000000-0000-0000-0000-00000000000b', 'Zwei', true),
            ('a0000000-0000-0000-0000-00000000000c', 'Drei', false) $$,
  'the refused spellings left the multiple-choice answers as they were'
);

select is(
  (select text from public.questions where id = 'e0000000-0000-0000-0000-00000000000b'),
  'Welche Zahlen sind gerade?',
  'the refused spellings left the multiple-choice question as it was'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

-- Positive control, after the effects above: the same question saves with
-- each answer named once, in any spelling.
select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-00000000000b',
       text => 'Welche Zahlen sind gerade?', explanation => null,
       multiple_correct => true,
       answers => '[{"id": "A0000000-0000-0000-0000-00000000000B", "text": "Zwei", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-00000000000c", "text": "Drei", "is_correct": false}]') $$,
  'a payload naming each answer once, in any spelling, is accepted'
);

reset role;

select * from finish();
rollback;
