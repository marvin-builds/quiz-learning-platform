-- public.save_question(..., image_path, image_alt): the admin's save of a
-- question's image and its answers' images, in the same transaction as the
-- question and its answers (#83). The question's image comes in two trailing
-- parameters image_path and image_alt (default null: no image); each
-- answer's in image_path and image_alt of its `answers` element. A null
-- image_path saves the question or answer without an image, which removes
-- one it had. The function writes only the row, never Storage: the app
-- uploads the object first and removes the replaced one after the save.
--
-- The rules, checked before anything is written (23514, nothing written):
-- - image_alt is required, after trimming spaces, tabs and line breaks,
--   whenever image_path is set (questions_image_alt_required and
--   answers_image_alt_required);
-- - image_path is an object name the app chose: a lowercase UUID with
--   .png, .jpg, .jpeg or .webp, at the bucket root, so no folder, no '..',
--   no original file name and no bucket prefix (the same rule as the
--   quiz-images Storage policies, storage_quiz_images.test.sql).
--
-- save_question stays security invoker (save_question.test.sql), so it
-- writes images through the column grants on image_path and image_alt that
-- authenticated has and RLS keeps to admins; anon, an anonymous user and a
-- learner can't write them directly (questions.test.sql and
-- answers.test.sql). The name rule is a table constraint there, so it holds
-- for direct writes too, and the quiz-images Storage policies apply the same
-- rule to the objects.
--
-- Every caller who isn't an admin gets 42501 and nothing is written: no
-- user, anon, an anonymous user and a learner, also with an image payload.
-- Fixtures are created here as the owner, independent of seed.sql, and
-- vanish on rollback.
begin;
select plan(24);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Bilder', 1, true);

-- A draft, so the publish rules never interfere.
insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf mit Bildern', 1, false);

insert into public.questions
  (id, quiz_id, text, multiple_correct, sort_order, image_path, image_alt) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Welches Tier ist das?', false, 1,
   '0a1b2c3d-0000-4000-8000-000000000001.png', 'Ein Tier im Gras');

insert into public.answers
  (id, question_id, text, is_correct, sort_order, image_path, image_alt) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Fuchs', true, 1, '0a1b2c3d-0000-4000-8000-000000000003.jpg', 'Ein roter Fuchs'),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Dachs', false, 2, null, null);

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

-- A save of the fixture question with the given question image and an image
-- on its first answer, as SQL text for pg_temp.outcome().
create function pg_temp.save_fixture(
  question_path text, question_alt text, answer_path text, answer_alt text)
returns text
language sql
as $fn$
  select format(
    $q$ select public.save_question(
          quiz_id => 'd0000000-0000-0000-0000-000000000001',
          question_id => 'e0000000-0000-0000-0000-000000000001',
          text => 'Welches Tier ist das?', explanation => null, multiple_correct => false,
          answers => %L::jsonb,
          image_path => %L, image_alt => %L) $q$,
    jsonb_build_array(
      jsonb_build_object('id', 'a0000000-0000-0000-0000-000000000001', 'text', 'Fuchs',
                         'is_correct', true, 'image_path', answer_path, 'image_alt', answer_alt),
      jsonb_build_object('id', 'a0000000-0000-0000-0000-000000000002', 'text', 'Dachs',
                         'is_correct', false))::text,
    question_path, question_alt)
$fn$;

grant execute on function pg_temp.save_fixture(text, text, text, text) to anon, authenticated;

-- The fixture question's and its answers' images, read as the owner.
create function pg_temp.fixture_images()
returns table (what text, image_path text, image_alt text)
language sql
as $fn$
  select 'question', q.image_path, q.image_alt
  from public.questions q where q.id = 'e0000000-0000-0000-0000-000000000001'
  union all
  select a.text, a.image_path, a.image_alt
  from public.answers a where a.question_id = 'e0000000-0000-0000-0000-000000000001'
$fn$;

-- The fixture's images as they were set up.
create temporary table original_images as select * from pg_temp.fixture_images();

-- admin (carol): writing images ---------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select lives_ok(
  $$ select set_config('test.created', public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000001', question_id => null,
       text => 'Welcher Vogel ist das?', explanation => null, multiple_correct => false,
       answers => '[{"text": "Amsel", "is_correct": true,
                     "image_path": "0a1b2c3d-0000-4000-8000-000000000005.webp",
                     "image_alt": "Eine schwarze Amsel"},
                    {"text": "Meise", "is_correct": false}]',
       image_path => '0a1b2c3d-0000-4000-8000-000000000006.jpeg',
       image_alt => 'Ein Vogel auf einem Ast')::text, true) $$,
  'an admin creates a question with an image and alt text, and an answer with one'
);

reset role;

select results_eq(
  $$ select image_path, image_alt from public.questions
     where id = nullif(current_setting('test.created', true), '')::uuid $$,
  $$ values ('0a1b2c3d-0000-4000-8000-000000000006.jpeg'::text, 'Ein Vogel auf einem Ast'::text) $$,
  'the created question holds the image_path and image_alt that were sent'
);

select results_eq(
  $$ select text, image_path, image_alt from public.answers
     where question_id = nullif(current_setting('test.created', true), '')::uuid order by sort_order $$,
  $$ values ('Amsel'::text, '0a1b2c3d-0000-4000-8000-000000000005.webp'::text,
             'Eine schwarze Amsel'::text),
            ('Meise'::text, null::text, null::text) $$,
  'the created answers hold their image_path and image_alt; one sent without an image has none'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-000000000002.webp', 'Ein Fuchs im Schnee',
    '0a1b2c3d-0000-4000-8000-000000000004.jpeg', 'Ein Fuchs von vorn')),
  'ok',
  'an admin replaces the images of a question and of its answer'
);

reset role;

select results_eq(
  $$ select what, image_path, image_alt from pg_temp.fixture_images() order by what $$,
  $$ values ('Dachs'::text, null::text, null::text),
            ('Fuchs'::text, '0a1b2c3d-0000-4000-8000-000000000004.jpeg'::text,
             'Ein Fuchs von vorn'::text),
            ('question'::text, '0a1b2c3d-0000-4000-8000-000000000002.webp'::text,
             'Ein Fuchs im Schnee'::text) $$,
  'the replaced images and their alt texts are stored'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(null, null, null, null)),
  'ok',
  'an admin removes the images of a question and of its answer'
);

reset role;

select results_eq(
  $$ select what, image_path, image_alt from pg_temp.fixture_images() order by what $$,
  $$ values ('Dachs'::text, null::text, null::text),
            ('Fuchs'::text, null::text, null::text),
            ('question'::text, null::text, null::text) $$,
  'after removing, neither the question nor its answer has an image or an alt text'
);

-- admin: refused images --------------------------------------------------------
-- Back to the images the fixture started with; every refusal must leave them.

update public.questions q set image_path = o.image_path, image_alt = o.image_alt
from pg_temp.original_images o
where o.what = 'question' and q.id = 'e0000000-0000-0000-0000-000000000001';
update public.answers a set image_path = o.image_path, image_alt = o.image_alt
from pg_temp.original_images o
where o.what = a.text and a.question_id = 'e0000000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-000000000002.png', null, null, null)),
  '23514',
  'a question image without an alt text is refused with 23514'
);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-000000000002.png', E' \t\r\n', null, null)),
  '23514',
  'a question image with a blank alt text is refused with 23514'
);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    null, null, '0a1b2c3d-0000-4000-8000-000000000004.png', null)),
  '23514',
  'an answer image without an alt text is refused with 23514'
);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    null, null, '0a1b2c3d-0000-4000-8000-000000000004.png', E' \t\r\n')),
  '23514',
  'an answer image with a blank alt text is refused with 23514'
);

select results_eq(
  $$ select name, pg_temp.outcome(pg_temp.save_fixture(name, 'Ein Bild', null, null))
     from unnest(array[
       'periodensystem.png',
       'Mein Foto vom Urlaub.jpg',
       'ordner/0a1b2c3d-0000-4000-8000-000000000002.png',
       '../0a1b2c3d-0000-4000-8000-000000000002.png',
       '0a1b2c3d-0000-4000-8000-000000000002.png/../x.png',
       'quiz-images/0a1b2c3d-0000-4000-8000-000000000002.png',
       '/0a1b2c3d-0000-4000-8000-000000000002.png',
       '0a1b2c3d-0000-4000-8000-000000000002',
       '0a1b2c3d-0000-4000-8000-000000000002.svg',
       '0a1b2c3d-0000-4000-8000-000000000002.png.html',
       '0a1b2c3d-0000-4000-8000-00000000000.png',
       '']) with ordinality as t(name, n)
     order by n $$,
  $$ values
       ('periodensystem.png'::text, '23514'::text),
       ('Mein Foto vom Urlaub.jpg', '23514'),
       ('ordner/0a1b2c3d-0000-4000-8000-000000000002.png', '23514'),
       ('../0a1b2c3d-0000-4000-8000-000000000002.png', '23514'),
       ('0a1b2c3d-0000-4000-8000-000000000002.png/../x.png', '23514'),
       ('quiz-images/0a1b2c3d-0000-4000-8000-000000000002.png', '23514'),
       ('/0a1b2c3d-0000-4000-8000-000000000002.png', '23514'),
       ('0a1b2c3d-0000-4000-8000-000000000002', '23514'),
       ('0a1b2c3d-0000-4000-8000-000000000002.svg', '23514'),
       ('0a1b2c3d-0000-4000-8000-000000000002.png.html', '23514'),
       ('0a1b2c3d-0000-4000-8000-00000000000.png', '23514'),
       ('', '23514') $$,
  'a question image_path that is not a UUID name at the bucket root is refused with 23514'
);

select results_eq(
  $$ select name, pg_temp.outcome(pg_temp.save_fixture(null, null, name, 'Ein Bild'))
     from unnest(array[
       'fuchs.png',
       'ordner/0a1b2c3d-0000-4000-8000-000000000004.png',
       '../0a1b2c3d-0000-4000-8000-000000000004.png',
       '0a1b2c3d-0000-4000-8000-000000000004.gif']) with ordinality as t(name, n)
     order by n $$,
  $$ values
       ('fuchs.png'::text, '23514'::text),
       ('ordner/0a1b2c3d-0000-4000-8000-000000000004.png', '23514'),
       ('../0a1b2c3d-0000-4000-8000-000000000004.png', '23514'),
       ('0a1b2c3d-0000-4000-8000-000000000004.gif', '23514') $$,
  'an answer image_path that is not a UUID name at the bucket root is refused with 23514'
);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-000000000007.png', 'Ein Bild',
    '0a1b2c3d-0000-4000-8000-000000000008.jpg', 'Noch ein Bild')),
  'ok',
  'control: the same save with valid names and alt texts goes through'
);

reset role;

select results_eq(
  $$ select what, image_path, image_alt from pg_temp.fixture_images() order by what $$,
  $$ values ('Dachs'::text, null::text, null::text),
            ('Fuchs'::text, '0a1b2c3d-0000-4000-8000-000000000008.jpg'::text, 'Noch ein Bild'::text),
            ('question'::text, '0a1b2c3d-0000-4000-8000-000000000007.png'::text, 'Ein Bild'::text) $$,
  'control: the valid save is stored'
);

-- The refusals above ran before the control; check they wrote nothing by
-- repeating one and comparing with what the control stored.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);
select pg_temp.outcome(pg_temp.save_fixture(
  '../0a1b2c3d-0000-4000-8000-000000000009.png', 'Ein Bild',
  '0a1b2c3d-0000-4000-8000-000000000009.png', null));
reset role;

select results_eq(
  $$ select what, image_path, image_alt from pg_temp.fixture_images() order by what $$,
  $$ values ('Dachs'::text, null::text, null::text),
            ('Fuchs'::text, '0a1b2c3d-0000-4000-8000-000000000008.jpg'::text, 'Noch ein Bild'::text),
            ('question'::text, '0a1b2c3d-0000-4000-8000-000000000007.png'::text, 'Ein Bild'::text) $$,
  'a refused image save writes nothing: the stored images stay as they were'
);

-- Callers who aren't admins: 42501, nothing written -----------------------------

create temporary table before_callers as select * from pg_temp.fixture_images();

-- no user
set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-00000000000a.png', 'Ohne Nutzer',
    '0a1b2c3d-0000-4000-8000-00000000000b.png', 'Ohne Nutzer')),
  '42501',
  'without a user, save_question with images is refused with 42501'
);

-- anon
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-00000000000a.png', 'Von anon',
    '0a1b2c3d-0000-4000-8000-00000000000b.png', 'Von anon')),
  '42501',
  'anon cannot save images through save_question (42501)'
);

select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "anon"}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-00000000000a.png', 'Von anon',
    '0a1b2c3d-0000-4000-8000-00000000000b.png', 'Von anon')),
  '42501',
  'anon cannot save images through save_question even with an admin''s sub in the claims'
);

-- anonymous user
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-00000000000a.png', 'Vom Gast',
    '0a1b2c3d-0000-4000-8000-00000000000b.png', 'Vom Gast')),
  '42501',
  'an anonymous user cannot save images through save_question (42501)'
);

-- learner (alice)
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '0a1b2c3d-0000-4000-8000-00000000000a.png', 'Von Alice',
    '0a1b2c3d-0000-4000-8000-00000000000b.png', 'Von Alice')),
  '42501',
  'a learner cannot save images through save_question (42501)'
);

select is(
  pg_temp.outcome(pg_temp.save_fixture(
    '../geheim.png', null, 'ordner/x.png', null)),
  '42501',
  'a learner gets 42501 for an invalid image payload too, before any rule is checked'
);

reset role;

select results_eq(
  $$ select what, image_path, image_alt from pg_temp.fixture_images() order by what $$,
  $$ select what, image_path, image_alt from pg_temp.before_callers order by what $$,
  'none of the refused callers changed an image'
);

select is_empty(
  $$ select 1 from public.questions
     where image_alt in ('Ohne Nutzer', 'Von anon', 'Vom Gast', 'Von Alice')
     union all
     select 1 from public.answers
     where image_alt in ('Ohne Nutzer', 'Von anon', 'Vom Gast', 'Von Alice') $$,
  'no row holds an alt text one of the refused callers sent'
);

select * from finish();
rollback;
