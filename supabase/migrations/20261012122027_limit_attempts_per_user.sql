-- start_attempt bounds the attempts one user can pile up (#74).
--
-- Reuse: a call returns the caller's newest unfinished attempt on the same
-- quiz (by started_at, then id) while it has no stored answers and is still
-- consistent with the quiz (max_score = the current question count, no
-- question created after its start), instead of inserting another row.
-- Reloading the player or starting twice no longer adds attempts.
--
-- Ceiling: creating an attempt is refused while the caller has
-- internal.attempt_limits().max_unfinished unfinished attempts with a quiz
-- started within the window, across all quizzes. Reusing still works at the
-- ceiling. The refusal is the same P0001 'not available' as every other one.
--
-- Not bounded here: finished attempts don't count, so one user can still add
-- rows by finishing short quizzes; anonymous sign-ups are bounded only by the
-- auth rate limit.
--
-- Order: the existing refusals, then a transaction-scoped advisory lock per
-- user (fixed namespace, hash of the user id; a collision only serialises two
-- users' calls), so reuse, count and insert of concurrent calls by one user
-- run one after another. No lock key is computed for a caller without a user.
-- `create or replace` keeps the signature and the grants.

-- The ceiling and its window in one place. Schema internal: no API role has
-- usage or execute (default privileges revoke execute from public).
create function internal.attempt_limits(out max_unfinished integer, out window_length interval)
language sql
immutable
set search_path = ''
as $$
  select 20, interval '24 hours'
$$;

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
  limits record;
  attempt_id uuid;
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.start_attempt'), pg_catalog.hashtext((select auth.uid())::text));

  select a.id into attempt_id
  from public.attempts a
  where a.user_id = (select auth.uid())
    and a.quiz_id = start_attempt.quiz_id
    and a.finished_at is null
    and a.max_score = question_count
    and not exists (select 1 from public.attempt_answers aa where aa.attempt_id = a.id)
    and not exists (
      select 1 from public.questions q
      where q.quiz_id = start_attempt.quiz_id and q.created_at > a.started_at
    )
  order by a.started_at desc, a.id desc
  limit 1;

  if attempt_id is not null then
    return attempt_id;
  end if;

  select * into limits from internal.attempt_limits();

  if (
    select count(*)
    from public.attempts a
    where a.user_id = (select auth.uid())
      and a.finished_at is null
      and a.quiz_id is not null
      and a.started_at >= now() - limits.window_length
  ) >= limits.max_unfinished then
    raise exception 'not available';
  end if;

  insert into public.attempts (user_id, quiz_id, max_score)
  values ((select auth.uid()), start_attempt.quiz_id, question_count)
  returning id into attempt_id;

  return attempt_id;
end;
$$;
