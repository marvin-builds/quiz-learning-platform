-- Admins reorder categories, quizzes, questions and answers (#84).
--
-- Categories, quizzes and questions: one call per list, reorder_categories(),
-- reorder_quizzes() and reorder_questions(), with the full ordered list of
-- the parent's children. Answers: through save_question(), whose `answers`
-- payload is already in display order (the form moves answers in its unsaved
-- state, where new answers have no id yet).

-- reorder_*: the full-list contract -----------------------------------------
--
-- The list must be exactly the parent's current children (for categories:
-- every category), each once, published or not. A list with an id missing,
-- an id too many, unknown or of another parent, an id named twice, a null
-- id, an empty or null list, or an unknown or null parent changes nothing,
-- so a stale list from a second tab can't drop or duplicate a position. A
-- stale list with the same members is accepted: the last reorder wins. A
-- valid list renumbers every child 1..n in one statement.
--
-- Each takes the same transaction-scoped advisory lock as the insert trigger
-- of its table (internal.assign_*_sort_order), before it reads the current
-- children, so a concurrent insert can't get a position the reorder also
-- hands out, and the list is compared with what the reorder overwrites.
--
-- Security definer with an empty search_path, since sort_order of these
-- three tables has no column grant (no direct PATCH can write it). Guarded
-- by private.is_admin() first; executable by authenticated only. Every
-- refusal is the same P0001 'not available' with no detail or hint: a
-- non-admin whatever the list, and an admin for a list that breaks the
-- contract. They return nothing, so no solution can leak through them.

-- Whether `list` names every id of `current` exactly once and nothing else.
-- false for a null or empty list (an unknown parent has no children, so any
-- list for it is refused too).
create function internal.is_full_list(list uuid[], current uuid[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.cardinality(is_full_list.list), 0) > 0
     and pg_catalog.array_position(is_full_list.list, null) is null
     and pg_catalog.cardinality(is_full_list.list) = pg_catalog.cardinality(is_full_list.current)
     and (select count(distinct l) from pg_catalog.unnest(is_full_list.list) l)
         = pg_catalog.cardinality(is_full_list.list)
     and is_full_list.list operator(pg_catalog.@>) is_full_list.current;
$$;

create function public.reorder_categories(category_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    raise exception 'not available';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.categories.sort_order'));

  if not internal.is_full_list(
    reorder_categories.category_ids,
    array(select c.id from public.categories c))
  then
    raise exception 'not available';
  end if;

  update public.categories c
  set sort_order = o.position
  from pg_catalog.unnest(reorder_categories.category_ids) with ordinality as o(id, position)
  where c.id = o.id;
end;
$$;

create function public.reorder_quizzes(category_id uuid, quiz_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    raise exception 'not available';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.quizzes.sort_order'),
    pg_catalog.hashtext(reorder_quizzes.category_id::text));

  if not internal.is_full_list(
    reorder_quizzes.quiz_ids,
    array(select z.id from public.quizzes z where z.category_id = reorder_quizzes.category_id))
  then
    raise exception 'not available';
  end if;

  update public.quizzes z
  set sort_order = o.position
  from pg_catalog.unnest(reorder_quizzes.quiz_ids) with ordinality as o(id, position)
  where z.id = o.id;
end;
$$;

create function public.reorder_questions(quiz_id uuid, question_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    raise exception 'not available';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.questions.sort_order'),
    pg_catalog.hashtext(reorder_questions.quiz_id::text));

  if not internal.is_full_list(
    reorder_questions.question_ids,
    array(select q.id from public.questions q where q.quiz_id = reorder_questions.quiz_id))
  then
    raise exception 'not available';
  end if;

  update public.questions q
  set sort_order = o.position
  from pg_catalog.unnest(reorder_questions.question_ids) with ordinality as o(id, position)
  where q.id = o.id;
end;
$$;

grant execute on function public.reorder_categories(uuid[]) to authenticated;
grant execute on function public.reorder_quizzes(uuid, uuid[]) to authenticated;
grant execute on function public.reorder_questions(uuid, uuid[]) to authenticated;

-- Answers: an UPDATE grant on sort_order ------------------------------------
--
-- save_question() stays security invoker, so it writes sort_order under the
-- caller's grants: authenticated may update answers.sort_order (no insert;
-- a new answer gets its position from the before-insert trigger first), and
-- the admin-only RLS on answers keeps the writes to admins. A learner's,
-- anonymous user's or user-less update touches no row; anon has no grant.
--
-- Decided at gate 1 of #84 with medium confidence, for the human to check:
-- it also lets an admin PATCH answers.sort_order directly, a second write
-- path beside save_question(). Harmless (an admin may reorder anyway, and
-- the column holds no solution), but a new one. Not taken: a BEFORE UPDATE
-- trigger in internal reading a transaction-local setting that
-- save_question() sets (no grant, but an unusual security-relevant
-- mechanism); a security definer helper on the function allow-list; making
-- save_question() security definer.

grant update (sort_order) on public.answers to authenticated;

-- save_question: answers in the payload's order ------------------------------
--
-- As before (..._admin_image_uploads), plus: every answer it keeps or adds
-- gets sort_order = its 1-based position in `answers`, under the
-- per-question advisory lock that internal.assign_answer_sort_order() takes,
-- held even when no answer is new.

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
