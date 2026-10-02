-- One profile per auth user, created by a trigger on signup.
-- Roles are changed only by the database owner (SQL or seed), never through the API.

create type public.user_role as enum ('learner', 'admin');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role public.user_role not null default 'learner'
);

alter table public.profiles enable row level security;

-- Supabase grants everything on new public tables by default; narrow it down.
revoke all on public.profiles from anon, authenticated;
grant select, update (display_name) on public.profiles to authenticated;

create policy "Users can read their own profile"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
