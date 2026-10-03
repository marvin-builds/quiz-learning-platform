-- The quiz-images bucket and the seed images, as `supabase db reset` leaves
-- them: the bucket from supabase/config.toml (public, 5 MiB, png/jpeg/webp)
-- and the files from supabase/seed-images/ uploaded to it, so every image a
-- seeded question or answer names exists in the bucket. Image names are random
-- UUIDs at the bucket root, so a file name gives nothing away; image_path
-- holds exactly that object name, without the bucket. Read as the owner, so
-- RLS doesn't filter anything.
begin;
select plan(12);

-- The bucket --------------------------------------------------------------

select ok(
  exists (select 1 from storage.buckets where id = 'quiz-images'),
  'the quiz-images bucket exists'
);

select results_eq(
  $$ select public from storage.buckets where id = 'quiz-images' $$,
  $$ values (true) $$,
  'the quiz-images bucket is public'
);

select results_eq(
  $$ select file_size_limit from storage.buckets where id = 'quiz-images' $$,
  $$ values (5242880::bigint) $$,
  'the quiz-images bucket accepts files up to 5 MiB'
);

select results_eq(
  $$ select array(select unnest(allowed_mime_types) order by 1)
     from storage.buckets where id = 'quiz-images' $$,
  $$ values (array['image/jpeg', 'image/png', 'image/webp']) $$,
  'the quiz-images bucket accepts exactly png, jpeg and webp'
);

-- The seed ----------------------------------------------------------------

select ok(
  exists (select 1 from public.questions where image_path is not null and image_alt is not null),
  'the seed has a question with an image and an image_alt'
);

select ok(
  exists (select 1 from public.answers where image_path is not null and image_alt is not null),
  'the seed has an answer with an image and an image_alt'
);

select results_eq(
  $$ select image_path, image_alt from public.questions
     where id = '30000000-0000-4000-8000-000000000004' $$,
  $$ values ('063fa988-b996-4b4e-908f-1118f445ae46.png'::text,
             'Ausschnitt aus dem Periodensystem mit den Edelgasen'::text) $$,
  'the first question of Chemie-Grundlagen has the periodic table image (the e2e test finds it by its alt)'
);

select results_eq(
  $$ select image_path, image_alt from public.answers
     where id = '40000000-0000-4000-8000-000000000011' $$,
  $$ values ('39c5ec8d-57d6-4ab5-8ff7-f32a80a0a25d.png'::text,
             'Mit Helium gefüllter Ballon'::text) $$,
  'the answer Helium has the balloon image (the e2e test finds it by its alt)'
);

-- The e2e specs of Hauptstädte Europas find its answers by their exact
-- accessible name, which an image's alt text would change.
select is_empty(
  $$ select q.id from public.questions q
     where q.quiz_id = '20000000-0000-4000-8000-000000000001' and q.image_path is not null
     union all
     select a.id from public.answers a
     join public.questions q on q.id = a.question_id
     where q.quiz_id = '20000000-0000-4000-8000-000000000001' and a.image_path is not null $$,
  'no question or answer of Hauptstädte Europas has an image'
);

-- Every image a question or answer names was uploaded ---------------------

-- The image paths of the seed; the checks below require at least one, so they
-- can't pass on a seed without images.
create temporary view seed_image_paths as
  select image_path from public.questions where image_path is not null
  union all
  select image_path from public.answers where image_path is not null;

select ok(
  (select count(*) from pg_temp.seed_image_paths) > 0
  and not exists (
    select 1 from pg_temp.seed_image_paths p
    where not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'quiz-images' and o.name = p.image_path
    )
  ),
  'every image_path of a seeded question or answer is an object in quiz-images'
);

-- Names give nothing away -------------------------------------------------

select ok(
  (select count(*) from pg_temp.seed_image_paths) > 0
  and not exists (
    select 1 from pg_temp.seed_image_paths
    where image_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$'
  ),
  'every seeded image_path is a UUID with an image extension, at the bucket root'
);

select ok(
  (select count(*) from storage.objects where bucket_id = 'quiz-images') > 0
  and not exists (
    select 1 from storage.objects
    where bucket_id = 'quiz-images'
      and name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$'
  ),
  'the bucket holds seed images, each named by a UUID with an image extension'
);

select * from finish();
rollback;
