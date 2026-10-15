-- Enforce the quiz-images limits on an existing bucket too (#124, S6).
-- 20261003215819_create_quiz_images_bucket.sql inserts the bucket with
-- `on conflict (id) do nothing`, so a bucket created another way on the
-- hosted project kept its own public flag, size limit and file types. Set
-- them to the values of `[storage.buckets.quiz-images]` in
-- supabase/config.toml (tests/repo checks they match); CI compares the
-- hosted bucket with them after every migration.
update storage.buckets
set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
where id = 'quiz-images';
