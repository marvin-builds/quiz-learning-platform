-- public.questions: structure, constraints and access per role (anon,
-- anonymous user, learner, admin). For everyone but an admin a question is
-- visible only if its quiz is visible (the quiz and its category are
-- published); an admin reads every question (private.is_admin()).
-- `explanation` is part of the solution: no API role may select it, not even
-- an admin. A learner gets it only from submit_answer(); an admin reads it
-- through the admin-only function admin_question() (admin_question.test.sql)
-- and writes it through the column grants below. Fixtures are created here
-- as the owner, independent of seed.sql, and vanish on rollback.
--
-- Only an admin writes questions through the API (#81): insert quiz_id,
-- text, explanation and multiple_correct; update text, explanation and
-- multiple_correct (no move to another quiz); delete. Images are item 5, so
-- image_path and image_alt stay unwritable, like sort_order (assigned per
-- quiz by a before-insert trigger in schema internal), id and created_at. A
-- grant to insert or update explanation gives no select on it, so a write
-- may not return or filter on it either. A learner's or an anonymous user's
-- update or delete touches no row (RLS), their insert fails; anon has no
-- write grant.
begin;
select plan(119);

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
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlichtes Quiz', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 2, false),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000002',
   'Quiz im versteckten Thema', 1, true);

insert into public.questions
  (id, quiz_id, text, image_path, image_alt, multiple_correct, explanation, sort_order) values
  -- in a visible quiz: visible
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', 'fragen/himmel.png', 'Ein blauer Himmel', true,
   'Wegen der Rayleigh-Streuung.', 1),
  -- in an unpublished quiz: hidden
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   'Frage im Entwurf?', null, null, false, 'Geheim.', 1),
  -- in a published quiz of an unpublished category: hidden
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003',
   'Frage im versteckten Thema?', null, null, false, 'Geheim.', 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Blau', true, 1);

-- Only for the admin's writes, so the read tests keep their fixtures.
insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001',
   'Leeres Quiz', 3, false);

insert into public.questions (id, quiz_id, text, multiple_correct, explanation, sort_order) values
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002',
   'Zum Bearbeiten?', false, 'Alte Erklärung.', 2),
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000002',
   'Zum Löschen?', false, null, 3);

-- The number of rows a write touched, or null (with the error as a notice)
-- when it raised one, so a failing write reports here instead of aborting
-- the file. Temporary, so it never shows up in function_privileges.test.sql.
create function pg_temp.touched_rows(statement text)
returns integer
language plpgsql
as $fn$
declare
  touched integer;
begin
  execute statement;
  get diagnostics touched = row_count;
  return touched;
exception when others then
  raise notice 'touched_rows: % (%)', sqlerrm, sqlstate;
  return null;
end;
$fn$;

grant execute on function pg_temp.touched_rows(text) to authenticated;

-- The advisory locks this transaction holds, to see the sort_order trigger
-- serialise inserts per quiz.
create function pg_temp.advisory_locks()
returns integer
language sql
as $fn$
  select count(*)::integer from pg_locks
  where locktype = 'advisory' and pid = pg_backend_pid() and granted
$fn$;

grant execute on function pg_temp.advisory_locks() to authenticated;

-- Structure ---------------------------------------------------------------

select has_table('public', 'questions', 'questions table exists');

select columns_are('public', 'questions',
  array['id', 'quiz_id', 'text', 'image_path', 'image_alt', 'multiple_correct',
        'explanation', 'sort_order', 'created_at'],
  'questions has exactly the planned columns');

select col_is_pk('public', 'questions', 'id', 'questions.id is the primary key');
select col_type_is('public', 'questions', 'id', 'uuid', 'questions.id is a uuid');
select col_has_default('public', 'questions', 'id', 'questions.id has a default');

select col_type_is('public', 'questions', 'quiz_id', 'uuid', 'questions.quiz_id is a uuid');
select col_not_null('public', 'questions', 'quiz_id', 'questions.quiz_id is required');
select fk_ok('public', 'questions', 'quiz_id', 'public', 'quizzes', 'id',
  'questions.quiz_id references quizzes.id');

select col_type_is('public', 'questions', 'text', 'text', 'questions.text is text');
select col_not_null('public', 'questions', 'text', 'questions.text is required');

select col_type_is('public', 'questions', 'image_path', 'text', 'questions.image_path is text');
select col_is_null('public', 'questions', 'image_path', 'questions.image_path is optional');

select col_type_is('public', 'questions', 'image_alt', 'text', 'questions.image_alt is text');
select col_is_null('public', 'questions', 'image_alt',
  'questions.image_alt is optional without an image');

select col_type_is('public', 'questions', 'multiple_correct', 'boolean',
  'questions.multiple_correct is a boolean');
select col_not_null('public', 'questions', 'multiple_correct',
  'questions.multiple_correct is required');

select col_type_is('public', 'questions', 'explanation', 'text',
  'questions.explanation is text');
select col_is_null('public', 'questions', 'explanation', 'questions.explanation is optional');

select col_type_is('public', 'questions', 'sort_order', 'integer',
  'questions.sort_order is an integer');
select col_not_null('public', 'questions', 'sort_order', 'questions.sort_order is required');

select col_type_is('public', 'questions', 'created_at', 'timestamp with time zone',
  'questions.created_at is a timestamptz');
select col_not_null('public', 'questions', 'created_at', 'questions.created_at is required');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.questions'::regclass
      and a.attname = 'quiz_id'
  ),
  'an index leads with questions.quiz_id'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.questions'::regclass),
  'questions has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

insert into public.questions (quiz_id, text, sort_order)
values ('d0000000-0000-0000-0000-000000000001', 'Nur Pflichtfelder?', 9);

select results_eq(
  $$ select id is not null, multiple_correct, created_at = now()
     from public.questions where text = 'Nur Pflichtfelder?' $$,
  $$ values (true, false, true) $$,
  'a new question gets an id, multiple_correct = false and created_at = now() by default'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', null, 1) $$,
  '23502', null,
  'a question without a text is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', E'\n  ', 1) $$,
  '23514', null,
  'a question with a blank text is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values (null, 'Ohne Quiz?', 1) $$,
  '23502', null,
  'a question without a quiz is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-0000000000ff', 'Verwaist?', 1) $$,
  '23503', null,
  'a question in a quiz that does not exist is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, image_path, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Bild ohne Alt?', 'fragen/x.png', 1) $$,
  '23514', null,
  'a question with an image but no image_alt is rejected'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, image_path, image_alt, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Bild mit leerem Alt?',
             'fragen/x.png', '  ', 1) $$,
  '23514', null,
  'a question with an image and a blank image_alt is rejected'
);

select lives_ok(
  $$ insert into public.questions (quiz_id, text, image_path, image_alt, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Bild mit Alt?',
             'fragen/y.png', 'Ein Diagramm', 1) $$,
  'a question with an image and an image_alt is accepted'
);

delete from public.questions where id = 'e0000000-0000-0000-0000-000000000001';

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  'deleting a question deletes its answers'
);

-- Restore the deleted fixture for the role tests.
insert into public.questions
  (id, quiz_id, text, image_path, image_alt, multiple_correct, explanation, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', 'fragen/himmel.png', 'Ein blauer Himmel', true,
   'Wegen der Rayleigh-Streuung.', 1);

-- Grants, policies and the sort_order trigger (catalog) ---------------------

select ok(
  not has_table_privilege('anon', 'public.questions', 'INSERT, UPDATE, DELETE'),
  'anon has no write privilege on questions'
);

-- has_table_privilege ignores column-level grants; anon gets none either.
select ok(
  not has_any_column_privilege('anon', 'public.questions', 'INSERT')
  and not has_any_column_privilege('anon', 'public.questions', 'UPDATE'),
  'anon has no column-level insert or update privilege on questions'
);

select results_eq(
  $$ select c.column_name::text collate "default",
            has_column_privilege('authenticated', 'public.questions', c.column_name, 'INSERT'),
            has_column_privilege('authenticated', 'public.questions', c.column_name, 'UPDATE'),
            has_column_privilege('authenticated', 'public.questions', c.column_name, 'SELECT')
     from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'questions'
     order by c.column_name $$,
  $$ values ('created_at'::text, false, false, true),
            ('explanation'::text, true, true, false),
            ('id'::text, false, false, true),
            ('image_alt'::text, false, false, true),
            ('image_path'::text, false, false, true),
            ('multiple_correct'::text, true, true, true),
            ('quiz_id'::text, true, false, true),
            ('sort_order'::text, false, false, true),
            ('text'::text, true, true, true) $$,
  'authenticated may insert quiz_id, text, explanation and multiple_correct, update all but quiz_id, and never select explanation'
);

select ok(
  has_table_privilege('authenticated', 'public.questions', 'DELETE'),
  'authenticated may delete questions (RLS decides which)'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'questions'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and roles <> '{authenticated}'::name[] $$,
  'every write policy on questions applies to authenticated only'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'questions'
       and cmd in ('UPDATE', 'ALL')
       and (qual is null or with_check is null) $$,
  'every update policy on questions has both using and with check'
);

select set_eq(
  $$ select w.cmd from (values ('INSERT'), ('UPDATE'), ('DELETE')) as w(cmd)
     where exists (
       select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = 'questions'
         and p.cmd in (w.cmd, 'ALL')) $$,
  $$ values ('INSERT'), ('UPDATE'), ('DELETE') $$,
  'questions has a policy for each write: insert, update and delete (or one for all)'
);

select ok(
  coalesce((
    select bool_and(
             n.nspname = 'internal'
             and pg_get_triggerdef(t.oid) ~* 'when \(\(?new\.sort_order is null\)?\)'
             and not has_function_privilege('anon', t.tgfoid, 'execute')
             and not has_function_privilege('authenticated', t.tgfoid, 'execute'))
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = p.pronamespace
    where t.tgrelid = 'public.questions'::regclass
      and not t.tgisinternal
      and pg_get_triggerdef(t.oid) ~* 'before insert'
      and pg_get_triggerdef(t.oid) ~* 'sort_order'
  ), false),
  'a before-insert trigger on questions, only when sort_order is null, runs a function in schema internal that no API role may execute'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select id, quiz_id, text, image_path, image_alt, multiple_correct, sort_order,
            created_at is not null
     from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid,
             'Welche Farbe hat der Himmel?'::text, 'fragen/himmel.png'::text,
             'Ein blauer Himmel'::text, true, 1, true) $$,
  'anon sees a question of a visible quiz with every column except explanation'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  'anon does not see a question of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  'anon does not see a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'anon cannot select questions.explanation'
);

select throws_ok(
  $$ select * from public.questions $$,
  '42501', null,
  'anon cannot select * from questions (it includes explanation)'
);

select throws_ok(
  $$ select id from public.questions where explanation is not null $$,
  '42501', null,
  'anon cannot filter questions on explanation'
);

select throws_ok(
  $$ select to_jsonb(q) from public.questions q $$,
  '42501', null,
  'anon cannot read explanation through a whole-row reference'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Neu?', 3) $$,
  '42501', null,
  'anon cannot insert a question'
);

-- Only the columns an admin may insert, so a column-level insert grant to
-- anon would show up as an RLS error instead of a missing grant.
select throws_ok(
  $$ insert into public.questions (quiz_id, text, explanation, multiple_correct)
     values ('d0000000-0000-0000-0000-000000000001', 'Neu?', 'Weil.', false) $$,
  '42501', 'permission denied for table questions',
  'anon cannot insert a question with only the admin-writable columns (no grant, not RLS)'
);

select throws_ok(
  $$ update public.questions set text = 'Geändert?'
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot update a question'
);

select throws_ok(
  $$ delete from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete a question'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid) $$,
  'an anonymous user sees a question of a visible quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  'an anonymous user does not see a question of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  'an anonymous user does not see a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'an anonymous user cannot select questions.explanation'
);

select throws_like(
  $$ insert into public.questions (quiz_id, text, explanation, multiple_correct)
     values ('d0000000-0000-0000-0000-000000000001', 'Von Anonym?', 'Erklärung', false) $$,
  '%row-level security%',
  'an anonymous user cannot insert a question (RLS)'
);

select is(
  pg_temp.touched_rows($$ update public.questions set text = 'Von Anonym geändert?', explanation = 'Neu'
     where id = 'e0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s update of a visible question touches no row, without an error'
);

select is(
  pg_temp.touched_rows($$ delete from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s delete of a visible question touches no row, without an error'
);

reset role;

select results_eq(
  $$ select text, explanation, multiple_correct from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Welche Farbe hat der Himmel?'::text, 'Wegen der Rayleigh-Streuung.'::text, true) $$,
  'after the anonymous user''s writes the visible question is still there, unchanged'
);

select is_empty(
  $$ select 1 from public.questions where text = 'Von Anonym?' $$,
  'the anonymous user''s insert left no row behind'
);

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id, quiz_id, text, image_path, image_alt, multiple_correct, sort_order,
            created_at is not null
     from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid,
             'Welche Farbe hat der Himmel?'::text, 'fragen/himmel.png'::text,
             'Ein blauer Himmel'::text, true, 1, true) $$,
  'a learner sees a question of a visible quiz with every column except explanation'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  'a learner does not see a question of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  'a learner does not see a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'a learner cannot select questions.explanation'
);

select throws_ok(
  $$ select * from public.questions $$,
  '42501', null,
  'a learner cannot select * from questions (it includes explanation)'
);

select throws_ok(
  $$ select id from public.questions where explanation is not null $$,
  '42501', null,
  'a learner cannot filter questions on explanation'
);

select throws_ok(
  $$ select to_jsonb(q) from public.questions q $$,
  '42501', null,
  'a learner cannot read explanation through a whole-row reference'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000001', 'Neu?', 3) $$,
  '42501', null,
  'a learner cannot insert a question'
);

select throws_like(
  $$ insert into public.questions (quiz_id, text, explanation, multiple_correct)
     values ('d0000000-0000-0000-0000-000000000001', 'Vom Lerner?', 'Erklärung', false) $$,
  '%row-level security%',
  'a learner cannot insert a question with only writable columns either (RLS)'
);

-- Re-spec (#81): with the update and delete grants for the admin, a
-- learner's update or delete is no longer refused by a missing grant; RLS
-- lets it touch no row, which the owner checks below.
select is(
  pg_temp.touched_rows($$ update public.questions set text = 'Geändert?'
     where id = 'e0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot update a question: the update touches no row'
);

select is(
  pg_temp.touched_rows($$ update public.questions set explanation = 'Vom Lerner'
     where id = 'e0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot overwrite an explanation: the update touches no row'
);

select is(
  pg_temp.touched_rows($$ delete from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot delete a question: the delete touches no row'
);

reset role;

select results_eq(
  $$ select text, explanation from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Welche Farbe hat der Himmel?'::text, 'Wegen der Rayleigh-Streuung.'::text) $$,
  'after the learner''s writes the visible question is still there, unchanged'
);

select is_empty(
  $$ select 1 from public.questions where text = 'Vom Lerner?' $$,
  'the learner''s insert left no row behind'
);

-- admin (carol) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, quiz_id, text, image_path, image_alt, multiple_correct, sort_order,
            created_at is not null
     from public.questions where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid,
             'Welche Farbe hat der Himmel?'::text, 'fragen/himmel.png'::text,
             'Ein blauer Himmel'::text, true, 1, true) $$,
  'an admin sees a question of a visible quiz without explanation'
);

select results_eq(
  $$ select id, quiz_id, text, multiple_correct, sort_order
     from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  $$ values ('e0000000-0000-0000-0000-000000000002'::uuid,
             'd0000000-0000-0000-0000-000000000002'::uuid,
             'Frage im Entwurf?'::text, false, 1) $$,
  'an admin sees a question of an unpublished quiz'
);

select results_eq(
  $$ select id from public.questions where id = 'e0000000-0000-0000-0000-000000000003' $$,
  $$ values ('e0000000-0000-0000-0000-000000000003'::uuid) $$,
  'an admin sees a question of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select explanation from public.questions $$,
  '42501', null,
  'an admin still cannot select questions.explanation'
);

select throws_ok(
  $$ select explanation from public.questions
     where id = 'e0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'an admin cannot select the explanation of a question in an unpublished quiz either'
);

select throws_ok(
  $$ select * from public.questions $$,
  '42501', null,
  'an admin still cannot select * from questions'
);

select throws_ok(
  $$ select id from public.questions where explanation is not null $$,
  '42501', null,
  'an admin still cannot filter questions on explanation'
);

select throws_ok(
  $$ select to_jsonb(q) from public.questions q $$,
  '42501', null,
  'an admin still cannot read explanation through a whole-row reference'
);

-- Re-spec (#81): the admin now writes questions through the API. These were
-- 'an admin cannot insert / update / delete a question through the API yet'.

select set_config('test.locks_before', pg_temp.advisory_locks()::text, true);

select lives_ok(
  $$ insert into public.questions (quiz_id, text, explanation, multiple_correct)
     values ('d0000000-0000-0000-0000-000000000002', 'Neue Frage?', 'Neue Erklärung.', true) $$,
  'an admin can insert a question with quiz_id, text, explanation and multiple_correct'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  1,
  'inserting a question takes a transaction advisory lock for its quiz'
);

select lives_ok(
  $$ insert into public.questions (quiz_id, text)
     values ('d0000000-0000-0000-0000-000000000002', 'Noch eine Frage?') $$,
  'an admin can insert a question with only a quiz and a text'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  1,
  'a second insert into the same quiz takes the same lock, not another one'
);

select lives_ok(
  $$ insert into public.questions (quiz_id, text)
     values ('d0000000-0000-0000-0000-000000000003', 'Frage mit Id zurück?')
     returning id, quiz_id $$,
  'an admin''s insert may return the plain columns, here into a quiz of an unpublished category'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  2,
  'an insert into another quiz takes a lock of its own'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, explanation)
     values ('d0000000-0000-0000-0000-000000000002', 'Mit Rückgabe?', 'Geheim.')
     returning explanation $$,
  '42501', null,
  'an admin''s insert cannot return the explanation (no select on it)'
);

select lives_ok(
  $$ insert into public.questions (quiz_id, text)
     values ('d0000000-0000-0000-0000-000000000004', 'Erste Frage?') $$,
  'an admin can insert the first question into an empty quiz'
);

select lives_ok(
  $$ insert into public.questions (quiz_id, text)
     values ('d0000000-0000-0000-0000-000000000004', 'Zweite Frage?') $$,
  'an admin can insert a second question into that quiz'
);

select results_eq(
  $$ select text, sort_order from public.questions
     where quiz_id = 'd0000000-0000-0000-0000-000000000004' order by sort_order $$,
  $$ values ('Erste Frage?'::text, 1), ('Zweite Frage?'::text, 2) $$,
  'in an empty quiz the first question gets sort_order 1 and the next 2'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, sort_order)
     values ('d0000000-0000-0000-0000-000000000002', 'Mit Position?', 1) $$,
  '42501', null,
  'an admin cannot choose the sort_order of a new question'
);

select throws_ok(
  $$ insert into public.questions (id, quiz_id, text)
     values ('e0000000-0000-0000-0000-0000000000ff', 'd0000000-0000-0000-0000-000000000002', 'Mit Id?') $$,
  '42501', null,
  'an admin cannot choose the id of a new question'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, created_at)
     values ('d0000000-0000-0000-0000-000000000002', 'Mit Datum?', now()) $$,
  '42501', null,
  'an admin cannot choose the created_at of a new question'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, image_path, image_alt)
     values ('d0000000-0000-0000-0000-000000000002', 'Mit Bild?', 'fragen/z.png', 'Ein Bild') $$,
  '42501', null,
  'an admin cannot set the image of a new question yet (images are item 5)'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text) values ('d0000000-0000-0000-0000-000000000002', null) $$,
  '23502', null,
  'an admin cannot insert a question without a text'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text)
     values ('d0000000-0000-0000-0000-000000000002', E' \t\r\n') $$,
  '23514', null,
  'an admin cannot insert a question whose text is only spaces, tabs and line breaks'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text)
     values ('d0000000-0000-0000-0000-0000000000ff', 'Verwaist?') $$,
  '23503', null,
  'an admin cannot insert a question into a quiz that does not exist'
);

select is(
  pg_temp.touched_rows($$ update public.questions
     set text = 'Bearbeitet?', explanation = 'Neue Erklärung.', multiple_correct = true
     where id = 'e0000000-0000-0000-0000-000000000004' $$),
  1,
  'an admin can update the text, explanation and multiple_correct of a question'
);

select results_eq(
  $$ select text, multiple_correct from public.questions
     where id = 'e0000000-0000-0000-0000-000000000004' $$,
  $$ values ('Bearbeitet?'::text, true) $$,
  'the admin reads back the updated text and multiple_correct'
);

select is(
  pg_temp.touched_rows($$ update public.questions set explanation = null
     where id = 'e0000000-0000-0000-0000-000000000002' $$),
  1,
  'an admin can clear the explanation of a question'
);

select throws_ok(
  $$ update public.questions set text = 'Mit Rückgabe?'
     where id = 'e0000000-0000-0000-0000-000000000004'
     returning explanation $$,
  '42501', null,
  'an admin''s update cannot return the explanation (no select on it)'
);

select throws_ok(
  $$ update public.questions set quiz_id = 'd0000000-0000-0000-0000-000000000001'
     where id = 'e0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot move a question to another quiz'
);

select throws_ok(
  $$ update public.questions set sort_order = 99
     where id = 'e0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the sort_order of a question (reordering is item 6)'
);

select throws_ok(
  $$ update public.questions set image_path = 'fragen/z.png', image_alt = 'Ein Bild'
     where id = 'e0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the image of a question yet (images are item 5)'
);

select throws_ok(
  $$ update public.questions set id = 'e0000000-0000-0000-0000-0000000000fe'
     where id = 'e0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the id of a question'
);

select throws_ok(
  $$ update public.questions set created_at = now() - interval '1 day'
     where id = 'e0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the created_at of a question'
);

select throws_ok(
  $$ update public.questions set text = E'\n '
     where id = 'e0000000-0000-0000-0000-000000000004' $$,
  '23514', null,
  'an admin cannot change the text of a question to a blank one'
);

select is(
  pg_temp.touched_rows($$ delete from public.questions
     where id = 'e0000000-0000-0000-0000-000000000005' $$),
  1,
  'an admin can delete a question'
);

reset role;

-- Effects of the admin's writes, checked as the owner ---------------------

select results_eq(
  $$ select quiz_id, text, explanation, multiple_correct, sort_order from public.questions
     where text = 'Neue Frage?' $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid, 'Neue Frage?'::text,
             'Neue Erklärung.'::text, true, 4) $$,
  'the admin''s new question is stored with its explanation and the next sort_order in its quiz'
);

select results_eq(
  $$ select explanation, multiple_correct, sort_order from public.questions
     where text = 'Noch eine Frage?' $$,
  $$ values (null::text, false, 5) $$,
  'the next new question gets the sort_order after that, without an explanation, single choice'
);

select results_eq(
  $$ select sort_order from public.questions where text = 'Frage mit Id zurück?' $$,
  $$ values (2) $$,
  'sort_order counts per quiz: the other quiz''s questions do not move it'
);

select results_eq(
  $$ select quiz_id, text, explanation, multiple_correct, image_path, sort_order
     from public.questions where id = 'e0000000-0000-0000-0000-000000000004' $$,
  $$ values ('d0000000-0000-0000-0000-000000000002'::uuid, 'Bearbeitet?'::text,
             'Neue Erklärung.'::text, true, null::text, 2) $$,
  'the admin''s edits are stored, explanation included, and the refused writes changed nothing else'
);

select results_eq(
  $$ select explanation from public.questions where id = 'e0000000-0000-0000-0000-000000000002' $$,
  $$ values (null::text) $$,
  'the admin''s cleared explanation is stored as null'
);

select is_empty(
  $$ select 1 from public.questions where id = 'e0000000-0000-0000-0000-000000000005' $$,
  'the admin''s delete removed the question'
);

select is_empty(
  $$ select 1 from public.questions
     where text in ('Mit Rückgabe?', 'Mit Position?', 'Mit Id?', 'Mit Datum?', 'Mit Bild?',
                    'Verwaist?')
        or id in ('e0000000-0000-0000-0000-0000000000ff',
                  'e0000000-0000-0000-0000-0000000000fe') $$,
  'the admin''s refused inserts left no row behind'
);

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select text, explanation from public.questions
     where id = 'e0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Welche Farbe hat der Himmel?'::text, 'Wegen der Rayleigh-Streuung.'::text) $$,
  'the rejected writes left the question unchanged'
);

select * from finish();
rollback;
