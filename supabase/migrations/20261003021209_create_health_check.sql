-- A fixed value the app reads to prove it reaches the database.

create function public.health_check()
returns text
language sql
stable
set search_path = ''
as $$
  select 'ok'::text;
$$;

grant execute on function public.health_check() to anon, authenticated;
