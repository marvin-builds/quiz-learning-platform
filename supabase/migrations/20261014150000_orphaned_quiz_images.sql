-- public.orphaned_quiz_images(older_than) (#125): the names of the objects in
-- the quiz-images bucket that no questions.image_path and no answers.image_path
-- names and that were created before `older_than`.
--
-- The scheduled cleanup (scripts/clean-up-images.mjs, run by a GitHub Actions
-- schedule with the secret key) passes now minus its grace period, so an
-- upload whose save is still running survives, and removes the listed objects
-- through the Storage API: Storage refuses a direct delete on storage.objects
-- (storage.protect_delete), and a row delete would leave the file behind.
--
-- It only lists, and it returns object names and nothing else. Security
-- definer, so it reads storage.objects, questions and answers as its owner
-- whatever the caller's rights; therefore only the service role may execute
-- it, never anon or authenticated (and so no admin either).

create function public.orphaned_quiz_images(older_than timestamptz)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'quiz-images'
    and o.created_at < older_than
    and not exists (select 1 from public.questions q where q.image_path = o.name)
    and not exists (select 1 from public.answers a where a.image_path = o.name)
  order by o.name;
$$;

revoke execute on function public.orphaned_quiz_images(timestamptz) from public, anon, authenticated;
grant execute on function public.orphaned_quiz_images(timestamptz) to service_role;
