-- public.admin_answers(question_id): the admin's read of one question's
-- answers with is_correct, for the question edit form (#82). It is the only
-- way an admin reads `answers.is_correct` (no role may select that column),
-- the counterpart of admin_question() for the explanation, and it must never
-- become a way for anyone else: security definer with an empty search_path,
-- guarded by private.is_admin(), executable by authenticated only (not
-- anon, not PUBLIC), returning a table of its own rather than
-- `setof public.answers`, so a later column of answers doesn't reach the
-- client through it.
--
-- Every caller that may execute it but isn't an admin gets the same error,
-- P0001 'not available' with no detail or hint, for an existing question and
-- an unknown id alike, so it reveals nothing about which questions exist or
-- which answers are correct. anon has no execute grant, so its refusal is the
-- missing grant (42501). For an admin an unknown id (or a question without
-- answers) returns no row. Fixtures are created here as the owner,
-- independent of seed.sql, and vanish on rollback.
begin;
select plan(36);

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

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  -- in a published quiz: a learner sees the answers, never is_correct
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farben hat die deutsche Flagge?', true, 1),
  -- in an unpublished quiz
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   'Frage im Entwurf?', false, 1);

-- Stored out of sort_order on purpose: the function has to order them.
insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001',
   'Grün', false, 3),
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Schwarz', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Rot', true, 2),
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000002',
   'Ja', false, 1),
  ('a0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000002',
   'Nein', true, 2);

-- How a call ends: 'ok' or 'sqlstate|message|detail|hint', so an assertion
-- can check that a refusal carries nothing but 'not available'.
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

-- The refusal every non-admin caller with the execute grant gets.
select set_config('test.refusal', 'P0001|not available||', true);

-- Structure and privileges (catalog) ----------------------------------------

select has_function('public', 'admin_answers', array['uuid'],
  'public.admin_answers(uuid) exists');

select ok(
  coalesce((
    select p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))
    from pg_proc p
    where p.oid = to_regprocedure('public.admin_answers(uuid)')
  ), false),
  'admin_answers is security definer with an empty search_path'
);

select ok(
  coalesce((
    select p.proretset and p.prorettype = 'record'::regtype
    from pg_proc p
    where p.oid = to_regprocedure('public.admin_answers(uuid)')
  ), false),
  'admin_answers returns a table of its own, not setof public.answers'
);

select results_eq(
  $$ select a.name::text collate "default"
     from pg_proc p,
          unnest(p.proargnames, p.proargmodes::text[]) with ordinality as a(name, mode, n)
     where p.oid = to_regprocedure('public.admin_answers(uuid)') and a.mode = 't'
     order by a.n $$,
  $$ values ('id'::text), ('text'::text), ('is_correct'::text), ('sort_order'::text) $$,
  'admin_answers returns id, text, is_correct and sort_order, nothing else'
);

select ok(
  coalesce((
    select p.provolatile in ('s', 'i')
    from pg_proc p
    where p.oid = to_regprocedure('public.admin_answers(uuid)')
  ), false),
  'admin_answers is a read: not volatile'
);

select ok(
  coalesce(
    not has_function_privilege('anon', to_regprocedure('public.admin_answers(uuid)'), 'execute'),
    false),
  'anon cannot execute admin_answers'
);

select ok(
  coalesce(
    has_function_privilege('authenticated', to_regprocedure('public.admin_answers(uuid)'), 'execute'),
    false),
  'authenticated can execute admin_answers (the function decides who is an admin)'
);

select ok(
  coalesce((
    select not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
    from pg_proc p
    where p.oid = to_regprocedure('public.admin_answers(uuid)')
  ), false),
  'PUBLIC cannot execute admin_answers'
);

-- admin (carol) -------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, text, is_correct, sort_order
     from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid, 'Schwarz'::text, true, 1),
            ('a0000000-0000-0000-0000-000000000002'::uuid, 'Rot'::text, true, 2),
            ('a0000000-0000-0000-0000-000000000003'::uuid, 'Grün'::text, false, 3) $$,
  'an admin reads a question''s answers with is_correct, by sort_order'
);

select results_eq(
  $$ select id, text, is_correct, sort_order
     from public.admin_answers('e0000000-0000-0000-0000-000000000002') $$,
  $$ values ('a0000000-0000-0000-0000-000000000004'::uuid, 'Ja'::text, false, 1),
            ('a0000000-0000-0000-0000-000000000005'::uuid, 'Nein'::text, true, 2) $$,
  'an admin reads the answers of a question in an unpublished quiz, and only that question''s'
);

select is_empty(
  $$ select 1 from public.admin_answers('e0000000-0000-0000-0000-0000000000ff') $$,
  'an admin gets no row for an unknown question'
);

select is_empty(
  $$ select 1 from public.admin_answers(null) $$,
  'an admin gets no row for a null id'
);

-- The admin still can't select the column itself (answers.test.sql has the
-- full set); the function is the way in.
select throws_ok(
  $$ select is_correct from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin still cannot select answers.is_correct directly'
);

reset role;

-- learner (alice) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

-- The learner sees these answers' rows, so a refusal is not about the rows.
select results_eq(
  $$ select count(*)::integer from public.answers
     where question_id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values (3) $$,
  'a learner sees the published question''s answers (positive control)'
);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'a learner is refused with only ''not available'' for a question they can see'
);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000002') $$),
  current_setting('test.refusal'),
  'a learner is refused with only ''not available'' for a question of an unpublished quiz'
);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-0000000000ff') $$),
  current_setting('test.refusal'),
  'a learner is refused the same way for an unknown id'
);

select throws_ok(
  $$ select is_correct from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$,
  'P0001', 'not available',
  'a learner cannot select the is_correct column through admin_answers'
);

select throws_ok(
  $$ select id from public.admin_answers('e0000000-0000-0000-0000-000000000001') where is_correct $$,
  'P0001', 'not available',
  'a learner cannot filter on is_correct through admin_answers'
);

reset role;

-- anonymous user ------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'an anonymous user is refused with only ''not available'' for an existing question'
);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-0000000000ff') $$),
  current_setting('test.refusal'),
  'an anonymous user is refused the same way for an unknown id'
);

reset role;

-- authenticated without a user ----------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'authenticated with empty claims is refused with only ''not available'''
);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-0000000000ff') $$),
  current_setting('test.refusal'),
  'authenticated with empty claims is refused the same way for an unknown id'
);

select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'authenticated with claims but no sub is refused with only ''not available'''
);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-0000000000ff') $$),
  current_setting('test.refusal'),
  'authenticated with claims but no sub is refused the same way for an unknown id'
);

-- A sub that names no profile (a deleted user's token).
select set_config('request.jwt.claims',
  '{"sub": "99999999-9999-9999-9999-999999999999", "role": "authenticated"}', true);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'a token for a user without a profile is refused with only ''not available'''
);

-- A JWT that claims to be an admin: the role comes from profiles only.
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "user_role": "admin", "app_metadata": {"role": "admin"}, "user_metadata": {"role": "admin"}}',
  true);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'a learner whose token claims an admin role is refused with only ''not available'''
);

reset role;

-- the owner without claims --------------------------------------------------

select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'the owner without claims is refused with only ''not available'''
);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-0000000000ff') $$),
  current_setting('test.refusal'),
  'the owner without claims is refused the same way for an unknown id'
);

-- anon ----------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$,
  '42501', null,
  'anon cannot call admin_answers (no execute grant)'
);

select throws_ok(
  $$ select * from public.admin_answers('e0000000-0000-0000-0000-0000000000ff') $$,
  '42501', null,
  'anon cannot call admin_answers with an unknown id either (no execute grant)'
);

-- Also with an admin's sub in the claims: anon stays anon.
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "anon"}', true);

select throws_ok(
  $$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$,
  '42501', null,
  'anon cannot call admin_answers even with an admin''s sub in the claims'
);

reset role;

-- An admin who loses the role -------------------------------------------------

update public.profiles set role = 'learner' where id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.outcome($$ select * from public.admin_answers('e0000000-0000-0000-0000-000000000001') $$),
  current_setting('test.refusal'),
  'a former admin is refused with only ''not available'' as soon as the role is gone'
);

reset role;

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Nothing was written ---------------------------------------------------------

select results_eq(
  $$ select id, text, is_correct, sort_order from public.answers
     where question_id = 'e0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid, 'Schwarz'::text, true, 1),
            ('a0000000-0000-0000-0000-000000000002'::uuid, 'Rot'::text, true, 2),
            ('a0000000-0000-0000-0000-000000000003'::uuid, 'Grün'::text, false, 3) $$,
  'reading through admin_answers changed nothing'
);

-- Counts only attempts started in this test's transaction (started_at = now()).
select is_empty(
  $$ select 1 from public.attempts where started_at = now() $$,
  'reading through admin_answers started no attempt'
);

select is_empty(
  $$ select 1 from public.attempt_answers aa
     join public.attempts a on a.id = aa.attempt_id
     where a.started_at = now() $$,
  'reading through admin_answers recorded no answer'
);

select * from finish();
rollback;
