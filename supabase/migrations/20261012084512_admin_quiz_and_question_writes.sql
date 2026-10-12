-- Admins create, edit, publish and delete quizzes and questions through the
-- API (#81), as with categories (admin_category_writes).
--
-- authenticated may insert the parent id and the editable columns, update
-- only the editable columns (no move to another parent), and delete; RLS
-- lets only an admin (private.is_admin()) touch a row, so a learner's or an
-- anonymous user's update or delete touches nothing and their insert fails.
-- anon gets no write grant. sort_order, id and created_at, and the question
-- images (item 5), stay unwritable.
--
-- questions.explanation: insert and update are granted, select is not, so a
-- write can't return or filter on it. An admin reads it only through
-- admin_question() below; a learner only through submit_answer().
--
-- Deleting a quiz or question cascades to its questions, answers and the
-- attempts' recorded answers through the foreign keys, which bypass RLS;
-- attempts stay as they are (quizzes_delete_cascade.test.sql,
-- questions_delete_cascade.test.sql).

grant insert (category_id, title, description, published) on public.quizzes to authenticated;
grant update (title, description, published) on public.quizzes to authenticated;
grant delete on public.quizzes to authenticated;

grant insert (quiz_id, text, explanation, multiple_correct) on public.questions to authenticated;
grant update (text, explanation, multiple_correct) on public.questions to authenticated;
grant delete on public.questions to authenticated;

create policy "Admins create quizzes"
  on public.quizzes for insert
  to authenticated
  with check ((select private.is_admin()));

create policy "Admins update quizzes"
  on public.quizzes for update
  to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy "Admins delete quizzes"
  on public.quizzes for delete
  to authenticated
  using ((select private.is_admin()));

create policy "Admins create questions"
  on public.questions for insert
  to authenticated
  with check ((select private.is_admin()));

create policy "Admins update questions"
  on public.questions for update
  to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy "Admins delete questions"
  on public.questions for delete
  to authenticated
  using ((select private.is_admin()));

-- sort_order: a new quiz or question without one goes last within its
-- parent (max + 1, or 1 for the first). The advisory lock is per parent, so
-- concurrent inserts into one category or quiz are serialised while other
-- parents don't wait (see assign_category_sort_order).

create function internal.assign_quiz_sort_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.quizzes.sort_order'), pg_catalog.hashtext(new.category_id::text));
  select coalesce(max(z.sort_order), 0) + 1 into new.sort_order
  from public.quizzes z
  where z.category_id = new.category_id;
  return new;
end;
$$;

create trigger quizzes_assign_sort_order
  before insert on public.quizzes
  for each row
  when (new.sort_order is null)
  execute function internal.assign_quiz_sort_order();

create function internal.assign_question_sort_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.questions.sort_order'), pg_catalog.hashtext(new.quiz_id::text));
  select coalesce(max(q.sort_order), 0) + 1 into new.sort_order
  from public.questions q
  where q.quiz_id = new.quiz_id;
  return new;
end;
$$;

create trigger questions_assign_sort_order
  before insert on public.questions
  for each row
  when (new.sort_order is null)
  execute function internal.assign_question_sort_order();

-- admin_question: the admin's read of one question with its explanation, for
-- the edit form. Every caller who isn't an admin gets the same error, for an
-- existing question and an unknown id alike; an admin gets no row for an
-- unknown id. A table of its own, so a later column of questions doesn't
-- reach the client through it. Executable by authenticated only.

create function public.admin_question(question_id uuid)
returns table (id uuid, quiz_id uuid, text text, explanation text, multiple_correct boolean)
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
  select q.id, q.quiz_id, q.text, q.explanation, q.multiple_correct
  from public.questions q
  where q.id = admin_question.question_id;
end;
$$;

grant execute on function public.admin_question(uuid) to authenticated;
