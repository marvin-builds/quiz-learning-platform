-- New objects in public are closed until a migration grants access explicitly,
-- matching the hosted project ("Automatically expose new tables" off).
-- Applies to objects created later by the migration role (postgres).

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- Postgres grants execute on every new function to PUBLIC; without this,
-- anon and authenticated could still call new functions through PUBLIC.
-- This one applies in every schema: helpers used in RLS policies or column
-- defaults (e.g. a future private.is_admin()) need an explicit grant.
alter default privileges revoke execute on functions from public;
