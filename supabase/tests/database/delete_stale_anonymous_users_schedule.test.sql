-- The pg_cron job behind #75: a migration creates pg_cron and schedules
-- private.delete_stale_anonymous_users() by job name, daily at 03:17 UTC, as
-- the database owner postgres (so the function needs no API grant and no
-- security definer). cron.schedule() upserts by name, so a re-run or a
-- `db reset` keeps exactly one job. A test can't wait for cron to fire, so
-- this file checks the job's row and runs its command once; the function's
-- rules are in delete_stale_anonymous_users.test.sql.
begin;
select plan(6);

select has_extension('pg_cron', 'the pg_cron extension is installed');

select results_eq(
  $$ select count(*)::int from cron.job where jobname = 'delete-stale-anonymous-users' $$,
  $$ values (1) $$,
  'exactly one cron job is named delete-stale-anonymous-users'
);

select results_eq(
  $$ select schedule from cron.job where jobname = 'delete-stale-anonymous-users' $$,
  $$ values ('17 3 * * *'::text) $$,
  'the cleanup job runs daily at 03:17 UTC'
);

select ok(
  (select command ilike '%private.delete_stale_anonymous_users()%'
   from cron.job where jobname = 'delete-stale-anonymous-users'),
  'the cleanup job calls private.delete_stale_anonymous_users()'
);

select ok(
  (select username = 'postgres' and database = current_database() and active
   from cron.job where jobname = 'delete-stale-anonymous-users'),
  'the cleanup job is active and runs as postgres in this database'
);

-- The job's command is valid SQL that runs: a typo in the scheduled string
-- would otherwise only show in cron.job_run_details after a deploy.
select lives_ok(
  (select command from cron.job where jobname = 'delete-stale-anonymous-users'),
  'the cleanup job''s command runs'
);

select * from finish();
rollback;
