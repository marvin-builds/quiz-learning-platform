-- Admins create, edit, publish and delete categories through the API (#80).
--
-- authenticated may insert and update only name, description and published,
-- and delete; RLS lets only an admin (private.is_admin()) touch a row, so a
-- learner's or an anonymous user's update or delete touches nothing and
-- their insert fails. anon gets no write grant at all. A client that sends
-- sort_order, id or created_at is refused by the column grants (42501).
--
-- Deleting a category cascades to its quizzes, questions and answers through
-- the foreign keys, which bypass RLS; attempts keep their score with quiz_id
-- set null (create_attempts). No write grant on attempts is needed for that.

grant insert (name, description, published) on public.categories to authenticated;
grant update (name, description, published) on public.categories to authenticated;
grant delete on public.categories to authenticated;

create policy "Admins create categories"
  on public.categories for insert
  to authenticated
  with check ((select private.is_admin()));

create policy "Admins update categories"
  on public.categories for update
  to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy "Admins delete categories"
  on public.categories for delete
  to authenticated
  using ((select private.is_admin()));

-- sort_order: a new category without one goes last (max + 1, or 1 in an
-- empty table). The transaction-scoped advisory lock serialises concurrent
-- inserts, so two admins saving at once can't get the same position; under
-- read committed, the max is read after the lock, so it sees the other
-- insert once that has committed. Security definer, so the max covers every
-- row whatever the caller may see.
--
-- Schema `internal` holds functions the API roles never call, such as this
-- trigger function: no usage on the schema, no execute grant (firing a
-- trigger checks neither). `private` is for helpers the policies call, which
-- anon and authenticated must be able to execute (visibility_helpers.test.sql),
-- and the allow-list in function_privileges.test.sql keeps new ones out.

create schema internal;

create function internal.assign_category_sort_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.categories.sort_order'));
  select coalesce(max(c.sort_order), 0) + 1 into new.sort_order from public.categories c;
  return new;
end;
$$;

create trigger categories_assign_sort_order
  before insert on public.categories
  for each row
  when (new.sort_order is null)
  execute function internal.assign_category_sort_order();
