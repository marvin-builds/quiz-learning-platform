-- storage.objects and storage.buckets for the quiz-images bucket: nobody
-- writes to it through the API in phase 1 (anon, an anonymous user, a learner,
-- an admin), and nobody can list its objects: the images are read through the
-- bucket's public URL, which needs no select policy, while a select policy
-- would let list() reveal every file name. Uploads by admins come with
-- phase 2.
--
-- Without a policy, RLS hides every row, so an update or delete changes
-- nothing rather than raising; those tests check as the owner that the row is
-- unchanged. pg_temp.attempt() also accepts a 42501 (a revoked grant) and a
-- 23503 (deleting the bucket while it still holds objects), since either way
-- nothing changes; the owner's check decides. Storage's protect_delete trigger
-- refuses any direct delete unless storage.allow_delete_query is set; the
-- tests set it, so only RLS stands between a role and the delete. The
-- positive control at the end adds permissive policies inside the transaction
-- and shows the same reads and writes then succeed, so the deny checks can
-- fail.
--
-- The target object is created here as the owner, independent of the seed's
-- images, and reset before each role, so one role's failure doesn't carry
-- over to the next. Everything vanishes on rollback.
begin;
select plan(35);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- Runs a write as the current role; a refused grant (42501) or a delete the
-- bucket's objects block (23503) counts as "nothing written" too. Anything
-- else (e.g. the protect_delete trigger) still raises.
create function pg_temp.attempt(statement text) returns void
language plpgsql as $$
begin
  execute statement;
exception when insufficient_privilege or foreign_key_violation then
  null;
end;
$$;
grant execute on function pg_temp.attempt(text) to anon, authenticated;

-- Whether the bucket existed before the tests; only then does
-- reset_fixture() put it back, so a missing bucket still fails below.
create temporary table bucket_existed as
  select exists (select 1 from storage.buckets where id = 'quiz-images') as existed;

-- As the owner: the bucket as configured and the target object as created,
-- whatever an earlier role managed to change. Without the bucket the object
-- can't be created; the checks below then fail on its absence.
create function pg_temp.reset_fixture() returns void
language plpgsql as $$
begin
  if (select existed from pg_temp.bucket_existed) then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('quiz-images', 'quiz-images', true, 5242880,
            array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
  insert into storage.objects (id, bucket_id, name, metadata)
  values ('0b000000-0000-4000-8000-000000000001', 'quiz-images', 'b2f4a3c1-0d1e-4f5a-9b6c-7d8e9f0a1b2c.png', '{"mimetype": "image/png"}')
  on conflict (id) do update
    set bucket_id = excluded.bucket_id,
        name = excluded.name,
        metadata = excluded.metadata;
exception when foreign_key_violation then
  null;
end;
$$;

-- Lets the delete tests reach RLS instead of the protect_delete trigger.
set local storage.allow_delete_query = 'true';

select ok(
  exists (select 1 from storage.buckets where id = 'quiz-images'),
  'the quiz-images bucket exists'
);

select pg_temp.reset_fixture();

select ok(
  exists (select 1 from storage.objects where id = '0b000000-0000-4000-8000-000000000001'),
  'fixture: the owner puts an image into quiz-images'
);

-- anon --------------------------------------------------------------------

select pg_temp.reset_fixture();

set local role anon;
select set_config('request.jwt.claims',
  '{"role": "anon"}', true);

select is_empty(
  $$ select name from storage.objects where bucket_id = 'quiz-images' $$,
  'anon cannot list the objects of quiz-images'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
       ('quiz-images', '6e1f0c2a-anon-4a5b-8c9d-00000000000a.png') $$,
  '42501', null,
  'anon cannot insert an object into quiz-images'
);

select pg_temp.attempt(
  $$ update storage.objects set name = 'geaendert-anon.png', metadata = '{}'
     where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ delete from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ update storage.buckets
     set public = false, file_size_limit = 1, allowed_mime_types = array['text/html']
     where id = 'quiz-images' $$);
select pg_temp.attempt(
  $$ delete from storage.buckets where id = 'quiz-images' $$);

select throws_ok(
  $$ insert into storage.buckets (id, name, public) values ('anon-bucket', 'anon-bucket', true) $$,
  '42501', null,
  'anon cannot create a bucket'
);

reset role;

select results_eq(
  $$ select name, metadata from storage.objects
     where id = '0b000000-0000-4000-8000-000000000001' $$,
  $$ values ('b2f4a3c1-0d1e-4f5a-9b6c-7d8e9f0a1b2c.png'::text, '{"mimetype": "image/png"}'::jsonb) $$,
  'anon can neither update nor delete an object in quiz-images'
);

select results_eq(
  $$ select public, file_size_limit, array(select unnest(allowed_mime_types) order by 1)
     from storage.buckets where id = 'quiz-images' $$,
  $$ values (true, 5242880::bigint, array['image/jpeg', 'image/png', 'image/webp']) $$,
  'anon can neither change nor delete the quiz-images bucket'
);

select is_empty(
  $$ select 1 from storage.objects
     where bucket_id = 'quiz-images' and name like '6e1f0c2a-anon-%' $$,
  'the object anon tried to insert does not exist'
);

-- anonymous user (guest) --------------------------------------------------

select pg_temp.reset_fixture();

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}', true);

select is_empty(
  $$ select name from storage.objects where bucket_id = 'quiz-images' $$,
  'an anonymous user cannot list the objects of quiz-images'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner, owner_id) values
       ('quiz-images', '6e1f0c2a-2222-4a5b-8c9d-000000000002.png',
        '44444444-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444') $$,
  '42501', null,
  'an anonymous user cannot insert an object into quiz-images'
);

select pg_temp.attempt(
  $$ update storage.objects set name = 'geaendert-gast.png', metadata = '{}'
     where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ delete from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ update storage.buckets
     set public = false, file_size_limit = 1, allowed_mime_types = array['text/html']
     where id = 'quiz-images' $$);
select pg_temp.attempt(
  $$ delete from storage.buckets where id = 'quiz-images' $$);

select throws_ok(
  $$ insert into storage.buckets (id, name, public) values ('gast-bucket', 'gast-bucket', true) $$,
  '42501', null,
  'an anonymous user cannot create a bucket'
);

reset role;

select results_eq(
  $$ select name, metadata from storage.objects
     where id = '0b000000-0000-4000-8000-000000000001' $$,
  $$ values ('b2f4a3c1-0d1e-4f5a-9b6c-7d8e9f0a1b2c.png'::text, '{"mimetype": "image/png"}'::jsonb) $$,
  'an anonymous user can neither update nor delete an object in quiz-images'
);

select results_eq(
  $$ select public, file_size_limit, array(select unnest(allowed_mime_types) order by 1)
     from storage.buckets where id = 'quiz-images' $$,
  $$ values (true, 5242880::bigint, array['image/jpeg', 'image/png', 'image/webp']) $$,
  'an anonymous user can neither change nor delete the quiz-images bucket'
);

select is_empty(
  $$ select 1 from storage.objects
     where bucket_id = 'quiz-images' and name like '6e1f0c2a-2222-%' $$,
  'the object an anonymous user tried to insert does not exist'
);

-- learner (alice) ---------------------------------------------------------

select pg_temp.reset_fixture();

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select is_empty(
  $$ select name from storage.objects where bucket_id = 'quiz-images' $$,
  'a learner cannot list the objects of quiz-images'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner, owner_id) values
       ('quiz-images', '6e1f0c2a-3333-4a5b-8c9d-000000000003.png',
        '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111') $$,
  '42501', null,
  'a learner cannot insert an object into quiz-images'
);

select pg_temp.attempt(
  $$ update storage.objects set name = 'geaendert-lernend.png', metadata = '{}'
     where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ delete from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ update storage.buckets
     set public = false, file_size_limit = 1, allowed_mime_types = array['text/html']
     where id = 'quiz-images' $$);
select pg_temp.attempt(
  $$ delete from storage.buckets where id = 'quiz-images' $$);

select throws_ok(
  $$ insert into storage.buckets (id, name, public) values ('lernend-bucket', 'lernend-bucket', true) $$,
  '42501', null,
  'a learner cannot create a bucket'
);

reset role;

select results_eq(
  $$ select name, metadata from storage.objects
     where id = '0b000000-0000-4000-8000-000000000001' $$,
  $$ values ('b2f4a3c1-0d1e-4f5a-9b6c-7d8e9f0a1b2c.png'::text, '{"mimetype": "image/png"}'::jsonb) $$,
  'a learner can neither update nor delete an object in quiz-images'
);

select results_eq(
  $$ select public, file_size_limit, array(select unnest(allowed_mime_types) order by 1)
     from storage.buckets where id = 'quiz-images' $$,
  $$ values (true, 5242880::bigint, array['image/jpeg', 'image/png', 'image/webp']) $$,
  'a learner can neither change nor delete the quiz-images bucket'
);

select is_empty(
  $$ select 1 from storage.objects
     where bucket_id = 'quiz-images' and name like '6e1f0c2a-3333-%' $$,
  'the object a learner tried to insert does not exist'
);

-- admin (carol): no uploads in phase 1 ------------------------------------

select pg_temp.reset_fixture();

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select is_empty(
  $$ select name from storage.objects where bucket_id = 'quiz-images' $$,
  'an admin cannot list the objects of quiz-images in phase 1'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner, owner_id) values
       ('quiz-images', '6e1f0c2a-4444-4a5b-8c9d-000000000004.png',
        '33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333') $$,
  '42501', null,
  'an admin cannot insert an object into quiz-images in phase 1'
);

select pg_temp.attempt(
  $$ update storage.objects set name = 'geaendert-admin.png', metadata = '{}'
     where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ delete from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ update storage.buckets
     set public = false, file_size_limit = 1, allowed_mime_types = array['text/html']
     where id = 'quiz-images' $$);
select pg_temp.attempt(
  $$ delete from storage.buckets where id = 'quiz-images' $$);

select throws_ok(
  $$ insert into storage.buckets (id, name, public) values ('admin-bucket', 'admin-bucket', true) $$,
  '42501', null,
  'an admin cannot create a bucket in phase 1'
);

reset role;

select results_eq(
  $$ select name, metadata from storage.objects
     where id = '0b000000-0000-4000-8000-000000000001' $$,
  $$ values ('b2f4a3c1-0d1e-4f5a-9b6c-7d8e9f0a1b2c.png'::text, '{"mimetype": "image/png"}'::jsonb) $$,
  'an admin can neither update nor delete an object in quiz-images in phase 1'
);

select results_eq(
  $$ select public, file_size_limit, array(select unnest(allowed_mime_types) order by 1)
     from storage.buckets where id = 'quiz-images' $$,
  $$ values (true, 5242880::bigint, array['image/jpeg', 'image/png', 'image/webp']) $$,
  'an admin can neither change nor delete the quiz-images bucket in phase 1'
);

select is_empty(
  $$ select 1 from storage.objects
     where bucket_id = 'quiz-images' and name like '6e1f0c2a-4444-%' $$,
  'the object an admin tried to insert does not exist'
);

-- Effects, checked as the owner -------------------------------------------

select is_empty(
  $$ select 1 from storage.buckets
     where id in ('anon-bucket', 'gast-bucket', 'lernend-bucket', 'admin-bucket') $$,
  'none of the buckets the roles tried to create exists'
);

-- Positive control --------------------------------------------------------
-- With permissive policies (rolled back with the transaction), the same reads
-- and writes succeed, so the checks above can tell a refused one from one
-- that went through.

select pg_temp.reset_fixture();

create policy test_only_quiz_images_all on storage.objects
  for all to authenticated
  using (bucket_id = 'quiz-images')
  with check (bucket_id = 'quiz-images');

create policy test_only_buckets_all on storage.buckets
  for all to authenticated
  using (true)
  with check (true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select name from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$,
  $$ values ('b2f4a3c1-0d1e-4f5a-9b6c-7d8e9f0a1b2c.png'::text) $$,
  'control: with a permissive policy, a learner can list the objects of quiz-images'
);

select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner, owner_id) values
       ('quiz-images', '6e1f0c2a-5555-4a5b-8c9d-000000000005.png',
        '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111') $$,
  'control: with a permissive policy, a learner can insert into quiz-images'
);

select pg_temp.attempt(
  $$ update storage.objects set metadata = '{"control": true}'
     where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ update storage.buckets set file_size_limit = 1 where id = 'quiz-images' $$);

select lives_ok(
  $$ insert into storage.buckets (id, name, public)
     values ('kontroll-bucket', 'kontroll-bucket', true) $$,
  'control: with a permissive policy, a learner can create a bucket'
);

reset role;

select results_eq(
  $$ select metadata from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$,
  $$ values ('{"control": true}'::jsonb) $$,
  'control: with a permissive policy, a learner''s update of the object goes through'
);

select results_eq(
  $$ select file_size_limit from storage.buckets where id = 'quiz-images' $$,
  $$ values (1::bigint) $$,
  'control: with a permissive policy, a learner''s update of the bucket goes through'
);

select ok(
  exists (select 1 from storage.objects where id = '0b000000-0000-4000-8000-000000000001'),
  'control: the object exists before the learner deletes it'
);

set local role authenticated;
select pg_temp.attempt(
  $$ delete from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$);
select pg_temp.attempt(
  $$ delete from storage.buckets where id = 'kontroll-bucket' $$);
reset role;

select is_empty(
  $$ select 1 from storage.objects where id = '0b000000-0000-4000-8000-000000000001' $$,
  'control: with a permissive policy, a learner''s delete of the object goes through'
);

select is_empty(
  $$ select 1 from storage.buckets where id = 'kontroll-bucket' $$,
  'control: with a permissive policy, a learner''s delete of a bucket goes through'
);

select * from finish();
rollback;
