-- public.save_question(quiz_id, question_id, text, explanation,
-- multiple_correct, answers): the admin's one write of a question with its
-- answers, in one transaction (#82). PostgREST runs every request in its own
-- transaction, so saving a question and its answers row by row would leave
-- a question that breaks the rules between two requests; this function is
-- the editor's save path instead.
--
-- It runs as SECURITY INVOKER, so the column grants and RLS policies of
-- questions and answers still decide who may write what: no is_correct or
-- explanation can be read through it, and it returns only the question's id.
-- Executable by authenticated only (not anon, not PUBLIC). Every caller who
-- isn't an admin gets 42501 and nothing is written, for a new and an
-- existing question alike, and also for payloads an admin would get 23514,
-- 23503 or 'not available' for: the refusal comes first, so it tells a
-- non-admin nothing about which questions, quizzes or answers exist.
--
-- question_id null creates a question in quiz_id (sort_order: the next in
-- the quiz); otherwise it updates that question's text, explanation and
-- multiple_correct (it never moves it). `answers` is a JSON array of
-- {id, text, is_correct} in display order: an element with the id of one of
-- the question's answers updates it (its sort_order stays), one without an
-- id (missing or null) is a new answer (sort_order: the next in the
-- question), and the question's answers the array leaves out are deleted.
-- An unknown question id, an answer id of another question, or a quiz_id
-- the question doesn't belong to (no move), raises P0001 'not available' and
-- writes nothing.
--
-- The rules (question_rules.test.sql) are checked before the call returns,
-- so a refused save raises 23514 in the call itself and leaves the stored
-- rows as they were: at least two answers, at least one correct, exactly one
-- for single choice, and every answer text non-blank.
-- Fixtures are created here as the owner, independent of seed.sql, and
-- vanish on rollback.
--
-- Re-spec (#83): save_question also writes images, the question's through
-- two trailing parameters image_path and image_alt (default null, no image)
-- and each answer's through image_path and image_alt in its `answers`
-- element (save_question_images.test.sql). Only the catalog checks change:
-- the signature gains (text, text), the argument names gain image_path and
-- image_alt, and the six-argument overload must be gone. The calls below
-- name their arguments and send no image, so they stay as they were.
begin;
select plan(72);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlichtes Quiz', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 2, false);

insert into public.questions (id, quiz_id, text, multiple_correct, explanation, sort_order) values
  -- single choice in a published quiz
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Was ist die Hauptstadt von Frankreich?', false, 'Paris.', 1),
  -- multiple choice in the draft, two correct answers
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   'Welche Farben hat die deutsche Flagge?', true, null, 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Paris', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Lyon', false, 2),
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001',
   'Marseille', false, 3),
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000002',
   'Schwarz', true, 1),
  ('a0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000002',
   'Rot', true, 2),
  ('a0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000002',
   'Grün', false, 3);


-- How a call ends: 'ok' or its sqlstate, so a refusal can be compared
-- across callers.
create function pg_temp.outcome(statement text)
returns text
language plpgsql
as $fn$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate;
end;
$fn$;

grant execute on function pg_temp.outcome(text) to anon, authenticated;

-- The payloads an admin is refused or told 'not available' for, sent by a
-- caller who isn't an admin: each must end in 42501 like a valid one.
create function pg_temp.probe(kind text)
returns text
language plpgsql
as $fn$
begin
  return pg_temp.outcome(case kind
    when 'unknown question' then
      $q$ select public.save_question(
            quiz_id => 'd0000000-0000-0000-0000-000000000001',
            question_id => 'e0000000-0000-0000-0000-0000000000ff',
            text => 'Sonde?', explanation => null, multiple_correct => false,
            answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $q$
    when 'unknown quiz' then
      $q$ select public.save_question(
            quiz_id => 'd0000000-0000-0000-0000-0000000000ff', question_id => null,
            text => 'Sonde?', explanation => null, multiple_correct => false,
            answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $q$
    when 'one answer' then
      $q$ select public.save_question(
            quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
            text => 'Sonde?', explanation => null, multiple_correct => false,
            answers => '[{"text": "A", "is_correct": true}]') $q$
    when 'none correct' then
      $q$ select public.save_question(
            quiz_id => 'd0000000-0000-0000-0000-000000000001',
            question_id => 'e0000000-0000-0000-0000-000000000001',
            text => 'Sonde?', explanation => null, multiple_correct => false,
            answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": false},
                         {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $q$
    when 'foreign answer' then
      $q$ select public.save_question(
            quiz_id => 'd0000000-0000-0000-0000-000000000001',
            question_id => 'e0000000-0000-0000-0000-000000000001',
            text => 'Sonde?', explanation => null, multiple_correct => false,
            answers => '[{"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": true},
                         {"id": "a0000000-0000-0000-0000-000000000004", "text": "Gekapert", "is_correct": false}]') $q$
  end);
end;
$fn$;

grant execute on function pg_temp.probe(text) to anon, authenticated;

-- The stored answers of a question, as 'text:is_correct' by sort_order,
-- read as the owner.
create function pg_temp.answers_of(question uuid)
returns text
language sql
as $fn$
  select coalesce(string_agg(a.text || ':' || a.is_correct, ', ' order by a.sort_order), '')
  from public.answers a
  where a.question_id = question
$fn$;

-- The sort_order values of a question's answers, ascending.
create function pg_temp.sort_orders(question uuid)
returns integer[]
language sql
as $fn$
  select coalesce(array_agg(a.sort_order order by a.sort_order), '{}')
  from public.answers a
  where a.question_id = question
$fn$;

-- Structure and privileges (catalog) ----------------------------------------

select has_function('public', 'save_question',
  array['uuid', 'uuid', 'text', 'text', 'boolean', 'jsonb', 'text', 'text'],
  'public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text) exists');

select results_eq(
  $$ select a.name::text collate "default"
     from pg_proc p,
          unnest(p.proargnames) with ordinality as a(name, n)
     where p.oid = to_regprocedure('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)')
     order by a.n $$,
  $$ values ('quiz_id'::text), ('question_id'::text), ('text'::text), ('explanation'::text),
            ('multiple_correct'::text), ('answers'::text), ('image_path'::text),
            ('image_alt'::text) $$,
  'save_question takes quiz_id, question_id, text, explanation, multiple_correct, answers, image_path and image_alt by name'
);

select hasnt_function('public', 'save_question',
  array['uuid', 'uuid', 'text', 'text', 'boolean', 'jsonb'],
  'the six-argument save_question without images is gone, not left behind as an overload');

select ok(
  coalesce((
    select not p.prosecdef
    from pg_proc p
    where p.oid = to_regprocedure('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)')
  ), false),
  'save_question is security invoker, so the grants and RLS of questions and answers apply'
);

select ok(
  coalesce((
    select not p.proretset and p.prorettype = 'uuid'::regtype
    from pg_proc p
    where p.oid = to_regprocedure('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)')
  ), false),
  'save_question returns only the question''s id, no row with a solution in it'
);

select ok(
  coalesce(not has_function_privilege('anon',
    to_regprocedure('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)'), 'execute'),
    false),
  'anon cannot execute save_question'
);

select ok(
  coalesce(has_function_privilege('authenticated',
    to_regprocedure('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)'), 'execute'),
    false),
  'authenticated can execute save_question (grants and RLS decide who may write)'
);

select ok(
  coalesce((
    select not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
    from pg_proc p
    where p.oid = to_regprocedure('public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)')
  ), false),
  'PUBLIC cannot execute save_question'
);

-- admin (carol): creating ---------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ select set_config('test.single', public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Was ist die Hauptstadt von Italien?', explanation => 'Rom, seit 1871.',
       multiple_correct => false,
       answers => '[{"id": null, "text": "Mailand", "is_correct": false},
                    {"id": null, "text": "Rom", "is_correct": true},
                    {"text": "Neapel", "is_correct": false}]')::text, true) $$,
  'an admin creates a single-choice question with three answers, one correct'
);

select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Welche Städte liegen an der Donau?', explanation => null,
       multiple_correct => true,
       answers => '[{"text": "Wien", "is_correct": true},
                    {"text": "Prag", "is_correct": false},
                    {"text": "Budapest", "is_correct": true}]') $$,
  'an admin creates a multiple-choice question with two correct answers of three'
);

select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Ist die Erde rund?', explanation => null, multiple_correct => false,
       answers => '[{"text": "Ja", "is_correct": true}, {"text": "Nein", "is_correct": false}]') $$,
  'an admin creates a question with exactly two answers, the fewest allowed'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Nur eine Antwort?', explanation => null, multiple_correct => false,
       answers => '[{"text": "Ja", "is_correct": true}]') $$,
  '23514', null,
  'a new question with a single answer is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Ohne Antworten?', explanation => null, multiple_correct => false,
       answers => '[]') $$,
  '23514', null,
  'a new question without answers is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Keine richtig?', explanation => null, multiple_correct => true,
       answers => '[{"text": "A", "is_correct": false}, {"text": "B", "is_correct": false}]') $$,
  '23514', null,
  'a new question without a correct answer is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Zwei richtig bei Einfachauswahl?', explanation => null, multiple_correct => false,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": true}]') $$,
  '23514', null,
  'a new single-choice question with two correct answers is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002', question_id => null,
       text => 'Leere Antwort?', explanation => null, multiple_correct => false,
       answers => E'[{"text": "A", "is_correct": true}, {"text": " \\t\\n", "is_correct": false}]') $$,
  '23514', null,
  'a new question with an answer whose text is only spaces, tabs and line breaks is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-0000000000ff', question_id => null,
       text => 'Verwaist?', explanation => null, multiple_correct => false,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $$,
  '23503', null,
  'a new question in a quiz that does not exist is refused'
);

reset role;

select results_eq(
  $$ select quiz_id, text, explanation, multiple_correct, sort_order from public.questions
     where id = current_setting('test.single', true)::uuid $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid,
             'Was ist die Hauptstadt von Italien?'::text, 'Rom, seit 1871.'::text, false, 2) $$,
  'save_question returned the new question''s id; it is stored with the next sort_order in its quiz'
);

select is(
  pg_temp.answers_of(current_setting('test.single', true)::uuid),
  'Mailand:false, Rom:true, Neapel:false',
  'the new single-choice question''s answers are stored in the given order, with is_correct'
);

select is(
  pg_temp.sort_orders(current_setting('test.single', true)::uuid),
  array[1, 2, 3],
  'the new question''s answers get sort_order 1, 2 and 3'
);

select is(
  pg_temp.answers_of((select id from public.questions where text = 'Welche Städte liegen an der Donau?')),
  'Wien:true, Prag:false, Budapest:true',
  'the new multiple-choice question''s answers are stored with both correct ones'
);

select results_eq(
  $$ select multiple_correct, explanation, sort_order from public.questions
     where text = 'Welche Städte liegen an der Donau?' $$,
  $$ values (true, null::text, 3) $$,
  'the multiple-choice question is stored as such, without an explanation, after the first'
);

select is_empty(
  $$ select 1 from public.questions
     where text in ('Nur eine Antwort?', 'Ohne Antworten?', 'Keine richtig?',
                    'Zwei richtig bei Einfachauswahl?', 'Leere Antwort?', 'Verwaist?') $$,
  'the refused saves left no question behind'
);

select is_empty(
  $$ select 1 from public.answers a
     where not exists (select 1 from public.questions q where q.id = a.question_id)
        or a.text in ('A', 'B') $$,
  'the refused saves left no answer behind'
);

-- admin (carol): editing ----------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

-- Moves the correct mark from Paris to Lyon, renames Marseille, adds Nizza
-- and drops nothing: one call, which row by row would need a moment with
-- two or no correct answers.
select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Welche Stadt ist die Hauptstadt Frankreichs?', explanation => 'Paris, an der Seine.',
       multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": false},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000003", "text": "Marseille (Provence)", "is_correct": false},
                    {"id": null, "text": "Nizza", "is_correct": false}]') $$,
  'an admin moves the correct mark of a single-choice question to another answer in one save'
);

-- Drops Grün and Rot, keeps Schwarz correct, adds Gold as correct.
select lives_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-000000000002',
       text => 'Welche Farben hat die deutsche Flagge?', explanation => null,
       multiple_correct => true,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000004", "text": "Schwarz", "is_correct": true},
                    {"text": "Gold", "is_correct": true}]') $$,
  'an admin removes answers left out of the list and adds a new one'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-000000000002',
       text => 'Welche Farben hat die deutsche Flagge?', explanation => null,
       multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000004", "text": "Schwarz", "is_correct": true},
                    {"text": "Gold", "is_correct": true}]') $$,
  '23514', null,
  'switching a question with two correct answers from multiple to single choice is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Welche Stadt ist die Hauptstadt Frankreichs?', explanation => null,
       multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": true}]') $$,
  '23514', null,
  'an edit that leaves a single answer is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Welche Stadt ist die Hauptstadt Frankreichs?', explanation => null,
       multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": false},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$,
  '23514', null,
  'an edit that leaves no correct answer is refused'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-0000000000ff',
       text => 'Unbekannt?', explanation => null, multiple_correct => false,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $$,
  'P0001', 'not available',
  'an edit of a question that does not exist is refused with not available'
);

-- An answer id of the other question: not this question's, so not taken over.
select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Welche Stadt ist die Hauptstadt Frankreichs?', explanation => null,
       multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000004", "text": "Gekapert", "is_correct": false}]') $$,
  'P0001', 'not available',
  'an edit that names an answer of another question is refused with not available'
);

-- The question belongs to the published quiz; naming the draft must not
-- move it there (nor save it in place while ignoring quiz_id).
select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Verschoben?', explanation => null, multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$,
  'P0001', 'not available',
  'an edit that names another quiz than the question''s own is refused with not available, never a move'
);

reset role;

select results_eq(
  $$ select quiz_id, text, explanation, multiple_correct, sort_order from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid,
             'Welche Stadt ist die Hauptstadt Frankreichs?'::text, 'Paris, an der Seine.'::text,
             false, 1) $$,
  'the edited question keeps its quiz and sort_order, with the new text and explanation'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  'Paris:false, Lyon:true, Marseille (Provence):false, Nizza:false',
  'the edited answers are stored, the new one last, and Lyon is now the only correct one'
);

select is(
  pg_temp.sort_orders('e0000000-0000-0000-0000-000000000001'),
  array[1, 2, 3, 4],
  'existing answers keep their sort_order and the new one gets the next'
);

select results_eq(
  $$ select id from public.answers where question_id = 'e0000000-0000-0000-0000-000000000001'
       and id in ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
                  'a0000000-0000-0000-0000-000000000003')
     order by sort_order $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid),
            ('a0000000-0000-0000-0000-000000000002'::uuid),
            ('a0000000-0000-0000-0000-000000000003'::uuid) $$,
  'the answers named by id were updated in place, not replaced'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  'Schwarz:true, Gold:true',
  'the answers left out were deleted, and the refused switch to single choice changed nothing'
);

select results_eq(
  $$ select multiple_correct from public.questions
     where id = 'e0000000-0000-0000-0000-000000000002' $$,
  $$ values (true) $$,
  'the question refused the switch to single choice and is still multiple choice'
);

select results_eq(
  $$ select question_id, text from public.answers
     where id = 'a0000000-0000-0000-0000-000000000004' $$,
  $$ values ('e0000000-0000-0000-0000-000000000002'::uuid, 'Schwarz'::text) $$,
  'the other question''s answer named in a refused save stays where and as it was'
);

select is_empty(
  $$ select 1 from public.questions where text = 'Unbekannt?' $$,
  'an edit of an unknown question creates nothing'
);

-- The admin still can't read the solutions through a select.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select throws_ok(
  $$ select is_correct from public.answers
     where question_id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'after saving, an admin still cannot select answers.is_correct'
);

reset role;

-- learner (alice) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
       text => 'Vom Lerner?', explanation => null, multiple_correct => false,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $$,
  '42501', null,
  'a learner cannot create a question through save_question'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Vom Lerner geändert?', explanation => 'Vom Lerner', multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$,
  '42501', null,
  'a learner cannot edit a question they can see through save_question'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-000000000002',
       text => 'Vom Lerner geändert?', explanation => null, multiple_correct => true,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $$,
  '42501', null,
  'a learner cannot edit a question of an unpublished quiz through save_question'
);

select is(pg_temp.probe('unknown question'), '42501',
  'a learner editing a question that does not exist gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('unknown quiz'), '42501',
  'a learner creating a question in a quiz that does not exist gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('one answer'), '42501',
  'a learner creating a question with a single answer gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('none correct'), '42501',
  'a learner saving a question with no correct answer gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('foreign answer'), '42501',
  'a learner naming an answer of another question gets 42501, the same refusal as for a valid save');

reset role;

-- anonymous user ------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
       text => 'Von Anonym?', explanation => null, multiple_correct => false,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $$,
  '42501', null,
  'an anonymous user cannot create a question through save_question'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Von Anonym geändert?', explanation => null, multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$,
  '42501', null,
  'an anonymous user cannot edit a question through save_question'
);

select is(pg_temp.probe('unknown question'), '42501',
  'an anonymous user editing a question that does not exist gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('unknown quiz'), '42501',
  'an anonymous user creating a question in a quiz that does not exist gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('one answer'), '42501',
  'an anonymous user creating a question with a single answer gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('none correct'), '42501',
  'an anonymous user saving a question with no correct answer gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('foreign answer'), '42501',
  'an anonymous user naming an answer of another question gets 42501, the same refusal as for a valid save');

reset role;

-- authenticated without a user ----------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
       text => 'Ohne Benutzer?', explanation => null, multiple_correct => false,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $$,
  '42501', null,
  'authenticated without a user cannot create a question through save_question'
);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Ohne Benutzer geändert?', explanation => null, multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$,
  '42501', null,
  'authenticated without a user cannot edit a question through save_question'
);

select is(pg_temp.probe('unknown question'), '42501',
  'authenticated without a user editing a question that does not exist gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('unknown quiz'), '42501',
  'authenticated without a user creating a question in a quiz that does not exist gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('one answer'), '42501',
  'authenticated without a user creating a question with a single answer gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('none correct'), '42501',
  'authenticated without a user saving a question with no correct answer gets 42501, the same refusal as for a valid save');

select is(pg_temp.probe('foreign answer'), '42501',
  'authenticated without a user naming an answer of another question gets 42501, the same refusal as for a valid save');

-- A JWT that claims to be an admin: the role comes from profiles only.
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "user_role": "admin", "app_metadata": {"role": "admin"}, "user_metadata": {"role": "admin"}}',
  true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Mit falschem Token?', explanation => null, multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$,
  '42501', null,
  'a learner whose token claims an admin role cannot save through save_question'
);

reset role;

-- anon ----------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
       text => 'Von anon?', explanation => null, multiple_correct => false,
       answers => '[{"text": "A", "is_correct": true}, {"text": "B", "is_correct": false}]') $$,
  '42501', null,
  'anon cannot call save_question (no execute grant)'
);

-- Also with an admin's sub in the claims: anon stays anon.
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "anon"}', true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Von anon geändert?', explanation => null, multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$,
  '42501', null,
  'anon cannot call save_question even with an admin''s sub in the claims'
);

reset role;

-- An admin who loses the role -------------------------------------------------

update public.profiles set role = 'learner' where id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.outcome($$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Vom früheren Admin?', explanation => null, multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000002", "text": "Lyon", "is_correct": false}]') $$),
  '42501',
  'a former admin cannot save as soon as the role is gone'
);

reset role;

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Nothing the refused callers sent was written --------------------------------

select results_eq(
  $$ select text, explanation from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Welche Stadt ist die Hauptstadt Frankreichs?'::text, 'Paris, an der Seine.'::text) $$,
  'the refused callers'' edits left the question as the admin saved it'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  'Paris:false, Lyon:true, Marseille (Provence):false, Nizza:false',
  'the refused callers'' edits left its answers as the admin saved them'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  'Schwarz:true, Gold:true',
  'the refused callers'' edits left the draft question''s answers as they were'
);

select is_empty(
  $$ select 1 from public.questions
     where text in ('Vom Lerner?', 'Von Anonym?', 'Ohne Benutzer?', 'Von anon?', 'Sonde?',
                    'Verschoben?') $$,
  'the refused callers created no question'
);

select is_empty(
  $$ select 1 from public.answers where text in ('A', 'B', 'Gekapert') $$,
  'the refused callers created no answer'
);

select * from finish();
rollback;
