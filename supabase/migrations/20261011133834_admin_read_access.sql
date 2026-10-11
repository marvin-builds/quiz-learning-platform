-- Admins read every category, quiz, question and answer, published or not.
-- The role comes only from profiles.role, which the API can't write (see
-- create_profiles), never from the JWT or sign-up metadata. Rows only: the
-- solution columns stay ungranted for every role, admins included.

create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.role = 'admin' from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

grant execute on function private.is_admin() to anon, authenticated;

create policy "Admins see every category"
  on public.categories for select
  to authenticated
  using ((select private.is_admin()));

create policy "Admins see every quiz"
  on public.quizzes for select
  to authenticated
  using ((select private.is_admin()));

create policy "Admins see every question"
  on public.questions for select
  to authenticated
  using ((select private.is_admin()));

create policy "Admins see every answer"
  on public.answers for select
  to authenticated
  using ((select private.is_admin()));
