-- Clean up stale anonymous users (#75). Every anonymous sign-in leaves an
-- auth user behind; one that shows no activity for the retention period is
-- deleted, and with it, through the ON DELETE CASCADE foreign keys, its
-- profile, attempts, attempt answers, sessions and identities. Users that are
-- not anonymous (registered, admins, linked accounts) are never touched.
--
-- A pg_cron job runs the cleanup daily as postgres, the job owner, so the
-- function needs no security definer and no grant to an API role.
--
-- Hosted project: this relies on postgres having DML on auth.users there
-- (not verified on hosted). After the first deploy, check
-- cron.job_run_details for the job's first run and its result.

create extension if not exists pg_cron with schema pg_catalog;

-- The single source of the retention period.
create function private.anonymous_retention_period()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '90 days'
$$;

-- Activity is the latest of the user's sign-in (or creation), their sessions'
-- refreshes, their attempts and their answers: GoTrue doesn't touch
-- last_sign_in_at on a token refresh. A user is stale when that latest
-- activity lies strictly before now() - retention (transaction time).
create function private.delete_stale_anonymous_users()
returns integer
language sql
volatile
set search_path = ''
as $$
  with deleted as (
    delete from auth.users u
    where u.is_anonymous
      and greatest(
        coalesce(u.last_sign_in_at, u.created_at),
        (select max(greatest(s.updated_at, s.refreshed_at at time zone 'utc'))
         from auth.sessions s where s.user_id = u.id),
        (select max(a.started_at) from public.attempts a where a.user_id = u.id),
        (select max(aa.answered_at)
         from public.attempt_answers aa
         join public.attempts a on a.id = aa.attempt_id
         where a.user_id = u.id)
      ) < now() - private.anonymous_retention_period()
    returning 1
  )
  select count(*)::integer from deleted
$$;

revoke execute on function private.anonymous_retention_period() from public;
revoke execute on function private.delete_stale_anonymous_users() from public;

select cron.schedule(
  'delete-stale-anonymous-users',
  '17 3 * * *',
  $$ select private.delete_stale_anonymous_users() $$
);
