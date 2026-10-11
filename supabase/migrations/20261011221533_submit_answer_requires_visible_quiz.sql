-- submit_answer refuses an attempt whose quiz isn't visible now (#76).
--
-- Decision (2026-10-12, ADR 0002 amendment addendum): every call, first or
-- repeated, needs private.is_quiz_visible(attempt.quiz_id), i.e. the quiz and
-- its category are published, for every role (no admin exemption). Otherwise
-- it raises the same 'not available' as every other rejection, stores
-- nothing and reveals no solution. Without this, an attempt started before
-- its quiz was unpublished could read the solutions of the draft an admin
-- edits in its place. The check doesn't latch: once the quiz is published
-- again, the attempt can be answered again. This replaces the #47 behavior
-- that let such an attempt still be answered and finished.
--
-- Same signature and grants as 20261003191450_create_submit_answer.sql;
-- only the attempt check changes.

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
begin
  -- 1. The caller's attempt, whose quiz still exists and is visible now,
  --    and a question of that quiz that existed when the attempt started.
  --    The visibility check runs on every call, first or repeated. The row lock
  --    serializes submissions per attempt, so two last answers at once
  --    can't both miss the finish.
  select a.* into attempt
  from public.attempts a
  where a.id = submit_answer.attempt_id
    and a.user_id = (select auth.uid())
  for update;

  if not found or attempt.quiz_id is null or not private.is_quiz_visible(attempt.quiz_id) then
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
