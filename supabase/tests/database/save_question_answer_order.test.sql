-- public.save_question(...): answers are reordered through the save (#84).
-- The question form moves answers up and down in its unsaved state (new
-- answers have no id yet, picked images are staged), so a separate reorder
-- call would clash with it; the save is the one database call instead.
-- `answers` is already the list in display order: save_question writes
-- sort_order = the answer's position in the payload (1..n) for every answer
-- it keeps or adds, existing and new alike, in its one transaction and under
-- the per-question advisory lock that internal.assign_answer_sort_order()
-- takes (hashtext('public.answers.sort_order'), hashtext(question_id)), so a
-- concurrent insert can't get a position the save hands out too.
--
-- Nothing else about save_question changes: it stays security invoker, and
-- every caller who isn't an admin still gets 42501 and nothing is written
-- (save_question.test.sql).
--
-- The route (decided at gate 1 of #84): authenticated gets
-- `update (sort_order) on public.answers`, no insert on it
-- (answers.test.sql). A new answer gets a position from the before-insert
-- trigger, then save_question updates it to its payload position in the
-- same transaction. The admin-only RLS on answers keeps the grant to admins,
-- so a direct PATCH of sort_order works for an admin and touches no row for
-- anyone else (below). No helper function is involved: the three reorder_*
-- functions are the only additions to function_privileges.test.sql's
-- allow-list, and schema internal, which that file doesn't scan, stays
-- closed to the API roles (below). Fixtures are created here as the owner,
-- independent of seed.sql, and vanish on rollback.
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(22);

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
   'Veröffentlichtes Quiz', 1, true);

insert into public.questions (id, quiz_id, text, multiple_correct, explanation, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farben hat die deutsche Flagge?', true, 'Schwarz, Rot, Gold.', 1),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'Was ist die Hauptstadt von Frankreich?', false, null, 2);

-- Gaps in sort_order on purpose: the save renumbers 1..n.
insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Schwarz', true, 2),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Rot', true, 5),
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001',
   'Grün', false, 9),
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000002',
   'Paris', true, 1),
  ('a0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000002',
   'Lyon', false, 2);

-- How a call ends: 'ok' or its sqlstate.
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

-- How a write ends: the number of rows it touched, or its sqlstate.
create function pg_temp.touched(statement text)
returns text
language plpgsql
as $fn$
declare
  touched integer;
begin
  execute statement;
  get diagnostics touched = row_count;
  return touched::text;
exception when others then
  return sqlstate;
end;
$fn$;

grant execute on function pg_temp.touched(text) to anon, authenticated;

-- A question's answers as 'text:is_correct:sort_order' by sort_order, read
-- as the owner (security definer, so a learner's call reads them too).
create function pg_temp.answers_of(question uuid)
returns text
language sql
security definer
as $fn$
  select coalesce(string_agg(a.text || ':' || a.is_correct || ':' || a.sort_order, ', '
                             order by a.sort_order), '')
  from public.answers a
  where a.question_id = question
$fn$;

grant execute on function pg_temp.answers_of(uuid) to anon, authenticated;

-- Whether this transaction holds the advisory lock (key1, key2), as
-- pg_advisory_xact_lock(int, int) takes it.
create function pg_temp.holds_lock(key1 integer, key2 integer)
returns boolean
language sql
as $fn$
  select exists (
    select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
      and l.objsubid = 2
      and l.classid::bigint = (key1::bigint & 4294967295)
      and l.objid::bigint = (key2::bigint & 4294967295))
$fn$;

grant execute on function pg_temp.holds_lock(integer, integer) to authenticated;

-- The flag question's answers in a new order: Grün, Schwarz, Rot.
select set_config('test.reordered', $$ select public.save_question(
  quiz_id => 'd0000000-0000-0000-0000-000000000001',
  question_id => 'e0000000-0000-0000-0000-000000000001',
  text => 'Welche Farben hat die deutsche Flagge?', explanation => 'Schwarz, Rot, Gold.',
  multiple_correct => true,
  answers => '[{"id": "a0000000-0000-0000-0000-000000000003", "text": "Grün", "is_correct": false},
               {"id": "a0000000-0000-0000-0000-000000000001", "text": "Schwarz", "is_correct": true},
               {"id": "a0000000-0000-0000-0000-000000000002", "text": "Rot", "is_correct": true}]') $$,
  true);

-- Callers who aren't admins: still refused, the order unchanged --------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is(
  pg_temp.outcome(current_setting('test.reordered')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  '42501 Schwarz:true:2, Rot:true:5, Grün:false:9',
  'a learner''s reordering save is refused with 42501 and the order is unchanged'
);

select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select is(
  pg_temp.outcome(current_setting('test.reordered')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  '42501 Schwarz:true:2, Rot:true:5, Grün:false:9',
  'an anonymous user''s reordering save is refused with 42501 and the order is unchanged'
);

select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.outcome(current_setting('test.reordered')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  '42501 Schwarz:true:2, Rot:true:5, Grün:false:9',
  'a reordering save without a user is refused with 42501 and the order is unchanged'
);

reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select is(
  pg_temp.outcome(current_setting('test.reordered')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  '42501 Schwarz:true:2, Rot:true:5, Grün:false:9',
  'anon''s reordering save is refused with 42501 (no execute grant) and the order is unchanged'
);

reset role;

-- admin (carol): existing answers in a new order -------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.outcome(current_setting('test.reordered')),
  'ok',
  'an admin saves the question with its answers in a new order'
);

select ok(
  pg_temp.holds_lock(pg_catalog.hashtext('public.answers.sort_order'),
    pg_catalog.hashtext('e0000000-0000-0000-0000-000000000001')),
  'the save took the question''s answer sort_order advisory lock, also without a new answer'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  'Grün:false:1, Schwarz:true:2, Rot:true:3',
  'the answers are stored in the payload''s order, renumbered 1..n, each keeping its mark'
);

select results_eq(
  $$ select id from public.answers where question_id = 'e0000000-0000-0000-0000-000000000001'
     order by sort_order $$,
  $$ values ('a0000000-0000-0000-0000-000000000003'::uuid),
            ('a0000000-0000-0000-0000-000000000001'::uuid),
            ('a0000000-0000-0000-0000-000000000002'::uuid) $$,
  'the reordered answers are the same rows, updated in place, not replaced'
);

-- admin: a new answer in the middle and one removed ----------------------------

select is(
  pg_temp.outcome($$ select public.save_question(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_id => 'e0000000-0000-0000-0000-000000000001',
    text => 'Welche Farben hat die deutsche Flagge?', explanation => 'Schwarz, Rot, Gold.',
    multiple_correct => true,
    answers => '[{"id": "a0000000-0000-0000-0000-000000000002", "text": "Rot", "is_correct": true},
                 {"text": "Gold", "is_correct": true},
                 {"id": "a0000000-0000-0000-0000-000000000001", "text": "Schwarz", "is_correct": true}]') $$),
  'ok',
  'an admin saves with a new answer between two existing ones and one answer left out'
);

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000001'),
  'Rot:true:1, Gold:true:2, Schwarz:true:3',
  'the new answer is stored at its position in the payload, not last, and the rest follow 1..n'
);

-- admin: a new question's answers ------------------------------------------------

select is(
  pg_temp.outcome($$ select public.save_question(
    quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
    text => 'Welcher Fluss fließt durch Köln?', explanation => null, multiple_correct => false,
    answers => '[{"text": "Main", "is_correct": false},
                 {"text": "Rhein", "is_correct": true},
                 {"text": "Elbe", "is_correct": false}]') $$),
  'ok',
  'an admin creates a question with three answers'
);

select results_eq(
  $$ select a.text, a.sort_order from public.answers a
     join public.questions q on q.id = a.question_id
     where q.text = 'Welcher Fluss fließt durch Köln?' order by a.sort_order $$,
  $$ values ('Main'::text, 1), ('Rhein'::text, 2), ('Elbe'::text, 3) $$,
  'a new question''s answers are stored in the payload''s order'
);

-- admin: the other question is left alone ---------------------------------------

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  'Paris:true:1, Lyon:false:2',
  'saving one question changed no other question''s answer order'
);

reset role;

-- A learner sees the saved order ---------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select text from public.answers where question_id = 'e0000000-0000-0000-0000-000000000001'
     order by sort_order $$,
  $$ values ('Rot'::text), ('Gold'::text), ('Schwarz'::text) $$,
  'a learner''s select by sort_order shows the answers in the saved order'
);

select throws_ok(
  $$ select is_correct from public.answers
     where question_id = 'e0000000-0000-0000-0000-000000000001' order by sort_order $$,
  '42501', null,
  'a learner still cannot select is_correct of the reordered answers'
);

reset role;

-- A direct PATCH of answers.sort_order (the column grant) --------------------
-- Lyon is visible to everyone (published quiz), so only RLS keeps the
-- non-admins' updates from touching it.

select set_config('test.patch',
  $$ update public.answers set sort_order = 7
     where id = 'a0000000-0000-0000-0000-000000000005' $$, true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is(
  pg_temp.touched(current_setting('test.patch')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  '0 Paris:true:1, Lyon:false:2',
  'a learner''s direct update of an answer''s sort_order touches no row (RLS), without an error'
);

select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select is(
  pg_temp.touched(current_setting('test.patch')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  '0 Paris:true:1, Lyon:false:2',
  'an anonymous user''s direct update of an answer''s sort_order touches no row (RLS), without an error'
);

select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.touched(current_setting('test.patch')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  '0 Paris:true:1, Lyon:false:2',
  'a direct update of an answer''s sort_order without a user touches no row (RLS), without an error'
);

reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select is(
  pg_temp.touched(current_setting('test.patch')) || ' ' ||
    pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  '42501 Paris:true:1, Lyon:false:2',
  'anon''s direct update of an answer''s sort_order is refused with 42501 (no grant) and the order is unchanged'
);

reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.touched(current_setting('test.patch')),
  '1',
  'an admin''s direct update of an answer''s sort_order touches the answer'
);

reset role;

select is(
  pg_temp.answers_of('e0000000-0000-0000-0000-000000000002'),
  'Paris:true:1, Lyon:false:7',
  'the admin''s direct sort_order update is stored'
);

-- No function route around the grants -------------------------------------
-- function_privileges.test.sql pins what anon and authenticated may execute
-- in public, private and graphql_public. Schema internal holds the trigger
-- functions; it stays closed to the API roles, so no helper there can be a
-- way to write sort_order (or anything else).

select ok(
  not has_schema_privilege('anon', 'internal', 'usage')
  and not has_schema_privilege('authenticated', 'internal', 'usage')
  and not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'internal'
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))),
  'schema internal stays closed: no API role has usage on it or may execute a function in it'
);

select * from finish();
rollback;
