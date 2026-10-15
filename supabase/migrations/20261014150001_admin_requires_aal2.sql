-- Admin rights need a second factor (#122): private.is_admin() is true only
-- for a caller whose profiles.role is 'admin' and whose session is aal2
-- (password and TOTP), read from the JWT's top-level "aal" claim, which only
-- GoTrue sets. Every admin policy, Storage policy and admin function calls
-- this function, so they all inherit the check. A missing, null or other
-- value is false, never an error: the policies run for everyone.

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select auth.jwt() ->> 'aal') = 'aal2'
      and (select p.role = 'admin' from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;
