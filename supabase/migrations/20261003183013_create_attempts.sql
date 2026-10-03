-- Attempts: one play-through of a quiz by a signed-in user (anonymous users
-- included). Users read only their own attempts and answers; nobody writes
-- them through the API. start_attempt() creates attempts, and
-- submit_answer() (item 3) will record and score the answers, so the client
-- can't fake a score. The score lives on the attempt, so deleting a quiz
-- (quiz_id set null, its answers cascade away) keeps a finished attempt's
-- result.

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  quiz_id uuid references public.quizzes (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  score numeric(6, 2) not null default 0,
  max_score integer not null
);

create index attempts_user_id_idx on public.attempts (user_id);
create index attempts_quiz_id_idx on public.attempts (quiz_id);

create table public.attempt_answers (
  attempt_id uuid not null references public.attempts (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  selected_answer_ids uuid[] not null,
  is_correct boolean not null,
  points numeric(6, 2) not null,
  answered_at timestamptz not null default now(),
  primary key (attempt_id, question_id)
);

create index attempt_answers_question_id_idx on public.attempt_answers (question_id);

-- Row-level security: read your own, write nothing ---------------------------

alter table public.attempts enable row level security;
alter table public.attempt_answers enable row level security;

create policy "Users can read their own attempts"
  on public.attempts for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can read the answers of their own attempts"
  on public.attempt_answers for select
  to authenticated
  using (
    -- The attempts policy limits this subquery to the caller's own attempts.
    exists (select 1 from public.attempts a where a.id = attempt_answers.attempt_id)
  );

grant select on public.attempts to authenticated;
grant select on public.attempt_answers to authenticated;

-- start_attempt ---------------------------------------------------------------
-- Every rejection raises the same error, so a caller learns nothing about
-- which quizzes exist. A quiz is playable when it is visible, has questions,
-- and every question can be scored: at least one correct answer, and exactly
-- one for a single-choice question.

create function public.start_attempt(quiz_id uuid)
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
  if not private.is_quiz_visible(start_attempt.quiz_id) then
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

grant execute on function public.start_attempt(uuid) to authenticated;
