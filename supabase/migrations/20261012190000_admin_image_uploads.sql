-- Admins upload, replace and remove the images of questions and answers (#83).
--
-- The app uploads a picked file to the quiz-images bucket under a name it
-- chooses (a random lowercase UUID with the type's extension, at the bucket
-- root), then saves the row through save_question(), and only after that
-- removes the object of a replaced or removed image. A failed save removes
-- the object it just uploaded again. Objects can still outlive their rows
-- (cascading deletes, a removal that fails after the save); the plan's
-- decisions table (Images) says why that is acceptable and how to find them.
--
-- The name rule: `<lowercase uuid>.(png|jpg|jpeg|webp)`, no folder, no '..',
-- no original file name. It holds for the rows (a check constraint, 23514,
-- for every writer, the owner included), for save_question()'s payload
-- (23514 before anything is written) and for the objects (the Storage
-- policies' WITH CHECK, 42501). Keep the three in step.

-- Rows: column grants on the image columns -----------------------------------
--
-- save_question() stays security invoker, so it writes the images under these
-- grants; RLS ("Admins create/update questions/answers") keeps them to
-- admins. A direct write by an admin is allowed too and meets the same
-- constraints. Image columns aren't solutions, so this reveals nothing.

grant insert (image_path, image_alt), update (image_path, image_alt)
  on public.questions to authenticated;
grant insert (image_path, image_alt), update (image_path, image_alt)
  on public.answers to authenticated;

alter table public.questions
  add constraint questions_image_path_name check (
    image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
  );

alter table public.answers
  add constraint answers_image_path_name check (
    image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
  );

-- Objects: Storage policies on quiz-images -----------------------------------
--
-- Admins insert, update and delete objects of quiz-images, only there and
-- only under the name rule; an update can't move an object to another bucket
-- or rename it to a name outside the name rule. It can rename it to another
-- valid name, which detaches it from the row that names it; only an admin
-- can, and policies can't compare the old and new name (that would need a
-- trigger), so this is accepted. This supersedes the comment of
-- ..._create_quiz_images_bucket ("nobody can write"), which stays as applied.
--
-- Deviation from "listing the bucket stays closed" (#83, decisions D4): the
-- admin may also select (list) the objects of quiz-images, because Storage's
-- remove() deletes with RETURNING and, without a select policy, reports
-- success while deleting nothing. Listing stays closed for anon, anonymous
-- users and learners; everyone reads an image through its public URL, which
-- needs no policy. Bucket rows stay unwritable for everyone.

create policy "Admins list quiz images"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'quiz-images' and (select private.is_admin()));

create policy "Admins upload quiz images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'quiz-images'
    and (select private.is_admin())
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
  );

create policy "Admins update quiz images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'quiz-images' and (select private.is_admin()))
  with check (
    bucket_id = 'quiz-images'
    and (select private.is_admin())
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
  );

create policy "Admins remove quiz images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'quiz-images' and (select private.is_admin()));

-- save_question with images ----------------------------------------------------
--
-- As before (..._admin_answer_writes_and_rules), plus the question's image in
-- two trailing parameters (default null: no image) and each answer's in
-- image_path and image_alt of its `answers` element. A null image_path saves
-- no image, which removes one the row had. The image rules (alt text with
-- every image, the name rule) are checked on the payload before anything is
-- written, like the answer rules. It writes rows only, never Storage. The
-- six-argument overload is dropped, so no caller can skip the images by
-- accident.

drop function public.save_question(uuid, uuid, text, text, boolean, jsonb);

create function public.save_question(
  quiz_id uuid,
  question_id uuid,
  text text,
  explanation text,
  multiple_correct boolean,
  answers jsonb,
  image_path text default null,
  image_alt text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved_id uuid;
  answer jsonb;
  answer_count integer;
  correct_count integer;
begin
  if not (select private.is_admin()) then
    raise exception 'permission denied for function save_question' using errcode = 'insufficient_privilege';
  end if;

  if pg_catalog.jsonb_typeof(save_question.answers) is distinct from 'array' then
    raise exception using errcode = 'check_violation', message = 'question_answers_rules';
  end if;

  select count(*), count(*) filter (where coalesce((e->>'is_correct')::boolean, false))
  into answer_count, correct_count
  from pg_catalog.jsonb_array_elements(save_question.answers) e;

  -- An answer id named twice would be counted twice here but keep only one
  -- answer, so such a payload is refused like any other rule break.
  if answer_count < 2
     or correct_count < 1
     or (select count(distinct e->>'id') <> count(e->>'id')
         from pg_catalog.jsonb_array_elements(save_question.answers) e)
     or (not save_question.multiple_correct and correct_count <> 1)
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(save_question.answers) e
       where coalesce(pg_catalog.length(pg_catalog.btrim(e->>'text', E' \t\r\n')), 0) = 0)
  then
    raise exception using errcode = 'check_violation', message = 'question_answers_rules';
  end if;

  -- The question's image and every answer's: the name rule and an alt text.
  if exists (
    select 1
    from (
      select save_question.image_path as path, save_question.image_alt as alt
      union all
      select e->>'image_path', e->>'image_alt'
      from pg_catalog.jsonb_array_elements(save_question.answers) e
    ) i
    where i.path is not null
      and (i.path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
           or coalesce(pg_catalog.length(pg_catalog.btrim(i.alt, E' \t\r\n')), 0) = 0)
  ) then
    raise exception using errcode = 'check_violation', message = 'image_rules';
  end if;

  if save_question.question_id is null then
    insert into public.questions (quiz_id, text, explanation, multiple_correct, image_path, image_alt)
    values (save_question.quiz_id, save_question.text, save_question.explanation,
            save_question.multiple_correct, save_question.image_path, save_question.image_alt)
    returning id into saved_id;
  else
    update public.questions q
    set text = save_question.text,
        explanation = save_question.explanation,
        multiple_correct = save_question.multiple_correct,
        image_path = save_question.image_path,
        image_alt = save_question.image_alt
    where q.id = save_question.question_id and q.quiz_id = save_question.quiz_id
    returning q.id into saved_id;

    if saved_id is null then
      raise exception 'not available';
    end if;
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_array_elements(save_question.answers) e
    where e->>'id' is not null
      and not exists (
        select 1 from public.answers a
        where a.id = (e->>'id')::uuid and a.question_id = saved_id)
  ) then
    raise exception 'not available';
  end if;

  delete from public.answers a
  where a.question_id = saved_id
    and a.id not in (
      select (e->>'id')::uuid from pg_catalog.jsonb_array_elements(save_question.answers) e
      where e->>'id' is not null);

  for answer in select e from pg_catalog.jsonb_array_elements(save_question.answers) e
  loop
    if answer->>'id' is null then
      insert into public.answers (question_id, text, is_correct, image_path, image_alt)
      values (saved_id, answer->>'text', coalesce((answer->>'is_correct')::boolean, false),
              answer->>'image_path', answer->>'image_alt');
    else
      update public.answers a
      set text = answer->>'text',
          is_correct = coalesce((answer->>'is_correct')::boolean, false),
          image_path = answer->>'image_path',
          image_alt = answer->>'image_alt'
      where a.id = (answer->>'id')::uuid;
    end if;
  end loop;

  return saved_id;
end;
$$;

grant execute on function public.save_question(uuid, uuid, text, text, boolean, jsonb, text, text)
  to authenticated;
