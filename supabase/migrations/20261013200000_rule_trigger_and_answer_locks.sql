-- Row locks against write skew (security review #37, findings D1 and D3).
--
-- D1: the deferred rule triggers check a parent row's children on a
-- snapshot. Two transactions could each pass on a snapshot without the
-- other's write and both commit: two deletes of the two questions of a
-- published quiz, two deletes of two of three answers. Now each check first
-- locks the row it checks, FOR NO KEY UPDATE, in a statement of its own, so
-- the second transaction waits for the first and then checks again with a
-- fresh snapshot (read committed; a lock inside the checking statement
-- would keep that statement's older snapshot). FOR NO KEY UPDATE conflicts
-- with itself and with the UPDATE that publishes a quiz, but not with the
-- FOR KEY SHARE that foreign key checks take, so start_attempt and inserts
-- of questions and answers don't wait. A row that is gone (a cascade) is
-- not locked and needs no check, as before.
--
-- D3: submit_answer checked the quiz's visibility without a lock, so an
-- answer could reveal a solution while an admin's unpublish was committing.
-- It now locks the category and the quiz FOR SHARE before it checks.
--
-- The functions keep their signatures and grants; only the bodies change.

create or replace function internal.check_question_rules()
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

  perform 1 from public.questions q where q.id = checked_id for no key update;

  -- null: the question is gone (deleted, or its quiz or category).
  if internal.question_keeps_rules(checked_id) is false then
    raise exception using
      errcode = 'check_violation',
      message = 'question_answers_rules';
  end if;
  return null;
end;
$$;

create or replace function internal.check_quiz_publish_rules()
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

  perform 1 from public.quizzes z where z.id = checked_id for no key update;

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

-- submit_answer: as in ..._submit_answer_requires_visible_quiz, plus the
-- locks of step 1.

create or replace function public.submit_answer(attempt_id uuid, question_id uuid, answer_ids uuid[])
returns table (is_correct boolean, points numeric, correct_answer_ids uuid[], explanation text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  attempt public.attempts%rowtype;
  question public.questions%rowtype;
  correct_ids uuid[];
  picked_ids uuid[];
  new_points numeric(6, 2);
  stored public.attempt_answers%rowtype;
  attempt_quiz_id uuid;
begin
  -- 1. The caller's attempt, whose quiz still exists and is visible now,
  --    and a question of that quiz that existed when the attempt started.
  --    The visibility check runs on every call, first or repeated.
  --    Locks, in the order of a quiz or category delete (parents first,
  --    then the attempts its cascade sets to null), so a concurrent delete
  --    can't deadlock with this call:
  --    a. the attempt's quiz, read without a lock;
  --    b. the category, then the quiz, FOR SHARE: an unpublish or delete
  --       commits first or waits for this call; other answers don't wait;
  --    c. the attempt FOR UPDATE, which serializes submissions per attempt
  --       (two last answers at once can't both miss the finish), and its
  --       quiz must still be the one locked;
  --    d. visibility, in a statement of its own, so it sees what the locks
  --       waited for.
  select a.quiz_id into attempt_quiz_id
  from public.attempts a
  where a.id = submit_answer.attempt_id
    and a.user_id = (select auth.uid());

  if attempt_quiz_id is null then
    raise exception 'not available';
  end if;

  perform 1
  from public.categories c
  where c.id = (select z.category_id from public.quizzes z where z.id = attempt_quiz_id)
  for share;

  perform 1 from public.quizzes z where z.id = attempt_quiz_id for share;

  select a.* into attempt
  from public.attempts a
  where a.id = submit_answer.attempt_id
    and a.user_id = (select auth.uid())
  for update;

  if not found or attempt.quiz_id is distinct from attempt_quiz_id then
    raise exception 'not available';
  end if;

  if not private.is_quiz_visible(attempt.quiz_id) then
    raise exception 'not available';
  end if;

  select q.* into question
  from public.questions q
  where q.id = submit_answer.question_id
    and q.quiz_id = attempt.quiz_id
    and q.created_at <= attempt.started_at;

  if not found then
    raise exception 'not available';
  end if;

  select coalesce(array_agg(a.id order by a.sort_order, a.id), '{}')
  into correct_ids
  from public.answers a
  where a.question_id = question.id and a.is_correct;

  -- 2. An answer that is already stored wins, whatever answer_ids contains.
  select aa.* into stored
  from public.attempt_answers aa
  where aa.attempt_id = attempt.id and aa.question_id = question.id;

  if not found then
    -- 3. to 7. Validate the picks.
    if submit_answer.answer_ids is null or array_position(submit_answer.answer_ids, null) is not null then
      raise exception 'not available';
    end if;

    select array_agg(distinct x order by x) into picked_ids
    from unnest(submit_answer.answer_ids) as x;

    if picked_ids is null
      or (not question.multiple_correct and cardinality(picked_ids) > 1)
      or exists (
        select 1 from unnest(picked_ids) as x
        where not exists (
          select 1 from public.answers a where a.id = x and a.question_id = question.id
        )
      )
      or cardinality(correct_ids) = 0
    then
      raise exception 'not available';
    end if;

    if not picked_ids <@ correct_ids then
      new_points := 0;
    elsif question.multiple_correct then
      new_points := round(cardinality(picked_ids)::numeric / cardinality(correct_ids), 2);
    else
      new_points := 1;
    end if;

    -- Defensive: the attempt lock already serializes submit_answer calls,
    -- but a writer that bypasses it must not cause a unique violation. If
    -- one won, store nothing and return its row.
    insert into public.attempt_answers (attempt_id, question_id, selected_answer_ids, is_correct, points)
    values (
      attempt.id, question.id, picked_ids,
      picked_ids <@ correct_ids and cardinality(picked_ids) = cardinality(correct_ids),
      new_points
    )
    on conflict (attempt_id, question_id) do nothing
    returning * into stored;

    if found then
      update public.attempts a
      set
        score = totals.score,
        finished_at = coalesce(a.finished_at, case when totals.answered >= a.max_score then now() end)
      from (
        select sum(aa.points) as score, count(*) as answered
        from public.attempt_answers aa
        where aa.attempt_id = attempt.id
      ) totals
      where a.id = attempt.id;
    else
      select aa.* into stored
      from public.attempt_answers aa
      where aa.attempt_id = attempt.id and aa.question_id = question.id;
    end if;
  end if;

  return query select stored.is_correct, stored.points, correct_ids, question.explanation;
end;
$$;
