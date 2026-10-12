-- public.reorder_questions(quiz_id, question_ids): the admin's one call that
-- puts a quiz's questions in a new order (#84), published quiz or not. It
-- takes the quiz and the full ordered list of its question ids and renumbers
-- every question of the quiz 1..n in that order, in one statement, so the
-- order changes atomically. sort_order stays out of the column grants (no
-- direct PATCH can write it); this function is the only way to change it
-- after the insert. The order is not a solution: reordering reveals no
-- is_correct or explanation and returns nothing.
--
-- The full-list contract: the list must be exactly the quiz's current
-- questions, each once. A list with an id missing, an id too many, an id of
-- another quiz or an unknown id, an id named twice, an empty or null list,
-- or an unknown or null quiz is refused and changes nothing, so a stale list
-- from a second tab can't drop or duplicate a position.
--
-- It takes the same transaction-scoped advisory lock as
-- internal.assign_question_sort_order() (hashtext('public.questions.sort_order'),
-- hashtext(quiz_id)), so a concurrent insert can't get a sort_order the
-- reorder also hands out.
--
-- Security definer with an empty search_path, guarded by private.is_admin()
-- first; executable by authenticated only (not anon, not PUBLIC). Every
-- refused call gets the same error, P0001 'not available' with no detail or
-- hint: a non-admin for an existing and an unknown quiz alike, and an admin
-- for a list that breaks the contract. anon's refusal is the missing grant
-- (42501). Fixtures are created here as the owner, independent of seed.sql,
-- and vanish on rollback.
begin;
select plan(53);

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
   'Anderes Quiz', 2, true);

-- Gaps in sort_order on purpose: the reorder renumbers 1..n.
insert into public.questions (id, quiz_id, text, explanation, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Erste Frage?', 'Geheim 1', 5),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'Zweite Frage?', 'Geheim 2', 7),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001',
   'Dritte Frage?', 'Geheim 3', 9),
  -- in the other quiz
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002',
   'Frage im anderen Quiz?', null, 1);

insert into public.answers (question_id, text, is_correct, sort_order)
select q.id, v.text, v.is_correct, v.sort_order
from public.questions q
cross join (values ('Ja', true, 1), ('Nein', false, 2)) as v(text, is_correct, sort_order)
where q.id::text like 'e0000000-0000-0000-0000-00000000000_';

-- How a call ends: 'ok' or 'sqlstate|message|detail|hint'.
create function pg_temp.outcome(statement text)
returns text
language plpgsql
as $fn$
declare
  state text;
  message text;
  detail text;
  hint text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics
    state = returned_sqlstate,
    message = message_text,
    detail = pg_exception_detail,
    hint = pg_exception_hint;
  return concat_ws('|', state, message, detail, hint);
end;
$fn$;

grant execute on function pg_temp.outcome(text) to anon, authenticated;

-- Every question with its sort_order, as the owner sees it (security definer, so
-- a learner's call reads past RLS too): 'id:sort_order, ...' by id.
create function pg_temp.question_orders()
returns text
language sql
security definer
as $fn$
  select string_agg(right(q.id::text, 1) || ':' || q.sort_order, ', ' order by q.id)
  from public.questions q
  where q.id::text like 'e0000000-0000-0000-0000-00000000000_'
$fn$;

grant execute on function pg_temp.question_orders() to anon, authenticated;

-- A refused call: its outcome, and whether every sort_order is as before.
create function pg_temp.refused(statement text)
returns text
language plpgsql
as $fn$
declare
  before text := pg_temp.question_orders();
  result text := pg_temp.outcome(statement);
begin
  return result || case when pg_temp.question_orders() = before then ' (unchanged)' else ' (changed)' end;
end;
$fn$;

grant execute on function pg_temp.refused(text) to anon, authenticated;

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

select set_config('test.refused', 'P0001|not available|| (unchanged)', true);

-- Structure and privileges (catalog) ----------------------------------------

select has_function('public', 'reorder_questions', array['uuid', 'uuid[]'],
  'public.reorder_questions(uuid, uuid[]) exists');

select results_eq(
  $$ select a.name::text collate "default"
     from pg_proc p, unnest(p.proargnames) with ordinality as a(name, n)
     where p.oid = to_regprocedure('public.reorder_questions(uuid, uuid[])')
     order by a.n $$,
  $$ values ('quiz_id'::text), ('question_ids'::text) $$,
  'reorder_questions takes quiz_id and question_ids'
);

select ok(
  coalesce((
    select p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_questions(uuid, uuid[])')
  ), false),
  'reorder_questions is security definer with an empty search_path'
);

select ok(
  coalesce((
    select p.provolatile = 'v'
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_questions(uuid, uuid[])')
  ), false),
  'reorder_questions is a write: volatile'
);

select ok(
  coalesce(
    not has_function_privilege('anon', to_regprocedure('public.reorder_questions(uuid, uuid[])'),
      'execute'),
    false),
  'anon cannot execute reorder_questions'
);

select ok(
  coalesce(
    has_function_privilege('authenticated',
      to_regprocedure('public.reorder_questions(uuid, uuid[])'), 'execute'),
    false),
  'authenticated can execute reorder_questions (the function decides who is an admin)'
);

select ok(
  coalesce((
    select not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_questions(uuid, uuid[])')
  ), false),
  'PUBLIC cannot execute reorder_questions'
);

-- The order is not a solution, and the call returns nothing it could leak.
select ok(
  coalesce((
    select p.prorettype = 'void'::regtype and not p.proretset
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_questions(uuid, uuid[])')
  ), false),
  'reorder_questions returns void'
);

-- sort_order stays out of the column grants: the function is the only way.
select ok(
  not has_column_privilege('authenticated', 'public.questions', 'sort_order', 'update'),
  'authenticated still has no update grant on questions.sort_order'
);

-- learner (alice) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner''s valid reorder is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-0000000000ff',
    question_ids => array['e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner is refused the same way for an unknown quiz'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner is refused the same way for a list an admin would be refused for'
);

-- A token that claims an admin role: the role comes from profiles only.
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "user_role": "admin", "app_metadata": {"role": "admin"}, "user_metadata": {"role": "admin"}}',
  true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner whose token claims an admin role is refused and changes nothing'
);

reset role;

-- anonymous user ------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an anonymous user''s valid reorder is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-0000000000ff',
    question_ids => array['e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an anonymous user is refused the same way for an unknown quiz'
);

reset role;

-- authenticated without a user ----------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'authenticated with empty claims is refused with only ''not available'' and changes nothing'
);

select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'authenticated with claims but no sub is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-0000000000ff',
    question_ids => array['e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'authenticated with claims but no sub is refused the same way for an unknown quiz'
);

-- A sub that names no profile (a deleted user's token).
select set_config('request.jwt.claims',
  '{"sub": "99999999-9999-9999-9999-999999999999", "role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'a token for a user without a profile is refused with only ''not available'' and changes nothing'
);

reset role;

-- the owner without claims --------------------------------------------------

select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'the owner without claims (no user) is refused with only ''not available'' and changes nothing'
);

-- anon ----------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$,
  '42501', null,
  'anon cannot call reorder_questions (no execute grant)'
);

select throws_ok(
  $$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-0000000000ff',
    question_ids => array['e0000000-0000-0000-0000-000000000001']::uuid[]) $$,
  '42501', null,
  'anon cannot call reorder_questions for an unknown quiz either (no execute grant)'
);

-- Also with an admin's sub in the claims: anon stays anon.
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "anon"}', true);

select throws_ok(
  $$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$,
  '42501', null,
  'anon cannot call reorder_questions even with an admin''s sub in the claims'
);

reset role;

select is(
  pg_temp.question_orders(),
  '1:5, 2:7, 3:9, 4:1',
  'no refused caller changed any sort_order'
);

-- admin (carol): calls that break the full-list contract ---------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a question missing is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002',
                      'e0000000-0000-0000-0000-000000000004']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a question of another quiz added is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000004']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a question of another quiz in place of one of its own is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-0000000000ff']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with an unknown question id is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002',
                      'e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list naming a question twice is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list naming a question twice in place of another is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003', null,
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a null id is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array[]::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s empty list is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => null) $$),
  current_setting('test.refused'),
  'an admin''s null list is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-0000000000ff',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s reorder for an unknown quiz is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-0000000000ff',
    question_ids => array[]::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s empty list for an unknown quiz is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => null,
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s reorder for a null quiz is refused and changes nothing'
);

-- The other quiz's question under the wrong quiz.
select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000004']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list of another quiz''s question is refused and changes nothing'
);

-- admin (carol): a valid reorder ----------------------------------------------

select is(
  pg_temp.outcome($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  'ok',
  'an admin reorders a quiz''s questions with the full ordered list'
);

select ok(
  pg_temp.holds_lock(pg_catalog.hashtext('public.questions.sort_order'),
    pg_catalog.hashtext('d0000000-0000-0000-0000-000000000001')),
  'the reorder took the quiz''s sort_order advisory lock, the one inserts take'
);

select results_eq(
  $$ select id, sort_order from public.questions
     where quiz_id = 'd0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('e0000000-0000-0000-0000-000000000003'::uuid, 1),
            ('e0000000-0000-0000-0000-000000000001'::uuid, 2),
            ('e0000000-0000-0000-0000-000000000002'::uuid, 3) $$,
  'the admin sees the questions renumbered 1..n in the new order'
);

-- A second reorder from the renumbered state.
select is(
  pg_temp.outcome($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000002',
                      'e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  'ok',
  'an admin reorders the same quiz again'
);

reset role;

select is(
  pg_temp.question_orders(),
  '1:3, 2:2, 3:1, 4:1',
  'the second reorder renumbered the quiz''s questions and left the other quiz''s alone'
);

select results_eq(
  $$ select count(*)::integer from public.questions
     where quiz_id = 'd0000000-0000-0000-0000-000000000001' $$,
  $$ values (3) $$,
  'the reorder neither added nor removed a question'
);

-- A learner sees the new order -------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select text from public.questions
     where quiz_id = 'd0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('Dritte Frage?'::text), ('Zweite Frage?'::text), ('Erste Frage?'::text) $$,
  'a learner''s select by sort_order shows the new order'
);

reset role;

-- A list from before a question was added is stale: refused.
insert into public.questions (id, quiz_id, text) values
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001',
   'Neue Frage?');

insert into public.answers (question_id, text, is_correct) values
  ('e0000000-0000-0000-0000-000000000005', 'Ja', true),
  ('e0000000-0000-0000-0000-000000000005', 'Nein', false);

select is(
  (select sort_order from public.questions where id = 'e0000000-0000-0000-0000-000000000005'),
  4,
  'a question inserted after the reorder goes last, after the renumbered ones'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002',
                      'e0000000-0000-0000-0000-000000000003']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s stale list from before a question was added is refused and changes nothing'
);

select is(
  pg_temp.outcome($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000005',
                      'e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000002',
                      'e0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  'ok',
  'an admin reorders a list that includes the new question'
);

reset role;

select results_eq(
  $$ select id, sort_order from public.questions
     where quiz_id = 'd0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('e0000000-0000-0000-0000-000000000005'::uuid, 1),
            ('e0000000-0000-0000-0000-000000000003'::uuid, 2),
            ('e0000000-0000-0000-0000-000000000002'::uuid, 3),
            ('e0000000-0000-0000-0000-000000000001'::uuid, 4) $$,
  'the new question moved first and the rest followed, 1..n'
);

-- An admin who loses the role --------------------------------------------------

update public.profiles set role = 'learner' where id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_questions(
    quiz_id => 'd0000000-0000-0000-0000-000000000001',
    question_ids => array['e0000000-0000-0000-0000-000000000001',
                      'e0000000-0000-0000-0000-000000000002',
                      'e0000000-0000-0000-0000-000000000003',
                      'e0000000-0000-0000-0000-000000000005']::uuid[]) $$),
  current_setting('test.refused'),
  'a former admin is refused with only ''not available'' as soon as the role is gone'
);

reset role;

-- Nothing else was written ----------------------------------------------------

select is_empty(
  $$ select 1 from public.attempts where started_at = now() $$,
  'reordering started no attempt'
);

select results_eq(
  $$ select id, sort_order from public.quizzes
     where category_id = 'c0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('d0000000-0000-0000-0000-000000000001'::uuid, 1),
            ('d0000000-0000-0000-0000-000000000002'::uuid, 2) $$,
  'reordering questions left the quizzes as they were'
);

select results_eq(
  $$ select text, explanation from public.questions
     where id = 'e0000000-0000-0000-0000-000000000003' $$,
  $$ values ('Dritte Frage?'::text, 'Geheim 3'::text) $$,
  'reordering changed neither text nor explanation'
);

select results_eq(
  $$ select a.text, a.is_correct, a.sort_order from public.answers a
     where a.question_id = 'e0000000-0000-0000-0000-000000000003' order by a.sort_order $$,
  $$ values ('Ja'::text, true, 1), ('Nein'::text, false, 2) $$,
  'reordering questions left their answers and answer order as they were'
);

select * from finish();
rollback;
