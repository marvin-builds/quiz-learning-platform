-- save_question compares answer ids as uuids (security review #37, D2).
--
-- The duplicate check compared the payload's ids as text, so one answer id
-- in two spellings (upper case, braces, no hyphens) passed as two answers,
-- although the writes keep only one. On a multiple-choice question such a
-- payload could still keep the rules after the writes and commit. Now the
-- ids are cast to uuid before they are compared, so the call raises 23514
-- 'question_answers_rules' before any write; an id that is no uuid raises
-- 22P02 from the cast, as before.
--
-- As in ..._admin_reordering; only the duplicate check changes. Same
-- signature and grants.

create or replace function public.save_question(
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
  answer_id uuid;
  answer_position bigint;
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
  -- answer, so such a payload is refused like any other rule break. Compared
  -- as uuids, so two spellings of one id count as the same answer.
  if answer_count < 2
     or correct_count < 1
     or (select count(distinct (e->>'id')::uuid) <> count(e->>'id')
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.answers.sort_order'), pg_catalog.hashtext(saved_id::text));

  delete from public.answers a
  where a.question_id = saved_id
    and a.id not in (
      select (e->>'id')::uuid from pg_catalog.jsonb_array_elements(save_question.answers) e
      where e->>'id' is not null);

  for answer, answer_position in
    select e, n from pg_catalog.jsonb_array_elements(save_question.answers) with ordinality as t(e, n)
  loop
    if answer->>'id' is null then
      insert into public.answers (question_id, text, is_correct, image_path, image_alt)
      values (saved_id, answer->>'text', coalesce((answer->>'is_correct')::boolean, false),
              answer->>'image_path', answer->>'image_alt')
      returning id into answer_id;
      update public.answers a set sort_order = answer_position where a.id = answer_id;
    else
      update public.answers a
      set text = answer->>'text',
          is_correct = coalesce((answer->>'is_correct')::boolean, false),
          image_path = answer->>'image_path',
          image_alt = answer->>'image_alt',
          sort_order = answer_position
      where a.id = (answer->>'id')::uuid;
    end if;
  end loop;

  return saved_id;
end;
$$;
