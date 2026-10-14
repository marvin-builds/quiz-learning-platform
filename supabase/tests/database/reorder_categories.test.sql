-- public.reorder_categories(category_ids): the admin's one call that puts
-- the categories in a new order (#84). It takes the full ordered list of
-- category ids and renumbers every category 1..n in that order, in one
-- statement, so the order changes atomically. sort_order stays out of the
-- column grants (no direct PATCH can write it); this function is the only way
-- to change it after the insert.
--
-- The full-list contract: the list must be exactly the current categories,
-- each once, published or not. A list with an id missing, an id too many or
-- unknown, an id named twice, a null id, or an empty or null list is refused
-- and changes nothing, so a stale list from a second tab can't drop or
-- duplicate a position.
--
-- It takes the same transaction-scoped advisory lock as
-- internal.assign_category_sort_order() (hashtext('public.categories.sort_order')),
-- so a concurrent insert can't get a sort_order the reorder also hands out.
--
-- Security definer with an empty search_path, guarded by private.is_admin()
-- first; executable by authenticated only (not anon, not PUBLIC). Every
-- refused call gets the same error, P0001 'not available' with no detail or
-- hint: a non-admin whatever the list, and an admin for a list that breaks
-- the contract. anon's refusal is the missing grant (42501).
--
-- Fixtures are created here as the owner and vanish on rollback. The full
-- list names every category, so the seed's categories are deleted first in
-- this transaction (their quizzes cascade) and only the fixtures remain.
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(37);

-- Fixtures ----------------------------------------------------------------

delete from public.categories;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Gaps in sort_order on purpose: the reorder renumbers 1..n.
insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Erstes Thema', 5, true),
  ('c0000000-0000-0000-0000-000000000002', 'Zweites Thema', 7, true),
  ('c0000000-0000-0000-0000-000000000003', 'Drittes Thema', 9, true),
  ('c0000000-0000-0000-0000-000000000004', 'Verstecktes Thema', 11, false);

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

-- Every category with its sort_order, as the owner sees it (security
-- definer, so a learner's call reads past RLS too): 'id:sort_order, ...' by id.
create function pg_temp.category_orders()
returns text
language sql
security definer
as $fn$
  select string_agg(right(c.id::text, 1) || ':' || c.sort_order, ', ' order by c.id)
  from public.categories c
$fn$;

grant execute on function pg_temp.category_orders() to anon, authenticated;

-- A refused call: its outcome, and whether every sort_order is as before.
create function pg_temp.refused(statement text)
returns text
language plpgsql
as $fn$
declare
  before text := pg_temp.category_orders();
  result text := pg_temp.outcome(statement);
begin
  return result
    || case when pg_temp.category_orders() = before then ' (unchanged)' else ' (changed)' end;
end;
$fn$;

grant execute on function pg_temp.refused(text) to anon, authenticated;

-- Whether this transaction holds the advisory lock `key`, as
-- pg_advisory_xact_lock(bigint) takes it for an integer key.
create function pg_temp.holds_lock(key integer)
returns boolean
language sql
as $fn$
  select exists (
    select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
      and l.objsubid = 1
      and l.classid::bigint = ((key::bigint >> 32) & 4294967295)
      and l.objid::bigint = (key::bigint & 4294967295))
$fn$;

grant execute on function pg_temp.holds_lock(integer) to authenticated;

select set_config('test.refused', 'P0001|not available|| (unchanged)', true);

-- The valid new order, reused by every role.
select set_config('test.call', $$ select public.reorder_categories(
  category_ids => array['c0000000-0000-0000-0000-000000000003',
                        'c0000000-0000-0000-0000-000000000001',
                        'c0000000-0000-0000-0000-000000000004',
                        'c0000000-0000-0000-0000-000000000002']::uuid[]) $$, true);

-- Structure and privileges (catalog) ----------------------------------------

select has_function('public', 'reorder_categories', array['uuid[]'],
  'public.reorder_categories(uuid[]) exists');

select results_eq(
  $$ select a.name::text collate "default"
     from pg_proc p, unnest(p.proargnames) with ordinality as a(name, n)
     where p.oid = to_regprocedure('public.reorder_categories(uuid[])')
     order by a.n $$,
  $$ values ('category_ids'::text) $$,
  'reorder_categories takes category_ids'
);

select ok(
  coalesce((
    select p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))
      and p.provolatile = 'v'
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_categories(uuid[])')
  ), false),
  'reorder_categories is a volatile security definer function with an empty search_path'
);

-- The call returns nothing, like reorder_questions.
select ok(
  coalesce((
    select p.prorettype = 'void'::regtype and not p.proretset
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_categories(uuid[])')
  ), false),
  'reorder_categories returns void'
);

select ok(
  coalesce(
    not has_function_privilege('anon', to_regprocedure('public.reorder_categories(uuid[])'),
      'execute'),
    false),
  'anon cannot execute reorder_categories'
);

select ok(
  coalesce(
    has_function_privilege('authenticated', to_regprocedure('public.reorder_categories(uuid[])'),
      'execute'),
    false),
  'authenticated can execute reorder_categories (the function decides who is an admin)'
);

select ok(
  coalesce((
    select not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
    from pg_proc p
    where p.oid = to_regprocedure('public.reorder_categories(uuid[])')
  ), false),
  'PUBLIC cannot execute reorder_categories'
);

select ok(
  not has_column_privilege('authenticated', 'public.categories', 'sort_order', 'update'),
  'authenticated still has no update grant on categories.sort_order'
);

-- learner (alice) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is(
  pg_temp.refused(current_setting('test.call')),
  current_setting('test.refused'),
  'a learner''s valid reorder is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'a learner is refused the same way for a list an admin would be refused for'
);

-- A token that claims an admin role: the role comes from profiles only.
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "user_role": "admin", "app_metadata": {"role": "admin"}, "user_metadata": {"role": "admin"}}',
  true);

select is(
  pg_temp.refused(current_setting('test.call')),
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
  pg_temp.refused(current_setting('test.call')),
  current_setting('test.refused'),
  'an anonymous user''s valid reorder is refused with only ''not available'' and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(category_ids => array[]::uuid[]) $$),
  current_setting('test.refused'),
  'an anonymous user is refused the same way for an empty list'
);

reset role;

-- authenticated without a user ----------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.refused(current_setting('test.call')),
  current_setting('test.refused'),
  'authenticated with empty claims is refused with only ''not available'' and changes nothing'
);

select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select is(
  pg_temp.refused(current_setting('test.call')),
  current_setting('test.refused'),
  'authenticated with claims but no sub is refused with only ''not available'' and changes nothing'
);

select set_config('request.jwt.claims',
  '{"sub": "99999999-9999-9999-9999-999999999999", "role": "authenticated"}', true);

select is(
  pg_temp.refused(current_setting('test.call')),
  current_setting('test.refused'),
  'a token for a user without a profile is refused with only ''not available'' and changes nothing'
);

reset role;

-- the owner without claims --------------------------------------------------

select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.refused(current_setting('test.call')),
  current_setting('test.refused'),
  'the owner without claims (no user) is refused with only ''not available'' and changes nothing'
);

-- anon ----------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  current_setting('test.call'),
  '42501', null,
  'anon cannot call reorder_categories (no execute grant)'
);

select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "anon"}', true);

select throws_ok(
  current_setting('test.call'),
  '42501', null,
  'anon cannot call reorder_categories even with an admin''s sub in the claims'
);

reset role;

select is(
  pg_temp.category_orders(),
  '1:5, 2:7, 3:9, 4:11',
  'no refused caller changed any sort_order'
);

-- admin (carol): calls that break the full-list contract ---------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000003',
                          'c0000000-0000-0000-0000-000000000001',
                          'c0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list without the unpublished category is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000003',
                          'c0000000-0000-0000-0000-000000000001',
                          'c0000000-0000-0000-0000-000000000004',
                          'c0000000-0000-0000-0000-000000000002',
                          'c0000000-0000-0000-0000-0000000000ff']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with an unknown id added is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000003',
                          'c0000000-0000-0000-0000-000000000001',
                          'c0000000-0000-0000-0000-000000000004',
                          'c0000000-0000-0000-0000-0000000000ff']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with an unknown id in place of a category is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000003',
                          'c0000000-0000-0000-0000-000000000001',
                          'c0000000-0000-0000-0000-000000000004',
                          'c0000000-0000-0000-0000-000000000001']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list naming a category twice in place of another is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000003',
                          'c0000000-0000-0000-0000-000000000001',
                          'c0000000-0000-0000-0000-000000000004',
                          'c0000000-0000-0000-0000-000000000002',
                          'c0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list naming a category twice is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000003', null,
                          'c0000000-0000-0000-0000-000000000001',
                          'c0000000-0000-0000-0000-000000000004',
                          'c0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s list with a null id is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(category_ids => array[]::uuid[]) $$),
  current_setting('test.refused'),
  'an admin''s empty list is refused and changes nothing'
);

select is(
  pg_temp.refused($$ select public.reorder_categories(category_ids => null) $$),
  current_setting('test.refused'),
  'an admin''s null list is refused and changes nothing'
);

-- admin (carol): a valid reorder ----------------------------------------------

select is(
  pg_temp.outcome(current_setting('test.call')),
  'ok',
  'an admin reorders the categories with the full ordered list, the unpublished one included'
);

select ok(
  pg_temp.holds_lock(pg_catalog.hashtext('public.categories.sort_order')),
  'the reorder took the categories'' sort_order advisory lock, the one inserts take'
);

select results_eq(
  $$ select id, sort_order from public.categories order by sort_order $$,
  $$ values ('c0000000-0000-0000-0000-000000000003'::uuid, 1),
            ('c0000000-0000-0000-0000-000000000001'::uuid, 2),
            ('c0000000-0000-0000-0000-000000000004'::uuid, 3),
            ('c0000000-0000-0000-0000-000000000002'::uuid, 4) $$,
  'the admin sees the categories renumbered 1..n in the new order'
);

reset role;

-- A learner sees the new order -------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select name from public.categories order by sort_order $$,
  $$ values ('Drittes Thema'::text), ('Erstes Thema'::text), ('Zweites Thema'::text) $$,
  'a learner''s select by sort_order shows the published categories in the new order'
);

reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select name from public.categories order by sort_order $$,
  $$ values ('Drittes Thema'::text), ('Erstes Thema'::text), ('Zweites Thema'::text) $$,
  'anon''s select by sort_order shows the new order too'
);

reset role;

-- A stale list ------------------------------------------------------------------

insert into public.categories (id, name, published) values
  ('c0000000-0000-0000-0000-000000000005', 'Neues Thema', false);

select is(
  (select sort_order from public.categories where id = 'c0000000-0000-0000-0000-000000000005'),
  5,
  'a category inserted after the reorder goes last, after the renumbered ones'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.refused(current_setting('test.call')),
  current_setting('test.refused'),
  'an admin''s stale list from before a category was added is refused and changes nothing'
);

reset role;

-- An admin who loses the role --------------------------------------------------

update public.profiles set role = 'learner' where id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select is(
  pg_temp.refused($$ select public.reorder_categories(
    category_ids => array['c0000000-0000-0000-0000-000000000005',
                          'c0000000-0000-0000-0000-000000000003',
                          'c0000000-0000-0000-0000-000000000001',
                          'c0000000-0000-0000-0000-000000000004',
                          'c0000000-0000-0000-0000-000000000002']::uuid[]) $$),
  current_setting('test.refused'),
  'a former admin is refused with only ''not available'' as soon as the role is gone'
);

reset role;

select results_eq(
  $$ select name, published from public.categories where id = 'c0000000-0000-0000-0000-000000000004' $$,
  $$ values ('Verstecktes Thema'::text, false) $$,
  'reordering changed neither name nor published'
);

select * from finish();
rollback;
