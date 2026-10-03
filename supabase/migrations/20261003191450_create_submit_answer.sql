-- submit_answer: the only way to the solutions (ADR 0002 amendment). It
-- records and scores the first valid answer per (attempt, question) before
-- it reveals anything, so the client can't fake a score. A later call, or one
-- that loses a concurrent first submission, gets the stored result. Every
-- rejection raises the same error and stores nothing, so a caller learns
-- nothing about attempts, questions or answers that aren't theirs.
--
-- Scoring follows plan § 7 with one point per question: single choice gives 1
-- for the correct answer, multiple choice gives picked/total for a correct
-- subset, and any wrong pick gives 0. src/domain/scoring.ts is the reference
-- the pgTAP cases mirror. The attempt's score is the running sum of its
-- stored points; it is finished once every question has a stored answer.

create function public.submit_answer(attempt_id uuid, question_id uuid, answer_ids uuid[])
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
  inserted_count integer;
  stored public.attempt_answers%rowtype;
begin
  -- 1. The caller's attempt, which still has its quiz, and a question of
  --    that quiz that existed when the attempt started. The row lock
  --    serializes submissions per attempt, so two last answers at once
  --    can't both miss the finish.
  select a.* into attempt
  from public.attempts a
  where a.id = submit_answer.attempt_id
    and a.user_id = (select auth.uid())
  for update;

  if not found or attempt.quiz_id is null then
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

    -- A concurrent first submission may have won since step 2: store
    -- nothing then, and return the winner's row.
    insert into public.attempt_answers (attempt_id, question_id, selected_answer_ids, is_correct, points)
    values (attempt.id, question.id, picked_ids, new_points = 1, new_points)
    on conflict (attempt_id, question_id) do nothing;

    get diagnostics inserted_count = row_count;

    if inserted_count = 1 then
      update public.attempts a
      set
        score = totals.score,
        finished_at = case
          when a.finished_at is null and totals.answered >= a.max_score then now()
          else a.finished_at
        end
      from (
        select coalesce(sum(aa.points), 0) as score, count(*) as answered
        from public.attempt_answers aa
        where aa.attempt_id = attempt.id
      ) totals
      where a.id = attempt.id;
    end if;

    select aa.* into stored
    from public.attempt_answers aa
    where aa.attempt_id = attempt.id and aa.question_id = question.id;
  end if;

  return query select stored.is_correct, stored.points, correct_ids, question.explanation;
end;
$$;

grant execute on function public.submit_answer(uuid, uuid, uuid[]) to authenticated;
