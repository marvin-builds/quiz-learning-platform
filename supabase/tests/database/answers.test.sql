-- public.answers: structure, constraints and access per role (anon,
-- anonymous user, learner, admin). For everyone but an admin an answer is
-- visible only if its question's quiz is visible (the quiz and its category
-- are published); an admin reads every answer (private.is_admin()).
-- `is_correct` is the solution: no API role may select it, not even an
-- admin. A learner gets it only from submit_answer(); an admin reads it
-- through the admin-only function admin_answers() (admin_answers.test.sql)
-- and writes it through the column grants below. Fixtures are created here
-- as the owner, independent of seed.sql, and vanish on rollback.
--
-- Only an admin writes answers through the API (#82), as with questions
-- (#81): insert question_id, text and is_correct; update text and is_correct
-- (no move to another question); delete. Reordering is item 6, so
-- sort_order (assigned per question by a before-insert trigger in schema
-- internal) stays unwritable, like id and created_at. A grant to insert or update is_correct gives no select on it,
-- so a write may not return or filter on it either. A learner's or an
-- anonymous user's update or delete touches no row (RLS), their insert
-- fails; anon has no write grant. The rules on a question's answers (at
-- least two, at least one correct, exactly one for single choice) are
-- deferred checks that never fire here, since this file never commits or
-- forces them: question_rules.test.sql covers them.
--
-- Re-spec (#83): an admin also inserts and updates image_path and image_alt
-- (images are item 5), directly and through the security-invoker
-- save_question() (save_question_images.test.sql), so authenticated gets
-- those column grants and RLS keeps them to admins. These were 'an admin
-- cannot set / change the image of an answer yet'. Every write, the
-- owner's included, must name an object the app chose: a lowercase UUID
-- with .png, .jpg, .jpeg or .webp at the bucket root (a table constraint,
-- 23514), the same rule as the quiz-images Storage policies. The fixtures'
-- image names changed from 'antworten/...' to such names for that reason.
--
-- Re-spec (#84): reordering (item 6) has come. The admin reorders a
-- question's answers through the security-invoker save_question(), which
-- writes sort_order = the answer's position in the payload
-- (save_question_answer_order.test.sql). So authenticated gets an UPDATE
-- grant on answers.sort_order, kept to admins by the admin-only RLS on
-- answers; no INSERT grant, since a new answer still gets its position from
-- the before-insert trigger and save_question then updates it. These were
-- 'no INSERT/UPDATE grant on answers.sort_order' and 'an admin cannot change
-- the sort_order of an answer (reordering is item 6)'; the stored-edits
-- check now expects the admin's new sort_order instead of the old one.
begin;
select plan(129);

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

insert into public.questions (id, quiz_id, text, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welche Farbe hat der Himmel?', 1),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   'Frage im Entwurf?', 1),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003',
   'Frage im versteckten Thema?', 1);

insert into public.answers
  (id, question_id, text, image_path, image_alt, is_correct, sort_order) values
  -- of a question in a visible quiz: visible
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Blau', '2a3b4c5d-0000-4000-8000-000000000001.png', 'Eine blaue Fläche', true, 1),
  -- of a question in an unpublished quiz: hidden
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002',
   'Antwort im Entwurf', null, null, true, 1),
  -- of a question in a published quiz of an unpublished category: hidden
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003',
   'Antwort im versteckten Thema', null, null, true, 1);

-- Only for the admin's writes, so the read tests keep their fixtures.
insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000002',
   'Zum Bearbeiten', false, 2),
  ('a0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000002',
   'Zum Löschen', false, 3);

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
-- serialise inserts per question.
create function pg_temp.advisory_locks()
returns integer
language sql
as $fn$
  select count(*)::integer from pg_locks
  where locktype = 'advisory' and pid = pg_backend_pid() and granted
$fn$;

grant execute on function pg_temp.advisory_locks() to authenticated;

-- How a statement ends: 'ok' or its sqlstate, so a list of refused image
-- names can be checked in one assertion.
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

-- Structure ---------------------------------------------------------------

select has_table('public', 'answers', 'answers table exists');

select columns_are('public', 'answers',
  array['id', 'question_id', 'text', 'image_path', 'image_alt', 'is_correct',
        'sort_order', 'created_at'],
  'answers has exactly the planned columns');

select col_is_pk('public', 'answers', 'id', 'answers.id is the primary key');
select col_type_is('public', 'answers', 'id', 'uuid', 'answers.id is a uuid');
select col_has_default('public', 'answers', 'id', 'answers.id has a default');

select col_type_is('public', 'answers', 'question_id', 'uuid',
  'answers.question_id is a uuid');
select col_not_null('public', 'answers', 'question_id', 'answers.question_id is required');
select fk_ok('public', 'answers', 'question_id', 'public', 'questions', 'id',
  'answers.question_id references questions.id');

select col_type_is('public', 'answers', 'text', 'text', 'answers.text is text');
select col_not_null('public', 'answers', 'text', 'answers.text is required');

select col_type_is('public', 'answers', 'image_path', 'text', 'answers.image_path is text');
select col_is_null('public', 'answers', 'image_path', 'answers.image_path is optional');

select col_type_is('public', 'answers', 'image_alt', 'text', 'answers.image_alt is text');
select col_is_null('public', 'answers', 'image_alt',
  'answers.image_alt is optional without an image');

select col_type_is('public', 'answers', 'is_correct', 'boolean',
  'answers.is_correct is a boolean');
select col_not_null('public', 'answers', 'is_correct', 'answers.is_correct is required');

select col_type_is('public', 'answers', 'sort_order', 'integer',
  'answers.sort_order is an integer');
select col_not_null('public', 'answers', 'sort_order', 'answers.sort_order is required');

select col_type_is('public', 'answers', 'created_at', 'timestamp with time zone',
  'answers.created_at is a timestamptz');
select col_not_null('public', 'answers', 'created_at', 'answers.created_at is required');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.answers'::regclass
      and a.attname = 'question_id'
  ),
  'an index leads with answers.question_id'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.answers'::regclass),
  'answers has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

insert into public.answers (question_id, text, sort_order)
values ('e0000000-0000-0000-0000-000000000001', 'Nur Pflichtfelder', 9);

select results_eq(
  $$ select id is not null, is_correct, created_at = now()
     from public.answers where text = 'Nur Pflichtfelder' $$,
  $$ values (true, false, true) $$,
  'a new answer gets an id, is_correct = false and created_at = now() by default'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', null, 1) $$,
  '23502', null,
  'an answer without a text is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', ' ', 1) $$,
  '23514', null,
  'an answer with a blank text is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values (null, 'Ohne Frage', 1) $$,
  '23502', null,
  'an answer without a question is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-0000000000ff', 'Verwaist', 1) $$,
  '23503', null,
  'an answer to a question that does not exist is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, image_path, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Bild ohne Alt', '2a3b4c5d-0000-4000-8000-000000000002.png', 1) $$,
  '23514', null,
  'an answer with an image but no image_alt is rejected'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, image_path, image_alt, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Bild mit leerem Alt',
             '2a3b4c5d-0000-4000-8000-000000000002.png', E'\t', 1) $$,
  '23514', null,
  'an answer with an image and a blank image_alt is rejected'
);

select lives_ok(
  $$ insert into public.answers (question_id, text, image_path, image_alt, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Bild mit Alt',
             '2a3b4c5d-0000-4000-8000-000000000003.jpg', 'Ein Kreis', 1) $$,
  'an answer with an image and an image_alt is accepted'
);

select results_eq(
  $$ select name, pg_temp.outcome(format(
       $q$ insert into public.answers (question_id, text, image_path, image_alt, sort_order)
           values ('e0000000-0000-0000-0000-000000000001', 'Bildname', %L, 'Ein Bild', 1) $q$,
       name))
     from unnest(array[
       'fuchs.png',
       'Mein Foto vom Urlaub.jpg',
       'ordner/2a3b4c5d-0000-4000-8000-000000000005.png',
       '../2a3b4c5d-0000-4000-8000-000000000005.png',
       'quiz-images/2a3b4c5d-0000-4000-8000-000000000005.png',
       '/2a3b4c5d-0000-4000-8000-000000000005.png',
       '2a3b4c5d-0000-4000-8000-000000000005',
       '2a3b4c5d-0000-4000-8000-000000000005.gif',
       '2a3b4c5d-0000-4000-8000-000000000005.png.html',
       '2A3B4C5D-0000-4000-8000-000000000005.png',
       '']) with ordinality as t(name, n)
     order by n $$,
  $$ values
       ('fuchs.png'::text, '23514'::text),
       ('Mein Foto vom Urlaub.jpg', '23514'),
       ('ordner/2a3b4c5d-0000-4000-8000-000000000005.png', '23514'),
       ('../2a3b4c5d-0000-4000-8000-000000000005.png', '23514'),
       ('quiz-images/2a3b4c5d-0000-4000-8000-000000000005.png', '23514'),
       ('/2a3b4c5d-0000-4000-8000-000000000005.png', '23514'),
       ('2a3b4c5d-0000-4000-8000-000000000005', '23514'),
       ('2a3b4c5d-0000-4000-8000-000000000005.gif', '23514'),
       ('2a3b4c5d-0000-4000-8000-000000000005.png.html', '23514'),
       ('2A3B4C5D-0000-4000-8000-000000000005.png', '23514'),
       ('', '23514') $$,
  'an answer image_path that is not a lowercase UUID name with .png, .jpg, .jpeg or .webp at the bucket root is rejected, even for the owner'
);

select lives_ok(
  $$ insert into public.answers (question_id, text, image_path, image_alt, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Bild als JPEG',
             '2a3b4c5d-0000-4000-8000-000000000006.jpeg', 'Ein Foto', 1),
            ('e0000000-0000-0000-0000-000000000001', 'Bild als WebP',
             '2a3b4c5d-0000-4000-8000-000000000007.webp', 'Ein Foto', 1) $$,
  'an answer image_path with .jpeg or .webp is accepted'
);

select throws_ok(
  $$ update public.answers set image_path = 'ordner/2a3b4c5d-0000-4000-8000-000000000005.png'
     where text = 'Bild als JPEG' $$,
  '23514', null,
  'an update to an answer image_path that is not a UUID name at the bucket root is rejected, even for the owner'
);

-- Grants, policies and the sort_order trigger (catalog) ---------------------

select ok(
  not has_table_privilege('anon', 'public.answers', 'INSERT, UPDATE, DELETE'),
  'anon has no write privilege on answers'
);

-- has_table_privilege ignores column-level grants; anon gets none either.
select ok(
  not has_any_column_privilege('anon', 'public.answers', 'INSERT')
  and not has_any_column_privilege('anon', 'public.answers', 'UPDATE'),
  'anon has no column-level insert or update privilege on answers'
);

select results_eq(
  $$ select c.column_name::text collate "default",
            has_column_privilege('authenticated', 'public.answers', c.column_name, 'INSERT'),
            has_column_privilege('authenticated', 'public.answers', c.column_name, 'UPDATE'),
            has_column_privilege('authenticated', 'public.answers', c.column_name, 'SELECT')
     from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'answers'
     order by c.column_name $$,
  $$ values ('created_at'::text, false, false, true),
            ('id'::text, false, false, true),
            ('image_alt'::text, true, true, true),
            ('image_path'::text, true, true, true),
            ('is_correct'::text, true, true, false),
            ('question_id'::text, true, false, true),
            ('sort_order'::text, false, true, true),
            ('text'::text, true, true, true) $$,
  'authenticated may insert question_id, text, is_correct, image_path and image_alt, update all of them but question_id plus sort_order (never insert it), and never select is_correct'
);

select ok(
  has_table_privilege('authenticated', 'public.answers', 'DELETE'),
  'authenticated may delete answers (RLS decides which)'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'answers'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and roles <> '{authenticated}'::name[] $$,
  'every write policy on answers applies to authenticated only'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'answers'
       and cmd in ('UPDATE', 'ALL')
       and (qual is null or with_check is null) $$,
  'every update policy on answers has both using and with check'
);

select set_eq(
  $$ select w.cmd from (values ('INSERT'), ('UPDATE'), ('DELETE')) as w(cmd)
     where exists (
       select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = 'answers'
         and p.cmd in (w.cmd, 'ALL')) $$,
  $$ values ('INSERT'), ('UPDATE'), ('DELETE') $$,
  'answers has a policy for each write: insert, update and delete (or one for all)'
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
    where t.tgrelid = 'public.answers'::regclass
      and not t.tgisinternal
      and pg_get_triggerdef(t.oid) ~* 'before insert'
      and pg_get_triggerdef(t.oid) ~* 'sort_order'
  ), false),
  'a before-insert trigger on answers, only when sort_order is null, runs a function in schema internal that no API role may execute'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select results_eq(
  $$ select id, question_id, text, image_path, image_alt, sort_order,
            created_at is not null
     from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             'Blau'::text, '2a3b4c5d-0000-4000-8000-000000000001.png'::text, 'Eine blaue Fläche'::text, 1, true) $$,
  'anon sees an answer of a visible quiz with every column except is_correct'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'anon does not see an answer of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  'anon does not see an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'anon cannot select answers.is_correct'
);

select throws_ok(
  $$ select * from public.answers $$,
  '42501', null,
  'anon cannot select * from answers (it includes is_correct)'
);

select throws_ok(
  $$ select id from public.answers where is_correct $$,
  '42501', null,
  'anon cannot filter answers on is_correct'
);

select throws_ok(
  $$ select to_jsonb(a) from public.answers a $$,
  '42501', null,
  'anon cannot read is_correct through a whole-row reference'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Neu', 3) $$,
  '42501', null,
  'anon cannot insert an answer'
);

-- Only the columns an admin may insert, so a column-level insert grant to
-- anon would show up as an RLS error instead of a missing grant.
select throws_ok(
  $$ insert into public.answers (question_id, text, is_correct, image_path, image_alt)
     values ('e0000000-0000-0000-0000-000000000001', 'Neu', true,
             '2a3b4c5d-0000-4000-8000-000000000008.png', 'Von anon') $$,
  '42501', 'permission denied for table answers',
  'anon cannot insert an answer with only the admin-writable columns, image included (no grant, not RLS)'
);

select throws_ok(
  $$ update public.answers
     set image_path = '2a3b4c5d-0000-4000-8000-000000000008.png', image_alt = 'Von anon'
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot change the image of an answer'
);

select throws_ok(
  $$ update public.answers set is_correct = false
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot mark an answer as wrong'
);

select throws_ok(
  $$ update public.answers set text = 'Geändert'
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot update an answer'
);

select throws_ok(
  $$ delete from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete an answer'
);

reset role;

-- anonymous user ----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'an anonymous user sees an answer of a visible quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'an anonymous user does not see an answer of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  'an anonymous user does not see an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'an anonymous user cannot select answers.is_correct'
);

select throws_like(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('e0000000-0000-0000-0000-000000000001', 'Von Anonym', true) $$,
  '%row-level security%',
  'an anonymous user cannot insert an answer (RLS)'
);

select throws_like(
  $$ insert into public.answers (question_id, text, image_path, image_alt)
     values ('e0000000-0000-0000-0000-000000000001', 'Von Anonym mit Bild',
             '2a3b4c5d-0000-4000-8000-000000000009.png', 'Vom Gast') $$,
  '%row-level security%',
  'an anonymous user cannot insert an answer with an image (RLS)'
);

select is(
  pg_temp.touched_rows($$ update public.answers
     set image_path = '2a3b4c5d-0000-4000-8000-000000000009.png', image_alt = 'Vom Gast'
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s change to the image of a visible answer touches no row'
);

select is(
  pg_temp.touched_rows($$ update public.answers set text = 'Von Anonym geändert', is_correct = false
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s update of a visible answer touches no row, without an error'
);

select is(
  pg_temp.touched_rows($$ delete from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  0,
  'an anonymous user''s delete of a visible answer touches no row, without an error'
);

reset role;

select results_eq(
  $$ select text, is_correct, image_path, image_alt from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Blau'::text, true, '2a3b4c5d-0000-4000-8000-000000000001.png'::text,
             'Eine blaue Fläche'::text) $$,
  'after the anonymous user''s writes the visible answer is still there, unchanged, image included'
);

select is_empty(
  $$ select 1 from public.answers where text in ('Von Anonym', 'Von Anonym mit Bild') $$,
  'the anonymous user''s insert left no row behind'
);

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id, question_id, text, image_path, image_alt, sort_order,
            created_at is not null
     from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             'Blau'::text, '2a3b4c5d-0000-4000-8000-000000000001.png'::text, 'Eine blaue Fläche'::text, 1, true) $$,
  'a learner sees an answer of a visible quiz with every column except is_correct'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  'a learner does not see an answer of an unpublished quiz'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  'a learner does not see an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'a learner cannot select answers.is_correct'
);

select throws_ok(
  $$ select * from public.answers $$,
  '42501', null,
  'a learner cannot select * from answers (it includes is_correct)'
);

select throws_ok(
  $$ select id from public.answers where is_correct $$,
  '42501', null,
  'a learner cannot filter answers on is_correct'
);

select throws_ok(
  $$ select to_jsonb(a) from public.answers a $$,
  '42501', null,
  'a learner cannot read is_correct through a whole-row reference'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000001', 'Neu', 3) $$,
  '42501', null,
  'a learner cannot insert an answer'
);

select throws_like(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('e0000000-0000-0000-0000-000000000001', 'Vom Lerner', true) $$,
  '%row-level security%',
  'a learner cannot insert an answer with only writable columns either (RLS)'
);

-- Re-spec (#82): with the update and delete grants for the admin, a
-- learner's update or delete is no longer refused by a missing grant; RLS
-- lets it touch no row, which the owner checks below. These were
-- throws_ok 42501 'a learner cannot update / delete an answer'.
select is(
  pg_temp.touched_rows($$ update public.answers set text = 'Geändert'
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot update an answer: the update touches no row'
);

select is(
  pg_temp.touched_rows($$ update public.answers set is_correct = false
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot mark an answer as wrong: the update touches no row'
);

select is(
  pg_temp.touched_rows($$ update public.answers
     set image_path = '2a3b4c5d-0000-4000-8000-00000000000a.png', image_alt = 'Von Alice'
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot change the image of an answer: the update touches no row'
);

select throws_like(
  $$ insert into public.answers (question_id, text, image_path, image_alt)
     values ('e0000000-0000-0000-0000-000000000001', 'Vom Lerner mit Bild',
             '2a3b4c5d-0000-4000-8000-00000000000a.png', 'Von Alice') $$,
  '%row-level security%',
  'a learner cannot insert an answer with an image (RLS)'
);

select is(
  pg_temp.touched_rows($$ delete from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  0,
  'a learner cannot delete an answer: the delete touches no row'
);

reset role;

select results_eq(
  $$ select text, is_correct, image_path, image_alt from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Blau'::text, true, '2a3b4c5d-0000-4000-8000-000000000001.png'::text,
             'Eine blaue Fläche'::text) $$,
  'after the learner''s writes the visible answer is still there, unchanged, image included'
);

select is_empty(
  $$ select 1 from public.answers where text = 'Vom Lerner' $$,
  'the learner''s insert left no row behind'
);

-- admin (carol) -----------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, question_id, text, image_path, image_alt, sort_order,
            created_at is not null
     from public.answers where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid,
             'e0000000-0000-0000-0000-000000000001'::uuid,
             'Blau'::text, '2a3b4c5d-0000-4000-8000-000000000001.png'::text, 'Eine blaue Fläche'::text, 1, true) $$,
  'an admin sees an answer of a visible quiz without is_correct'
);

select results_eq(
  $$ select id, question_id, text, sort_order
     from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  $$ values ('a0000000-0000-0000-0000-000000000002'::uuid,
             'e0000000-0000-0000-0000-000000000002'::uuid,
             'Antwort im Entwurf'::text, 1) $$,
  'an admin sees an answer of an unpublished quiz'
);

select results_eq(
  $$ select id from public.answers where id = 'a0000000-0000-0000-0000-000000000003' $$,
  $$ values ('a0000000-0000-0000-0000-000000000003'::uuid) $$,
  'an admin sees an answer of a published quiz in an unpublished category'
);

select throws_ok(
  $$ select is_correct from public.answers $$,
  '42501', null,
  'an admin still cannot select answers.is_correct'
);

select throws_ok(
  $$ select is_correct from public.answers
     where id = 'a0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'an admin cannot select is_correct of an answer in an unpublished quiz either'
);

select throws_ok(
  $$ select * from public.answers $$,
  '42501', null,
  'an admin still cannot select * from answers'
);

select throws_ok(
  $$ select id from public.answers where is_correct $$,
  '42501', null,
  'an admin still cannot filter answers on is_correct'
);

select throws_ok(
  $$ select to_jsonb(a) from public.answers a $$,
  '42501', null,
  'an admin still cannot read is_correct through a whole-row reference'
);

-- Re-spec (#82): the admin now writes answers through the API. These were
-- 'an admin cannot insert / update / delete an answer through the API yet'.

select set_config('test.locks_before', pg_temp.advisory_locks()::text, true);

select lives_ok(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('e0000000-0000-0000-0000-000000000002', 'Neue richtige Antwort', true) $$,
  'an admin can insert an answer with question_id, text and is_correct'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  1,
  'inserting an answer takes a transaction advisory lock for its question'
);

select lives_ok(
  $$ insert into public.answers (question_id, text)
     values ('e0000000-0000-0000-0000-000000000002', 'Noch eine Antwort') $$,
  'an admin can insert an answer with only a question and a text'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  1,
  'a second insert into the same question takes the same lock, not another one'
);

select lives_ok(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('e0000000-0000-0000-0000-000000000003', 'Antwort mit Id zurück', false)
     returning id, question_id, text $$,
  'an admin''s insert may return the plain columns, here to a question of an unpublished category'
);

select is(
  pg_temp.advisory_locks() - current_setting('test.locks_before')::integer,
  2,
  'an insert into another question takes a lock of its own'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('e0000000-0000-0000-0000-000000000002', 'Mit Rückgabe', true)
     returning is_correct $$,
  '42501', null,
  'an admin''s insert cannot return is_correct (no select on it)'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('e0000000-0000-0000-0000-000000000002', 'Mit ganzer Zeile', true)
     returning * $$,
  '42501', null,
  'an admin''s insert cannot return the whole row (it includes is_correct)'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, sort_order)
     values ('e0000000-0000-0000-0000-000000000002', 'Mit Position', 1) $$,
  '42501', null,
  'an admin cannot choose the sort_order of a new answer (reordering is item 6)'
);

select throws_ok(
  $$ insert into public.answers (id, question_id, text)
     values ('a0000000-0000-0000-0000-0000000000ff', 'e0000000-0000-0000-0000-000000000002', 'Mit Id') $$,
  '42501', null,
  'an admin cannot choose the id of a new answer'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, created_at)
     values ('e0000000-0000-0000-0000-000000000002', 'Mit Datum', now()) $$,
  '42501', null,
  'an admin cannot choose the created_at of a new answer'
);

select lives_ok(
  $$ insert into public.answers (question_id, text, image_path, image_alt)
     values ('e0000000-0000-0000-0000-000000000002', 'Mit Bild', '2a3b4c5d-0000-4000-8000-000000000004.webp', 'Ein Bild') $$,
  'an admin can insert an answer with an image and its alt text'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, image_path, image_alt)
     values ('e0000000-0000-0000-0000-000000000002', 'Mit falschem Bild',
             '../2a3b4c5d-0000-4000-8000-000000000004.webp', 'Ein Bild') $$,
  '23514', null,
  'an admin cannot insert an answer whose image_path is not a UUID name at the bucket root'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, image_path)
     values ('e0000000-0000-0000-0000-000000000002', 'Bild ohne Alt', '2a3b4c5d-0000-4000-8000-00000000000b.png') $$,
  '23514', null,
  'an admin cannot insert an answer with an image but no alt text'
);

select throws_ok(
  $$ insert into public.answers (question_id, text)
     values ('e0000000-0000-0000-0000-000000000002', E' \t\r\n') $$,
  '23514', null,
  'an admin cannot insert an answer whose text is only spaces, tabs and line breaks'
);

select throws_ok(
  $$ insert into public.answers (question_id, text)
     values ('e0000000-0000-0000-0000-0000000000ff', 'Verwaist') $$,
  '23503', null,
  'an admin cannot insert an answer to a question that does not exist'
);

select is(
  pg_temp.touched_rows($$ update public.answers set text = 'Bearbeitet', is_correct = true
     where id = 'a0000000-0000-0000-0000-000000000004' $$),
  1,
  'an admin can update the text and is_correct of an answer'
);

select is(
  pg_temp.touched_rows($$ update public.answers set is_correct = false
     where id = 'a0000000-0000-0000-0000-000000000002' $$),
  1,
  'an admin can mark an answer as wrong'
);

select throws_ok(
  $$ update public.answers set text = 'Mit Rückgabe'
     where id = 'a0000000-0000-0000-0000-000000000004'
     returning is_correct $$,
  '42501', null,
  'an admin''s update cannot return is_correct (no select on it)'
);

select throws_ok(
  $$ update public.answers set text = 'Gefiltert'
     where question_id = 'e0000000-0000-0000-0000-000000000002' and is_correct $$,
  '42501', null,
  'an admin''s update cannot filter on is_correct (no select on it)'
);

select throws_ok(
  $$ delete from public.answers
     where question_id = 'e0000000-0000-0000-0000-000000000002' and not is_correct $$,
  '42501', null,
  'an admin''s delete cannot filter on is_correct (no select on it)'
);

select throws_ok(
  $$ update public.answers set question_id = 'e0000000-0000-0000-0000-000000000001'
     where id = 'a0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot move an answer to another question'
);

-- Re-spec (#84): was 'an admin cannot change the sort_order of an answer
-- (reordering is item 6)', 42501.
select is(
  pg_temp.touched_rows($$ update public.answers set sort_order = 99
     where id = 'a0000000-0000-0000-0000-000000000004' $$),
  1,
  'an admin can change the sort_order of an answer'
);

select is(
  pg_temp.touched_rows($$ update public.answers
     set image_path = '2a3b4c5d-0000-4000-8000-00000000000c.jpg', image_alt = 'Ein neues Bild'
     where id = 'a0000000-0000-0000-0000-000000000004' $$),
  1,
  'an admin can set the image and alt text of an answer'
);

select throws_ok(
  $$ update public.answers set image_path = 'antworten/2a3b4c5d-0000-4000-8000-00000000000d.png'
     where id = 'a0000000-0000-0000-0000-000000000004' $$,
  '23514', null,
  'an admin cannot change an answer image_path to one that is not a UUID name at the bucket root'
);

select is(
  pg_temp.touched_rows($$ update public.answers set image_path = null, image_alt = null
     where id = 'a0000000-0000-0000-0000-000000000001' $$),
  1,
  'an admin can remove the image and alt text of an answer'
);

select throws_ok(
  $$ update public.answers set id = 'a0000000-0000-0000-0000-0000000000fe'
     where id = 'a0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the id of an answer'
);

select throws_ok(
  $$ update public.answers set created_at = now() - interval '1 day'
     where id = 'a0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an admin cannot change the created_at of an answer'
);

select throws_ok(
  $$ update public.answers set text = E'\n '
     where id = 'a0000000-0000-0000-0000-000000000004' $$,
  '23514', null,
  'an admin cannot change the text of an answer to a blank one'
);

select is(
  pg_temp.touched_rows($$ delete from public.answers
     where id = 'a0000000-0000-0000-0000-000000000005' $$),
  1,
  'an admin can delete an answer'
);

reset role;

-- Effects of the admin's writes, checked as the owner ---------------------

select results_eq(
  $$ select question_id, text, is_correct, image_path, sort_order from public.answers
     where text = 'Neue richtige Antwort' $$,
  $$ values ('e0000000-0000-0000-0000-000000000002'::uuid, 'Neue richtige Antwort'::text,
             true, null::text, 4) $$,
  'the admin''s new answer is stored with is_correct and the next sort_order in its question'
);

select results_eq(
  $$ select is_correct, sort_order from public.answers where text = 'Noch eine Antwort' $$,
  $$ values (false, 5) $$,
  'the next new answer gets the sort_order after that, and is wrong by default'
);

select results_eq(
  $$ select sort_order from public.answers where text = 'Antwort mit Id zurück' $$,
  $$ values (2) $$,
  'sort_order counts per question: the other question''s answers do not move it'
);

select results_eq(
  $$ select question_id, text, is_correct, image_path, image_alt, sort_order from public.answers
     where id = 'a0000000-0000-0000-0000-000000000004' $$,
  $$ values ('e0000000-0000-0000-0000-000000000002'::uuid, 'Bearbeitet'::text, true,
             '2a3b4c5d-0000-4000-8000-00000000000c.jpg'::text, 'Ein neues Bild'::text, 99) $$,
  'the admin''s edits are stored, is_correct, image and sort_order included, and the refused writes changed nothing else'
);

select results_eq(
  $$ select question_id, image_path, image_alt from public.answers where text = 'Mit Bild' $$,
  $$ values ('e0000000-0000-0000-0000-000000000002'::uuid, '2a3b4c5d-0000-4000-8000-000000000004.webp'::text,
             'Ein Bild'::text) $$,
  'the admin''s new answer is stored with its image and alt text'
);

select results_eq(
  $$ select image_path, image_alt from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values (null::text, null::text) $$,
  'the admin''s removed answer image is stored as no image and no alt text'
);

select results_eq(
  $$ select is_correct from public.answers where id = 'a0000000-0000-0000-0000-000000000002' $$,
  $$ values (false) $$,
  'the admin''s change to is_correct is stored'
);

select is_empty(
  $$ select 1 from public.answers where id = 'a0000000-0000-0000-0000-000000000005' $$,
  'the admin''s delete removed the answer'
);

select is_empty(
  $$ select 1 from public.answers
     where text in ('Mit Rückgabe', 'Mit ganzer Zeile', 'Mit Position', 'Mit Id', 'Mit Datum',
                    'Mit falschem Bild', 'Verwaist', 'Gefiltert')
        or (text = 'Bild ohne Alt' and question_id = 'e0000000-0000-0000-0000-000000000002')
        or id in ('a0000000-0000-0000-0000-0000000000ff',
                  'a0000000-0000-0000-0000-0000000000fe') $$,
  'the admin''s refused writes left no row behind'
);

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select text, is_correct from public.answers
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values ('Blau'::text, true) $$,
  'the rejected writes left the answer unchanged'
);

select * from finish();
rollback;
