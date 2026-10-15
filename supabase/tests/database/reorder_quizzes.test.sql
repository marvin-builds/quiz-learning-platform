-- public.reorder_quizzes(category_id, quiz_ids): the admin's one call that
-- puts a category's quizzes in a new order (#84). It takes the category and
-- the full ordered list of its quiz ids and renumbers every quiz of the
-- category 1..n in that order, in one statement, so the order changes
-- atomically. sort_order stays out of the column grants (no direct PATCH can
-- write it); this function is the only way to change it after the insert.
--
-- The full-list contract: the list must be exactly the category's current
-- quizzes, each once. A list with an id missing, an id too many, an id of
-- another category or an unknown id, an id named twice, an empty or null
-- list, or an unknown or null category is refused and changes nothing, so a
-- stale list from a second tab can't drop or duplicate a position.
--
-- It takes the same transaction-scoped advisory lock as
-- internal.assign_quiz_sort_order() (hashtext('public.quizzes.sort_order'),
-- hashtext(category_id)), so a concurrent insert can't get a sort_order the
-- reorder also hands out.
--
-- Security definer with an empty search_path, guarded by private.is_admin()
-- first; executable by authenticated only (not anon, not PUBLIC). Every
-- refused call gets the same error, P0001 'not available' with no detail or
-- hint: a non-admin for an existing and an unknown category alike, and an
-- admin for a list that breaks the contract. anon's refusal is the missing
-- grant (42501). Fixtures are created here as the owner, independent of
-- seed.sql, and vanish on rollback.
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(52);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true),
  ('c0000000-0000-0000-0000-000000000002', 'Anderes Thema', 2, true);

-- Gaps in sort_order on purpose: the reorder renumbers 1..n.
insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Erstes Quiz', 5, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Zweites Quiz', 7, true),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001',
   'Drittes Quiz', 9, true),
  -- in the other category
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002',
   'Quiz im anderen Thema', 1, true);

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

-- Every quiz with its sort_order, as the owner sees it (security definer, so
-- a learner's call reads past RLS too): 'id:sort_order, ...' by id.
create function pg_temp.quiz_orders()
returns text
language sql
security definer
as $fn$
  select string_agg(right(z.id::text, 1) || ':' || z.sort_order, ', ' order by z.id)
  from public.quizzes z
  where z.id::text like 'd0000000-0000-0000-0000-00000000000_'
$fn$;

grant execute on function pg_temp.quiz_orders() to anon, authenticated;

-- A refused call: its outcome, and whether every sort_order is as before.
create function pg_temp.refused(statement text)
returns text
language plpgsql
as $fn$
declare
  before text := pg_temp.quiz_orders();
  result text := pg_temp.outcome(statement);
begin
  return result || case when pg_temp.quiz_orders() = before then ' (unchanged)' else ' (changed)' end;
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

select has_function('public', 'reorder_quizzes', array['uuid', 'uuid[]'],
  'public.reorder_quizzes(uuid, uuid[]) exists');

select results_eq(
  $$ select a.name::text collate "default"
     from pg_proc p, unnest(p.proargnames) with ordinality as a(name, n)
     where p.oid = to_regprocedure('public.reorder_quizzes(uuid, uuid[])')
     order by a.n $$,
  $$ values ('category_id'::text), ('quiz_ids'::text) $$,
  'reorder_quizzes takes category_id and quiz_ids'
);

select ok(
  coalesce((
    select p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_quizzes(uuid, uuid[])')
  ), false),
  'reorder_quizzes is security definer with an empty search_path'
);

-- The call returns nothing, like reorder_questions.
select ok(
  coalesce((
    select p.prorettype = 'void'::regtype and not p.proretset
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_quizzes(uuid, uuid[])')
  ), false),
  'reorder_quizzes returns void'
);

select ok(
  coalesce((
    select p.provolatile = 'v'
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_quizzes(uuid, uuid[])')
  ), false),
  'reorder_quizzes is a write: volatile'
);

select ok(
  coalesce(
    not has_function_privilege('anon', to_regprocedure('public.reorder_quizzes(uuid, uuid[])'),
      'execute'),
    false),
  'anon cannot execute reorder_quizzes'
);

select ok(
  coalesce(
    has_function_privilege('authenticated',
      to_regprocedure('public.reorder_quizzes(uuid, uuid[])'), 'execute'),
    false),
  'authenticated can execute reorder_quizzes (the function decides who is an admin)'
);

select ok(
  coalesce((
    select not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_quizzes(uuid, uuid[])')
  ), false),
  'PUBLIC cannot execute reorder_quizzes'
);

-- sort_order stays out of the column grants: the function is the only way.
select ok(
  not has_column_privilege('authenticated', 'public.quizzes', 'sort_order', 'update'),
  'authenticated still has no update grant on quizzes.sort_order'
);

-- learner (alice) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner''s valid reorder is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-0000000000ff',
    quiz_ids => array['d0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner is refused the same way for an unknown category'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner is refused the same way for a list an admin would be refused for'
);

-- A token that claims an admin role: the role comes from profiles only.
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "user_role": "admin", "app_metadata": {"role": "admin"}, "user_metadata": {"role": "admin"}}',
  true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
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
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an anonymous user''s valid reorder is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-0000000000ff',
    quiz_ids => array['d0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an anonymous user is refused the same way for an unknown category'
);

reset role;

-- authenticated without a user ----------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'authenticated with empty claims is refused with only ''not available'' and changes nothing'
);

select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'authenticated with claims but no sub is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-0000000000ff',
    quiz_ids => array['d0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'authenticated with claims but no sub is refused the same way for an unknown category'
);

-- A sub that names no profile (a deleted user's token).
select set_config('request.jwt.claims',
  '{"sub": "99999999-9999-9999-9999-999999999999", "role": "authenticated"}', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'a token for a user without a profile is refused with only ''not available'' and changes nothing'
);

reset role;

-- the owner without claims --------------------------------------------------

select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'the owner without claims (no user) is refused with only ''not available'' and changes nothing'
);

-- anon ----------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$,
  '42501', null,
  'anon cannot call reorder_quizzes (no execute grant)'
);

select throws_ok(
  $$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-0000000000ff',
    quiz_ids => array['d0000000-0000-0000-0000-000000000001']::uuid[]) $$,
  '42501', null,
  'anon cannot call reorder_quizzes for an unknown category either (no execute grant)'
);

-- Also with an admin's sub in the claims: anon stays anon.
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "anon"}', true);

select throws_ok(
  $$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$,
  '42501', null,
  'anon cannot call reorder_quizzes even with an admin''s sub in the claims'
);

reset role;

select is(
  pg_temp.quiz_orders(),
  '1:5, 2:7, 3:9, 4:1',
  'no refused caller changed any sort_order'
);

-- admin (carol): calls that break the full-list contract ---------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a quiz missing is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002',
                      'd0000000-0000-0000-0000-000000000004']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a quiz of another category added is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000004']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a quiz of another category in place of one of its own is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-0000000000ff']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with an unknown quiz id is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002',
                      'd0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list naming a quiz twice is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list naming a quiz twice in place of another is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003', null,
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a null id is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array[]::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s empty list is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => null) $$),
  current_setting('test.refused'),
  'an admin''s null list is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-0000000000ff',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s reorder for an unknown category is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-0000000000ff',
    quiz_ids => array[]::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s empty list for an unknown category is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => null,
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s reorder for a null category is refused and changes nothing'
);

-- The other category's quiz under the wrong category.
select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000004']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list of another category''s quiz is refused and changes nothing'
);

-- admin (carol): a valid reorder ----------------------------------------------

select is(
  pg_temp.outcome($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  'ok',
  'an admin reorders a category''s quizzes with the full ordered list'
);

select ok(
  pg_temp.holds_lock(pg_catalog.hashtext('public.quizzes.sort_order'),
    pg_catalog.hashtext('c0000000-0000-0000-0000-000000000001')),
  'the reorder took the category''s sort_order advisory lock, the one inserts take'
);

select results_eq(
  $$ select id, sort_order from public.quizzes
     where category_id = 'c0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('d0000000-0000-0000-0000-000000000003'::uuid, 1),
            ('d0000000-0000-0000-0000-000000000001'::uuid, 2),
            ('d0000000-0000-0000-0000-000000000002'::uuid, 3) $$,
  'the admin sees the quizzes renumbered 1..n in the new order'
);

-- A second reorder from the renumbered state.
select is(
  pg_temp.outcome($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000002',
                      'd0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  'ok',
  'an admin reorders the same category again'
);

reset role;

select is(
  pg_temp.quiz_orders(),
  '1:3, 2:2, 3:1, 4:1',
  'the second reorder renumbered the category''s quizzes and left the other category''s alone'
);

select results_eq(
  $$ select count(*)::integer from public.quizzes
     where category_id = 'c0000000-0000-0000-0000-000000000001' $$,
  $$ values (3) $$,
  'the reorder neither added nor removed a quiz'
);

-- A learner sees the new order -------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select title from public.quizzes
     where category_id = 'c0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('Drittes Quiz'::text), ('Zweites Quiz'::text), ('Erstes Quiz'::text) $$,
  'a learner''s select by sort_order shows the new order'
);

reset role;

-- A list from before a quiz was added is stale: refused.
insert into public.quizzes (id, category_id, title, published) values
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001',
   'Neues Quiz', false);

select is(
  (select sort_order from public.quizzes where id = 'd0000000-0000-0000-0000-000000000005'),
  4,
  'a quiz inserted after the reorder goes last, after the renumbered ones'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002',
                      'd0000000-0000-0000-0000-000000000003']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s stale list from before a quiz was added is refused and changes nothing'
);

select is(
  pg_temp.outcome($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000005',
                      'd0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000002',
                      'd0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  'ok',
  'an admin reorders a list that includes an unpublished quiz'
);

reset role;

select results_eq(
  $$ select id, sort_order from public.quizzes
     where category_id = 'c0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('d0000000-0000-0000-0000-000000000005'::uuid, 1),
            ('d0000000-0000-0000-0000-000000000003'::uuid, 2),
            ('d0000000-0000-0000-0000-000000000002'::uuid, 3),
            ('d0000000-0000-0000-0000-000000000001'::uuid, 4) $$,
  'the unpublished quiz moved first and the rest followed, 1..n'
);

-- An admin who loses the role --------------------------------------------------

update public.profiles set role = 'learner' where id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.refused($$ select public.reorder_quizzes(
    category_id => 'c0000000-0000-0000-0000-000000000001',
    quiz_ids => array['d0000000-0000-0000-0000-000000000001',
                      'd0000000-0000-0000-0000-000000000002',
                      'd0000000-0000-0000-0000-000000000003',
                      'd0000000-0000-0000-0000-000000000005']::uuid[]) $$),
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
  $$ select name, sort_order from public.categories
     where id in ('c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002')
     order by sort_order $$,
  $$ values ('Sichtbares Thema'::text, 1), ('Anderes Thema'::text, 2) $$,
  'reordering quizzes left the categories as they were'
);

select is(
  (select title from public.quizzes where id = 'd0000000-0000-0000-0000-000000000003'),
  'Drittes Quiz',
  'reordering changed no title'
);

select * from finish();
rollback;
