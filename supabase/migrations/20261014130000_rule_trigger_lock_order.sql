-- Lock order of the rule checks, and a stale category in submit_answer
-- (issue #127, the limits D4 and D5 of the row locks from security review
-- #37, ..._rule_trigger_and_answer_locks).
--
-- D4: each deferred rule check locked the row it checks when it fired, in
-- the order of the transaction's writes. Two admin transactions that touched
-- the same two parents in opposite orders locked them in opposite orders at
-- commit and one failed with a deadlock (40P01). Now plain AFTER ROW
-- triggers, with the same events and conditions as the constraint triggers,
-- record each parent a check will lock in a temp table of the session
-- (pg_temp.rule_check_parents, emptied at the end of every transaction).
-- Each check first calls internal.lock_rule_check_parents(), which locks
-- every parent recorded since the last check, FOR NO KEY UPDATE as before,
-- in a fixed order: the quizzes, then the questions, each sorted by id, and
-- then forgets them. So the first check of a commit (or of a `set
-- constraints all immediate`) takes all the transaction's parent locks in
-- that order and the later checks take none out of order. Parents first,
-- like the delete cascades and submit_answer (category, quiz, question);
-- no test pins the order across tables, so keep it when changing this.
-- The locks are taken when the checks run, not when the writes run, so a
-- write never waits for another admin's pending checks. The per-row lock in
-- each check stays as a fallback for a parent that wasn't recorded (it is
-- then locked in event order, as before).
--
-- Answer writes record only their question, never its quiz, as before.
-- The table belongs to the function owner, so the API roles can't read or
-- fill it; a table of that name the session created itself makes the write
-- and the check fail rather than being trusted
-- (internal.rule_check_parents_exists).
--
-- Not covered: the row locks the writes themselves take when they run
-- (an UPDATE or DELETE locks its row at once). Two transactions writing the
-- same rows in opposite orders still deadlock at the write. save_question
-- writes one question per call; a later bulk edit or import RPC must write
-- its rows in id order.
--
-- D5: submit_answer read the quiz's category, locked it FOR SHARE, then
-- locked the quiz. A quiz moved to another category while the call waited
-- for the quiz lock left the new category unlocked. Now the call re-reads
-- the quiz's category after the quiz lock, in a statement of its own, and
-- refuses with 'not available' (storing nothing) if it is no longer the
-- category it locked. A wait that ends without a category change (a new
-- title) still answers. Locking the new category after the quiz instead
-- would invert the parents-first order against a category delete.
--
-- The functions keep their signatures and grants (none for the API roles;
-- default privileges revoke execute from public).

-- The record of a transaction's parents ---------------------------------------

-- Whether the session's pg_temp.rule_check_parents exists; raises when one
-- exists that the functions' owner didn't create, so neither the recording
-- trigger nor the lock function ever reads a table the session made itself.

create function internal.rule_check_parents_exists()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  table_owner oid;
begin
  select c.relowner into table_owner
  from pg_catalog.pg_class c
  where c.oid = pg_catalog.to_regclass('pg_temp.rule_check_parents');

  if table_owner is null then
    return false;
  elsif table_owner is distinct from (
    select r.oid from pg_catalog.pg_roles r where r.rolname = current_user
  ) then
    raise exception 'pg_temp.rule_check_parents is not the rule checks'' table';
  end if;
  return true;
end;
$$;

create function internal.record_rule_check_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_kind text := tg_argv[0];
  parent_id uuid;
begin
  if parent_kind = 'quiz' then
    if tg_table_name = 'questions' then
      parent_id := old.quiz_id;
    else
      parent_id := new.id;
    end if;
  elsif tg_table_name = 'questions' then
    parent_id := new.id;
  elsif tg_op = 'DELETE' then
    parent_id := old.question_id;
  else
    parent_id := new.question_id;
  end if;

  if not internal.rule_check_parents_exists() then
    create temporary table rule_check_parents (
      kind text not null,
      id uuid not null,
      primary key (kind, id)
    ) on commit delete rows;
  end if;

  insert into pg_temp.rule_check_parents (kind, id)
  values (parent_kind, parent_id)
  on conflict do nothing;
  return null;
end;
$$;

-- Same events and conditions as the constraint triggers in
-- ..._admin_answer_writes_and_rules.

create trigger answers_record_rule_parent
  after insert or update or delete on public.answers
  for each row
  execute function internal.record_rule_check_parent('question');

create trigger questions_record_rule_parent
  after insert or update of multiple_correct on public.questions
  for each row
  execute function internal.record_rule_check_parent('question');

create trigger quizzes_record_rule_parent_on_insert
  after insert on public.quizzes
  for each row
  when (new.published)
  execute function internal.record_rule_check_parent('quiz');

create trigger quizzes_record_rule_parent_on_publish
  after update of published on public.quizzes
  for each row
  when (new.published and not old.published)
  execute function internal.record_rule_check_parent('quiz');

create trigger questions_record_published_quiz_parent
  after delete on public.questions
  for each row
  execute function internal.record_rule_check_parent('quiz');

-- Locks the recorded parents in order and forgets them. Each lock runs in a
-- statement of its own before the caller's check, so the check sees what the
-- locks waited for. A parent that is gone needs no lock.

create function internal.lock_rule_check_parents()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not internal.rule_check_parents_exists() then
    return;
  end if;

  perform 1
  from public.quizzes z
  where z.id in (select p.id from pg_temp.rule_check_parents p where p.kind = 'quiz')
  order by z.id
  for no key update;

  perform 1
  from public.questions q
  where q.id in (select p.id from pg_temp.rule_check_parents p where p.kind = 'question')
  order by q.id
  for no key update;

  -- `where true`: the API sessions load pg_safeupdate, which refuses a
  -- delete without a WHERE clause.
  delete from pg_temp.rule_check_parents where true;
end;
$$;

-- The checks: as in ..._rule_trigger_and_answer_locks, plus the ordered
-- locks first.

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

  perform internal.lock_rule_check_parents();

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

  perform internal.lock_rule_check_parents();

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

-- submit_answer: as in ..._rule_trigger_and_answer_locks, plus the
-- category re-read of step 1b.

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
  locked_category_id uuid;
begin
  -- 1. The caller's attempt, whose quiz still exists and is visible now,
  --    and a question of that quiz that existed when the attempt started.
  --    The visibility check runs on every call, first or repeated.
  --    Locks, in the order of a quiz or category delete (parents first,
  --    then the attempts its cascade sets to null), so a concurrent delete
  --    can't deadlock with this call:
  --    a. the attempt's quiz and its category, read without a lock;
  --    b. the category, then the quiz, FOR SHARE: an unpublish or delete
  --       commits first or waits for this call; other answers don't wait.
  --       Then the quiz's category again, in a statement of its own: if the
  --       quiz moved while the call waited, the locked category is no
  --       longer its own, and the call refuses;
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

  select z.category_id into locked_category_id
  from public.quizzes z
  where z.id = attempt_quiz_id;

  perform 1 from public.categories c where c.id = locked_category_id for share;

  perform 1 from public.quizzes z where z.id = attempt_quiz_id for share;

  if (select z.category_id from public.quizzes z where z.id = attempt_quiz_id)
    is distinct from locked_category_id
  then
    raise exception 'not available';
  end if;

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
