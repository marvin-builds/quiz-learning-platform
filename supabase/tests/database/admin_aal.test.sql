-- Admin rights need a second factor (#122): every admin policy and every
-- admin function refuses an admin whose session is aal1 (password only) and
-- lets the same admin in once the session is aal2 (password and TOTP). The
-- check lives in private.is_admin() (is_admin.test.sql covers its edge
-- cases); this file proves it reaches every caller:
-- - select, insert, update and delete on categories, quizzes, questions and
--   answers (the "Admins ..." policies);
-- - select, insert, update and delete on storage.objects in quiz-images;
-- - admin_question, admin_answers, save_question, reorder_categories,
--   reorder_quizzes and reorder_questions.
-- An aal1 admin is treated like a learner: the learner policies still show
-- published content, the admin policies add nothing. Each admin function
-- refuses an aal1 admin with exactly the error (SQLSTATE, message, detail,
-- hint) it gives a learner and an anonymous user, so the refusal doesn't
-- tell an attacker with a leaked password that the account is an admin's.
-- anon can't execute these functions at all (no grant, 42501), which
-- admin_question.test.sql and the other function files check.
--
-- Fixtures are created here as the owner, next to the seed's content, and
-- vanish on rollback. The aal1 sections run before the aal2 ones, so a
-- write that wrongly succeeds for aal1 shows up in the owner's checks.
begin;
select plan(68);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('ca000000-0000-4000-8000-000000000001', 'Veröffentlichtes Thema', 101, true),
  ('ca000000-0000-4000-8000-000000000002', 'Entwurfsthema', 102, false),
  ('ca000000-0000-4000-8000-000000000003', 'Zu löschendes Thema', 103, false);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('da000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Entwurfsquiz', 1, false),
  ('da000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001',
   'Zu löschendes Quiz', 2, false);

insert into public.questions (id, quiz_id, text, multiple_correct, explanation, sort_order) values
  ('ea000000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001',
   'Frage im Entwurf?', false, 'Die Erklärung.', 1),
  ('ea000000-0000-4000-8000-000000000002', 'da000000-0000-4000-8000-000000000001',
   'Zu löschende Frage?', false, null, 2);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('fa000000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-000000000001', 'Ja', true, 1),
  ('fa000000-0000-4000-8000-000000000002', 'ea000000-0000-4000-8000-000000000001', 'Nein', false, 2),
  ('fa000000-0000-4000-8000-000000000003', 'ea000000-0000-4000-8000-000000000001', 'Vielleicht', false, 3),
  ('fa000000-0000-4000-8000-000000000004', 'ea000000-0000-4000-8000-000000000002', 'Ja', true, 1),
  ('fa000000-0000-4000-8000-000000000005', 'ea000000-0000-4000-8000-000000000002', 'Nein', false, 2);

-- The bucket as configured, and one image in it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-images', 'quiz-images', true, 5242880,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, metadata) values
  ('0ba00000-0000-4000-8000-000000000001', 'quiz-images',
   'aa000000-0000-4000-8000-000000000001.png', '{"mimetype": "image/png"}');

-- Lets the delete tests reach RLS instead of Storage's protect_delete trigger.
set local storage.allow_delete_query = 'true';

-- The full lists the reorder functions expect, read as the owner (the seed's
-- categories included) and reversed, so a call that goes through changes the
-- order; the original orders are kept to check that a refused call didn't.
create temporary table full_lists as
  select
    array(select c.id from public.categories c order by c.sort_order desc, c.id) as categories,
    array(select z.id from public.quizzes z
          where z.category_id = 'ca000000-0000-4000-8000-000000000001'
          order by z.sort_order desc, z.id) as quizzes,
    array(select q.id from public.questions q
          where q.quiz_id = 'da000000-0000-4000-8000-000000000001'
          order by q.sort_order desc, q.id) as questions;
grant select on pg_temp.full_lists to authenticated;

create temporary table original_orders as
  select
    array(select c.id from public.categories c order by c.sort_order, c.id) as categories,
    array(select z.id from public.quizzes z
          where z.category_id = 'ca000000-0000-4000-8000-000000000001'
          order by z.sort_order, z.id) as quizzes,
    array(select q.id from public.questions q
          where q.quiz_id = 'da000000-0000-4000-8000-000000000001'
          order by q.sort_order, q.id) as questions;

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
grant execute on function pg_temp.outcome(text) to authenticated;

-- Runs a write whose effect the owner checks afterwards; an error counts as
-- nothing written. Returns nothing, so its output isn't read as TAP.
create function pg_temp.try(statement text) returns void
language plpgsql as $fn$
begin
  perform pg_temp.outcome(statement);
end;
$fn$;
grant execute on function pg_temp.try(text) to authenticated;

-- The admin function calls, each with arguments an admin may use.
create temporary table calls (name text primary key, statement text not null);
insert into calls values
  ('admin_question',
   $$ select * from public.admin_question('ea000000-0000-4000-8000-000000000001') $$),
  ('admin_answers',
   $$ select * from public.admin_answers('ea000000-0000-4000-8000-000000000001') $$),
  ('save_question',
   $$ select public.save_question(
        'da000000-0000-4000-8000-000000000001', null, 'Neue Frage?', 'Weil.', false,
        '[{"text": "Ja", "is_correct": true}, {"text": "Nein", "is_correct": false}]'::jsonb) $$),
  ('reorder_categories',
   $$ select public.reorder_categories((select categories from pg_temp.full_lists)) $$),
  ('reorder_quizzes',
   $$ select public.reorder_quizzes('ca000000-0000-4000-8000-000000000001',
        (select quizzes from pg_temp.full_lists)) $$),
  ('reorder_questions',
   $$ select public.reorder_questions('da000000-0000-4000-8000-000000000001',
        (select questions from pg_temp.full_lists)) $$);
grant select on pg_temp.calls to authenticated;

-- Each caller's outcome per function, filled in role by role below.
create temporary table outcomes (caller text, name text, outcome text,
  primary key (caller, name));
grant select, insert on pg_temp.outcomes to authenticated;

create function pg_temp.record_outcomes(caller text) returns void
language plpgsql as $fn$
declare
  c record;
begin
  for c in select * from pg_temp.calls order by name loop
    insert into pg_temp.outcomes values (caller, c.name, pg_temp.outcome(c.statement));
  end loop;
end;
$fn$;
grant execute on function pg_temp.record_outcomes(text) to authenticated;

-- The refusals of a learner and an anonymous user -----------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "aal": "aal1"}', true);
select pg_temp.record_outcomes('learner');
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated",
    "is_anonymous": true, "aal": "aal1"}', true);
select pg_temp.record_outcomes('anonymous');
reset role;

select is_empty(
  $$ select name from pg_temp.outcomes
     where caller in ('learner', 'anonymous') and outcome = 'ok' $$,
  'control: a learner and an anonymous user are refused by every admin function'
);

-- admin (carol) in an aal1 session: the admin policies refuse ---------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal1"}', true);

-- admin functions first, while the reorder lists are still full: each call's
-- outcome, compared with the learner's below. save_question runs last.

select pg_temp.record_outcomes('aal1 admin');

-- select: only what a learner sees

select is_empty(
  $$ select id from public.categories where id = 'ca000000-0000-4000-8000-000000000002' $$,
  'an aal1 admin cannot see an unpublished category'
);

select results_eq(
  $$ select id from public.categories where id = 'ca000000-0000-4000-8000-000000000001' $$,
  $$ values ('ca000000-0000-4000-8000-000000000001'::uuid) $$,
  'an aal1 admin still sees a published category, like a learner'
);

select is_empty(
  $$ select id from public.quizzes where id = 'da000000-0000-4000-8000-000000000001' $$,
  'an aal1 admin cannot see an unpublished quiz'
);

select is_empty(
  $$ select id from public.questions where id = 'ea000000-0000-4000-8000-000000000001' $$,
  'an aal1 admin cannot see a question of an unpublished quiz'
);

select is_empty(
  $$ select id from public.answers where question_id = 'ea000000-0000-4000-8000-000000000001' $$,
  'an aal1 admin cannot see the answers of a question in an unpublished quiz'
);

-- insert

select throws_ok(
  $$ insert into public.categories (name, published) values ('Eingeschleust', false) $$,
  '42501', null,
  'an aal1 admin cannot insert a category'
);

select throws_ok(
  $$ insert into public.quizzes (category_id, title, published)
     values ('ca000000-0000-4000-8000-000000000001', 'Eingeschleust', false) $$,
  '42501', null,
  'an aal1 admin cannot insert a quiz'
);

select throws_ok(
  $$ insert into public.questions (quiz_id, text, multiple_correct)
     values ('da000000-0000-4000-8000-000000000001', 'Eingeschleust?', false) $$,
  '42501', null,
  'an aal1 admin cannot insert a question'
);

select throws_ok(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('ea000000-0000-4000-8000-000000000001', 'Eingeschleust', false) $$,
  '42501', null,
  'an aal1 admin cannot insert an answer'
);

-- update and delete change nothing (checked as the owner below)

select pg_temp.try(
  $$ update public.categories set name = 'Geändert (aal1)'
     where id in ('ca000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002') $$);
select pg_temp.try(
  $$ update public.quizzes set title = 'Geändert (aal1)'
     where id = 'da000000-0000-4000-8000-000000000001' $$);
select pg_temp.try(
  $$ update public.questions set text = 'Geändert (aal1)?'
     where id = 'ea000000-0000-4000-8000-000000000001' $$);
select pg_temp.try(
  $$ update public.answers set text = 'Geändert (aal1)'
     where id = 'fa000000-0000-4000-8000-000000000001' $$);
select pg_temp.try(
  $$ delete from public.answers where id = 'fa000000-0000-4000-8000-000000000003' $$);
select pg_temp.try(
  $$ delete from public.questions where id = 'ea000000-0000-4000-8000-000000000002' $$);
select pg_temp.try(
  $$ delete from public.quizzes where id = 'da000000-0000-4000-8000-000000000002' $$);
select pg_temp.try(
  $$ delete from public.categories where id = 'ca000000-0000-4000-8000-000000000003' $$);

-- storage: quiz-images

select is_empty(
  $$ select name from storage.objects where bucket_id = 'quiz-images' $$,
  'an aal1 admin cannot list the objects of quiz-images'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner, owner_id) values
       ('quiz-images', 'aa000000-0000-4000-8000-000000000002.png',
        '33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333') $$,
  '42501', null,
  'an aal1 admin cannot upload an object into quiz-images'
);

select pg_temp.try(
  $$ update storage.objects set name = 'aa000000-0000-4000-8000-000000000003.png'
     where id = '0ba00000-0000-4000-8000-000000000001' $$);
select pg_temp.try(
  $$ delete from storage.objects where id = '0ba00000-0000-4000-8000-000000000001' $$);

reset role;

-- As the owner: nothing the aal1 admin tried was written --------------------

select results_eq(
  $$ select name from public.categories
     where id in ('ca000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002')
     order by id $$,
  $$ values ('Veröffentlichtes Thema'), ('Entwurfsthema') $$,
  'an aal1 admin cannot update a category, published or not'
);

select results_eq(
  $$ select title from public.quizzes where id = 'da000000-0000-4000-8000-000000000001' $$,
  $$ values ('Entwurfsquiz') $$,
  'an aal1 admin cannot update a quiz'
);

select results_eq(
  $$ select text from public.questions where id = 'ea000000-0000-4000-8000-000000000001' $$,
  $$ values ('Frage im Entwurf?') $$,
  'an aal1 admin cannot update a question'
);

select results_eq(
  $$ select text from public.answers where id = 'fa000000-0000-4000-8000-000000000001' $$,
  $$ values ('Ja') $$,
  'an aal1 admin cannot update an answer'
);

select ok(
  exists (select 1 from public.answers where id = 'fa000000-0000-4000-8000-000000000003'),
  'an aal1 admin cannot delete an answer'
);

select ok(
  exists (select 1 from public.questions where id = 'ea000000-0000-4000-8000-000000000002'),
  'an aal1 admin cannot delete a question'
);

select ok(
  exists (select 1 from public.quizzes where id = 'da000000-0000-4000-8000-000000000002'),
  'an aal1 admin cannot delete a quiz'
);

select ok(
  exists (select 1 from public.categories where id = 'ca000000-0000-4000-8000-000000000003'),
  'an aal1 admin cannot delete a category'
);

select ok(
  not exists (select 1 from public.categories where name = 'Eingeschleust')
  and not exists (select 1 from public.quizzes where title = 'Eingeschleust')
  and not exists (select 1 from public.questions where text in ('Eingeschleust?', 'Neue Frage?'))
  and not exists (select 1 from public.answers where text = 'Eingeschleust'),
  'nothing an aal1 admin tried to insert or save exists'
);

select results_eq(
  $$ select name from storage.objects where id = '0ba00000-0000-4000-8000-000000000001' $$,
  $$ values ('aa000000-0000-4000-8000-000000000001.png'::text) $$,
  'an aal1 admin can neither rename (update) nor remove (delete) an object of quiz-images'
);

select ok(
  not exists (select 1 from storage.objects
              where name = 'aa000000-0000-4000-8000-000000000002.png'),
  'the upload of an aal1 admin did not land in quiz-images'
);

select results_eq(
  $$ select array(select c.id from public.categories c order by c.sort_order, c.id) $$,
  $$ select categories from pg_temp.original_orders $$,
  'an aal1 admin cannot reorder the categories'
);

select results_eq(
  $$ select array(select z.id from public.quizzes z
                  where z.category_id = 'ca000000-0000-4000-8000-000000000001'
                  order by z.sort_order, z.id) $$,
  $$ select quizzes from pg_temp.original_orders $$,
  'an aal1 admin cannot reorder the quizzes of a category'
);

select results_eq(
  $$ select array(select q.id from public.questions q
                  where q.quiz_id = 'da000000-0000-4000-8000-000000000001'
                  order by q.sort_order, q.id) $$,
  $$ select questions from pg_temp.original_orders $$,
  'an aal1 admin cannot reorder the questions of a quiz'
);

-- The aal1 admin's refusal of each function is the learner's and the
-- anonymous user's, byte for byte.
select is(
  (select outcome from pg_temp.outcomes where caller = 'aal1 admin' and name = f.name),
  (select outcome from pg_temp.outcomes where caller = 'learner' and name = f.name),
  format('%s refuses an aal1 admin with the error it gives a learner', f.name)
)
from (values ('admin_question'), ('admin_answers'), ('save_question'),
             ('reorder_categories'), ('reorder_quizzes'), ('reorder_questions')) as f(name)
order by f.name;

select is(
  (select outcome from pg_temp.outcomes where caller = 'aal1 admin' and name = f.name),
  (select outcome from pg_temp.outcomes where caller = 'anonymous' and name = f.name),
  format('%s refuses an aal1 admin with the error it gives an anonymous user', f.name)
)
from (values ('admin_question'), ('admin_answers'), ('save_question'),
             ('reorder_categories'), ('reorder_quizzes'), ('reorder_questions')) as f(name)
order by f.name;

-- The same admin in an aal2 session: allowed ----------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select results_eq(
  $$ select id from public.categories where id = 'ca000000-0000-4000-8000-000000000002' $$,
  $$ values ('ca000000-0000-4000-8000-000000000002'::uuid) $$,
  'an aal2 admin sees an unpublished category'
);

select results_eq(
  $$ select id from public.quizzes where id = 'da000000-0000-4000-8000-000000000001' $$,
  $$ values ('da000000-0000-4000-8000-000000000001'::uuid) $$,
  'an aal2 admin sees an unpublished quiz'
);

select results_eq(
  $$ select id from public.questions where id = 'ea000000-0000-4000-8000-000000000001' $$,
  $$ values ('ea000000-0000-4000-8000-000000000001'::uuid) $$,
  'an aal2 admin sees a question of an unpublished quiz'
);

select results_eq(
  $$ select count(*)::int from public.answers
     where question_id = 'ea000000-0000-4000-8000-000000000001' $$,
  $$ values (3) $$,
  'an aal2 admin sees the answers of a question in an unpublished quiz'
);

select lives_ok(
  $$ insert into public.categories (name, published) values ('Neu (aal2)', false) $$,
  'an aal2 admin can insert a category'
);

select lives_ok(
  $$ insert into public.quizzes (category_id, title, published)
     values ('ca000000-0000-4000-8000-000000000001', 'Neu (aal2)', false) $$,
  'an aal2 admin can insert a quiz'
);

select lives_ok(
  $$ insert into public.questions (quiz_id, text, multiple_correct)
     values ('da000000-0000-4000-8000-000000000001', 'Neu (aal2)?', false) $$,
  'an aal2 admin can insert a question'
);

select lives_ok(
  $$ insert into public.answers (question_id, text, is_correct)
     values ('ea000000-0000-4000-8000-000000000001', 'Neu (aal2)', false) $$,
  'an aal2 admin can insert an answer'
);

select results_eq(
  $$ with changed as (
       update public.categories set name = 'Geändert (aal2)'
       where id = 'ca000000-0000-4000-8000-000000000002' returning id)
     select count(*)::int from changed $$,
  $$ values (1) $$,
  'an aal2 admin can update a category'
);

select results_eq(
  $$ with changed as (
       update public.quizzes set title = 'Geändert (aal2)'
       where id = 'da000000-0000-4000-8000-000000000001' returning id)
     select count(*)::int from changed $$,
  $$ values (1) $$,
  'an aal2 admin can update a quiz'
);

select results_eq(
  $$ with changed as (
       update public.questions set text = 'Geändert (aal2)?'
       where id = 'ea000000-0000-4000-8000-000000000001' returning id)
     select count(*)::int from changed $$,
  $$ values (1) $$,
  'an aal2 admin can update a question'
);

select results_eq(
  $$ with changed as (
       update public.answers set text = 'Geändert (aal2)'
       where id = 'fa000000-0000-4000-8000-000000000001' returning id)
     select count(*)::int from changed $$,
  $$ values (1) $$,
  'an aal2 admin can update an answer'
);

select results_eq(
  $$ with gone as (
       delete from public.answers where id = 'fa000000-0000-4000-8000-000000000003' returning id)
     select count(*)::int from gone $$,
  $$ values (1) $$,
  'an aal2 admin can delete an answer'
);

select results_eq(
  $$ with gone as (
       delete from public.questions where id = 'ea000000-0000-4000-8000-000000000002' returning id)
     select count(*)::int from gone $$,
  $$ values (1) $$,
  'an aal2 admin can delete a question'
);

select results_eq(
  $$ with gone as (
       delete from public.quizzes where id = 'da000000-0000-4000-8000-000000000002' returning id)
     select count(*)::int from gone $$,
  $$ values (1) $$,
  'an aal2 admin can delete a quiz'
);

select results_eq(
  $$ with gone as (
       delete from public.categories where id = 'ca000000-0000-4000-8000-000000000003' returning id)
     select count(*)::int from gone $$,
  $$ values (1) $$,
  'an aal2 admin can delete a category'
);

-- storage: quiz-images

select results_eq(
  $$ select name from storage.objects where id = '0ba00000-0000-4000-8000-000000000001' $$,
  $$ values ('aa000000-0000-4000-8000-000000000001.png'::text) $$,
  'an aal2 admin can list the objects of quiz-images'
);

select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner, owner_id) values
       ('quiz-images', 'aa000000-0000-4000-8000-000000000004.png',
        '33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333') $$,
  'an aal2 admin can upload an object into quiz-images'
);

select results_eq(
  $$ with changed as (
       update storage.objects set name = 'aa000000-0000-4000-8000-000000000005.png'
       where id = '0ba00000-0000-4000-8000-000000000001' returning id)
     select count(*)::int from changed $$,
  $$ values (1) $$,
  'an aal2 admin can rename (update) an object of quiz-images'
);

select results_eq(
  $$ with gone as (
       delete from storage.objects where id = '0ba00000-0000-4000-8000-000000000001' returning id)
     select count(*)::int from gone $$,
  $$ values (1) $$,
  'an aal2 admin can remove (delete) an object of quiz-images'
);

-- admin functions

select results_eq(
  $$ select explanation from public.admin_question('ea000000-0000-4000-8000-000000000001') $$,
  $$ values ('Die Erklärung.'::text) $$,
  'an aal2 admin reads a question with its explanation through admin_question'
);

select results_eq(
  $$ select (count(*) filter (where is_correct))::int
     from public.admin_answers('ea000000-0000-4000-8000-000000000001') $$,
  $$ values (1) $$,
  'an aal2 admin reads the answers with is_correct through admin_answers'
);

select is(
  pg_temp.outcome($$ select public.save_question(
        'da000000-0000-4000-8000-000000000001', null, 'Gespeichert (aal2)?', 'Weil.', false,
        '[{"text": "Ja", "is_correct": true}, {"text": "Nein", "is_correct": false}]'::jsonb) $$),
  'ok',
  'an aal2 admin can call save_question'
);

select results_eq(
  $$ select count(*)::int from public.questions where text = 'Gespeichert (aal2)?' $$,
  $$ values (1) $$,
  'an aal2 admin saves a question through save_question'
);

reset role;

-- The reorder functions need the full current lists; read them again as the
-- owner, since the aal2 admin added and removed rows above.
update pg_temp.full_lists set
  categories = array(select c.id from public.categories c order by c.sort_order desc, c.id),
  quizzes = array(select z.id from public.quizzes z
                  where z.category_id = 'ca000000-0000-4000-8000-000000000001'
                  order by z.sort_order desc, z.id),
  questions = array(select q.id from public.questions q
                    where q.quiz_id = 'da000000-0000-4000-8000-000000000001'
                    order by q.sort_order desc, q.id);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "aal": "aal2"}', true);

select lives_ok(
  $$ select public.reorder_categories((select categories from pg_temp.full_lists)) $$,
  'an aal2 admin can reorder the categories'
);

select lives_ok(
  $$ select public.reorder_quizzes('ca000000-0000-4000-8000-000000000001',
       (select quizzes from pg_temp.full_lists)) $$,
  'an aal2 admin can reorder the quizzes of a category'
);

select lives_ok(
  $$ select public.reorder_questions('da000000-0000-4000-8000-000000000001',
       (select questions from pg_temp.full_lists)) $$,
  'an aal2 admin can reorder the questions of a quiz'
);

reset role;

select results_eq(
  $$ select array(select c.id from public.categories c order by c.sort_order, c.id) $$,
  $$ select categories from pg_temp.full_lists $$,
  'the aal2 admin''s new category order is stored'
);

select results_eq(
  $$ select array(select z.id from public.quizzes z
                  where z.category_id = 'ca000000-0000-4000-8000-000000000001'
                  order by z.sort_order, z.id) $$,
  $$ select quizzes from pg_temp.full_lists $$,
  'the aal2 admin''s new quiz order is stored'
);

select results_eq(
  $$ select array(select q.id from public.questions q
                  where q.quiz_id = 'da000000-0000-4000-8000-000000000001'
                  order by q.sort_order, q.id) $$,
  $$ select questions from pg_temp.full_lists $$,
  'the aal2 admin''s new question order is stored'
);

select * from finish();
rollback;
