-- The public bucket for images of questions and answers. `supabase config
-- push` doesn't create buckets, so this migration does on the hosted project;
-- locally, `supabase start` and `db reset` also create it from config.toml
-- and upload the seed images. Keep both in step (tests/repo checks it).
--
-- Public means anyone can read an object by its URL. Nobody can write, list
-- or delete objects: storage.objects and storage.buckets have no policies
-- for anon or authenticated (uploads for admins come with phase 2).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'quiz-images',
  'quiz-images',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;
