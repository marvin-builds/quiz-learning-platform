-- Admins edit the answers of a question, mark which are correct, and can't
-- save an inconsistent question (#82).
--
-- Rules: a question has at least two answers and at least one correct one;
-- a single-choice question (multiple_correct = false) has exactly one. A
-- quiz may only become published while it has questions and every one of
-- them keeps these rules, and the last question of a published quiz can't
-- be deleted. Refusals are SQLSTATE 23514 (check_violation) with the
-- message 'question_answers_rules' or 'quiz_publish_rules', which the
-- client maps to a translated explanation.
--
-- How (ADR 0002): answers are written row by row, so the rules are
-- deferrable, initially deferred constraint triggers in schema internal
-- that check at the end of the transaction, as the backstop for every
-- direct table write. The editor saves through save_question() below, which
-- writes a question with its answers in one transaction and checks the
-- rules on its payload before it writes, so a refused save fails in the
-- call itself. The publish check fires only when published turns true, so
-- rows written before this rule (an empty published quiz from #81) stay as
-- they are and may still be edited or unpublished.

-- Answers: column grants and RLS, as for questions (#81) ----------------------
--
-- authenticated may insert question_id, text and is_correct, update text and
-- is_correct (no move to another question), and delete; RLS lets only an
-- admin touch a row. is_correct stays unselectable for every role: an admin
-- reads it through admin_answers() below, a learner only through
-- submit_answer(). image_path, image_alt (item 5), sort_order (item 6), id
-- and created_at stay unwritable.

grant insert (question_id, text, is_correct) on public.answers to authenticated;
grant update (text, is_correct) on public.answers to authenticated;
grant delete on public.answers to authenticated;

create policy "Admins create answers"
  on public.answers for insert
  to authenticated
  with check ((select private.is_admin()));

create policy "Admins update answers"
  on public.answers for update
  to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy "Admins delete answers"
  on public.answers for delete
  to authenticated
  using ((select private.is_admin()));

-- sort_order: a new answer without one goes last within its question, under
-- a per-question advisory lock (see assign_question_sort_order).

create function internal.assign_answer_sort_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.answers.sort_order'), pg_catalog.hashtext(new.question_id::text));
  select coalesce(max(a.sort_order), 0) + 1 into new.sort_order
  from public.answers a
  where a.question_id = new.question_id;
  return new;
end;
$$;

create trigger answers_assign_sort_order
  before insert on public.answers
  for each row
  when (new.sort_order is null)
  execute function internal.assign_answer_sort_order();

-- The rules, as deferred constraint triggers ---------------------------------
--
-- Security definer, since they read is_correct, which the admin firing them
-- may not select. A question or quiz that is gone by the end of the
-- transaction needs nothing, so cascading deletes are never refused.

create function internal.question_keeps_rules(question_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) >= 2
     and case when q.multiple_correct
              then count(*) filter (where a.is_correct) >= 1
              else count(*) filter (where a.is_correct) = 1
         end
  from public.questions q
  left join public.answers a on a.question_id = q.id
  where q.id = question_keeps_rules.question_id
  group by q.id, q.multiple_correct;
$$;

create function internal.check_question_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_id uuid;
begin
  if tg_table_name = 'questions' then
    checked_id := new.id;
  elsif tg_op = 'DELETE' then
    checked_id := old.question_id;
  else
    checked_id := new.question_id;
  end if;

  -- null: the question is gone (deleted, or its quiz or category).
  if internal.question_keeps_rules(checked_id) is false then
    raise exception using
      errcode = 'check_violation',
      message = 'question_answers_rules';
  end if;
  return null;
end;
$$;

create constraint trigger answers_keep_question_rules
  after insert or update or delete on public.answers
  deferrable initially deferred
  for each row
  execute function internal.check_question_rules();

create constraint trigger questions_keep_question_rules
  after insert or update of multiple_correct on public.questions
  deferrable initially deferred
  for each row
  execute function internal.check_question_rules();

create function internal.check_quiz_publish_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_id uuid;
begin
  if tg_table_name = 'questions' then
    checked_id := old.quiz_id;
  else
    checked_id := new.id;
  end if;

  if exists (
    select 1 from public.quizzes z
    where z.id = checked_id
      and z.published
      and (
        not exists (select 1 from public.questions q where q.quiz_id = z.id)
        or exists (
          select 1 from public.questions q
          where q.quiz_id = z.id and not internal.question_keeps_rules(q.id))
      )
  ) then
    raise exception using
      errcode = 'check_violation',
      message = 'quiz_publish_rules';
  end if;
  return null;
end;
$$;

create constraint trigger quizzes_publish_rules_on_insert
  after insert on public.quizzes
  deferrable initially deferred
  for each row
  when (new.published)
  execute function internal.check_quiz_publish_rules();

create constraint trigger quizzes_publish_rules_on_publish
  after update of published on public.quizzes
  deferrable initially deferred
  for each row
  when (new.published and not old.published)
  execute function internal.check_quiz_publish_rules();

create constraint trigger questions_keep_published_quiz_rules
  after delete on public.questions
  deferrable initially deferred
  for each row
  execute function internal.check_quiz_publish_rules();

-- admin_answers: the admin's read of one question's answers with is_correct,
-- for the edit form; the counterpart of admin_question() for the
-- explanation. Every caller who isn't an admin gets the same error, for an
-- existing question and an unknown id alike; an admin gets no row for an
-- unknown id. A table of its own, so a later column of answers doesn't reach
-- the client through it. Executable by authenticated only.

create function public.admin_answers(question_id uuid)
returns table (id uuid, text text, is_correct boolean, sort_order integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    raise exception 'not available';
  end if;

  return query
  select a.id, a.text, a.is_correct, a.sort_order
  from public.answers a
  where a.question_id = admin_answers.question_id
  order by a.sort_order, a.id;
end;
$$;

grant execute on function public.admin_answers(uuid) to authenticated;

-- save_question: the admin's save of a question with its answers in one
-- transaction. question_id null creates the question in quiz_id; otherwise
-- it updates the question (never moves it). `answers` is a JSON array of
-- {id, text, is_correct} in display order: an element with the id of one of
-- the question's answers updates it, one without an id is a new answer, and
-- the question's answers the array leaves out are deleted.
--
-- Security invoker, so the grants and RLS of questions and answers decide
-- who may write: nothing it writes can be read back through it, and it
-- returns only the question's id. Every caller who isn't an admin gets 42501
-- before anything else, so a refusal says nothing about which rows exist.
-- The payload is checked against the rules (and for blank texts) before
-- anything is written; an unknown question, a quiz the question doesn't
-- belong to, or another question's answer id raise 'not available'.

create function public.save_question(
  quiz_id uuid,
  question_id uuid,
  text text,
  explanation text,
  multiple_correct boolean,
  answers jsonb
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

  if answer_count < 2
     or correct_count < 1
     or (not save_question.multiple_correct and correct_count <> 1)
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(save_question.answers) e
       where coalesce(pg_catalog.length(pg_catalog.btrim(e->>'text', E' \t\r\n')), 0) = 0)
  then
    raise exception using errcode = 'check_violation', message = 'question_answers_rules';
  end if;

  if save_question.question_id is null then
    insert into public.questions (quiz_id, text, explanation, multiple_correct)
    values (save_question.quiz_id, save_question.text, save_question.explanation,
            save_question.multiple_correct)
    returning id into saved_id;
  else
    update public.questions q
    set text = save_question.text,
        explanation = save_question.explanation,
        multiple_correct = save_question.multiple_correct
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
      insert into public.answers (question_id, text, is_correct)
      values (saved_id, answer->>'text', coalesce((answer->>'is_correct')::boolean, false));
    else
      update public.answers a
      set text = answer->>'text',
          is_correct = coalesce((answer->>'is_correct')::boolean, false)
      where a.id = (answer->>'id')::uuid;
    end if;
  end loop;

  return saved_id;
end;
$$;

grant execute on function public.save_question(uuid, uuid, text, text, boolean, jsonb)
  to authenticated;
