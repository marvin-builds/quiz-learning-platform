-- start_attempt refuses a caller without a user itself (security review #36).
-- Only `authenticated` may execute it, so auth.uid() is set today; should a
-- later grant reach anon, the insert would otherwise fail on the not-null
-- user_id with an error that echoes the quiz id. `create or replace` keeps
-- the existing grants.

create or replace function public.start_attempt(quiz_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  question_count integer;
  unscorable_count integer;
  new_attempt_id uuid;
begin
  if (select auth.uid()) is null or not private.is_quiz_visible(start_attempt.quiz_id) then
    raise exception 'not available';
  end if;

  select
    count(*),
    count(*) filter (where correct.n = 0 or (not q.multiple_correct and correct.n > 1))
  into question_count, unscorable_count
  from public.questions q
  cross join lateral (
    select count(*) as n
    from public.answers a
    where a.question_id = q.id and a.is_correct
  ) correct
  where q.quiz_id = start_attempt.quiz_id;

  if question_count = 0 or unscorable_count > 0 then
    raise exception 'not available';
  end if;

  insert into public.attempts (user_id, quiz_id, max_score)
  values ((select auth.uid()), start_attempt.quiz_id, question_count)
  returning id into new_attempt_id;

  return new_attempt_id;
end;
$$;
