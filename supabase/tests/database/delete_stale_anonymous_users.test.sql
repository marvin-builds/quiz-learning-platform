-- private.delete_stale_anonymous_users() (#75): deletes anonymous auth users
-- (is_anonymous) whose every activity signal is older than the retention
-- period, and with them, through the ON DELETE CASCADE foreign keys, their
-- profile, attempts and attempt answers. It returns how many users it deleted.
-- Users that are not anonymous (registered, admins, and anonymous users
-- linked to an account, whose is_anonymous turned false) are never deleted.
--
-- The retention period lives in one place, private.anonymous_retention_period();
-- the fixtures read it rather than repeating N here.
--
-- Activity signals. GoTrue sets auth.users.last_sign_in_at on a sign-in grant
-- only, not on a refresh_token grant (checked on the local stack), so a
-- visitor who plays daily on one stored session keeps their creation-time
-- last_sign_in_at. A user is stale only when all of these are older than the
-- cutoff: coalesce(last_sign_in_at, created_at), their auth.sessions'
-- updated_at / refreshed_at, their attempts' started_at and their attempt
-- answers' answered_at.
--
-- Boundary: the cutoff is now() - retention (transaction time, so a test can
-- hit it exactly). Activity exactly at the cutoff stays; one second before it
-- goes.
--
-- Callers other than the job owner: delete_stale_anonymous_users_callers.test.sql.
-- The pg_cron schedule: delete_stale_anonymous_users_schedule.test.sql.
begin;
select plan(37);

-- Interface ---------------------------------------------------------------

select function_returns('private', 'delete_stale_anonymous_users', array[]::text[], 'integer',
  'private.delete_stale_anonymous_users() exists and returns the number of deleted users');

select hasnt_function('public', 'delete_stale_anonymous_users',
  'the cleanup is not in the API-exposed public schema');

select function_returns('private', 'anonymous_retention_period', array[]::text[], 'interval',
  'private.anonymous_retention_period() holds the retention period as an interval');

select ok(private.anonymous_retention_period() > interval '0',
  'the retention period is positive');

-- Fixtures ----------------------------------------------------------------
-- The local stack is shared with the e2e tests, whose visitors leave anonymous
-- users behind. Remove them (rolled back at the end) so the number the first
-- run returns counts only this file's stale fixtures.
delete from auth.users where is_anonymous;

-- Points in time, relative to the cutoff now() - retention.

select set_config('test.cutoff', (now() - private.anonymous_retention_period())::text, true);

create function pg_temp.cutoff() returns timestamptz language sql stable
as $$ select current_setting('test.cutoff')::timestamptz $$;
-- one second past the cutoff: stale
create function pg_temp.stale() returns timestamptz language sql stable
as $$ select pg_temp.cutoff() - interval '1 second' $$;
-- well past the cutoff
create function pg_temp.old() returns timestamptz language sql stable
as $$ select pg_temp.cutoff() - interval '30 days' $$;
-- yesterday
create function pg_temp.recent() returns timestamptz language sql stable
as $$ select now() - interval '1 day' $$;

-- Anonymous users. Ids: a1… are deleted, a… otherwise kept.
insert into auth.users (id, is_anonymous, created_at, last_sign_in_at) values
  -- stale: last sign-in one second past the cutoff, everything else older
  ('a1000000-0000-4000-8000-000000000001', true, pg_temp.old(), pg_temp.stale()),
  -- exactly at the cutoff: stays
  ('a2000000-0000-4000-8000-000000000002', true, pg_temp.old(), pg_temp.cutoff()),
  -- never signed in (null), created one second past the cutoff: stale
  ('a1000000-0000-4000-8000-000000000003', true, pg_temp.stale(), null),
  -- never signed in (null), created yesterday: stays
  ('a2000000-0000-4000-8000-000000000004', true, pg_temp.recent(), null),
  -- recent sign-in, with an attempt and an answer: stays with its data
  ('a2000000-0000-4000-8000-000000000005', true, pg_temp.recent(), pg_temp.recent()),
  -- old sign-in, but the session was refreshed yesterday: stays
  ('a2000000-0000-4000-8000-000000000006', true, pg_temp.old(), pg_temp.old()),
  -- old sign-in, but an attempt started yesterday: stays
  ('a2000000-0000-4000-8000-000000000007', true, pg_temp.old(), pg_temp.old()),
  -- old sign-in and an old attempt, but an answer given yesterday: stays
  ('a2000000-0000-4000-8000-000000000008', true, pg_temp.old(), pg_temp.old());

-- Not anonymous, all with stale timestamps, so only is_anonymous spares them.
insert into auth.users (id, email, is_anonymous, created_at, last_sign_in_at) values
  -- linked: started anonymous, then added an email identity (is_anonymous false)
  ('b0000000-0000-4000-8000-000000000001', 'linked@example.test', false,
   pg_temp.old(), pg_temp.old()),
  -- registered learner
  ('b0000000-0000-4000-8000-000000000002', 'registered@example.test', false,
   pg_temp.old(), pg_temp.old()),
  -- admin
  ('b0000000-0000-4000-8000-000000000003', 'stale-admin@example.test', false,
   pg_temp.old(), pg_temp.old());

update public.profiles set role = 'admin' where id = 'b0000000-0000-4000-8000-000000000003';

insert into auth.identities (provider_id, user_id, identity_data, provider,
                             created_at, updated_at, last_sign_in_at) values
  ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   '{"sub": "b0000000-0000-4000-8000-000000000001", "email": "linked@example.test"}',
   'email', pg_temp.old(), pg_temp.old(), pg_temp.old());

-- Sessions. refreshed_at is a timestamp without time zone, in UTC as GoTrue
-- writes it.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at) values
  -- the stale user's session, untouched for longer than the retention period
  ('c0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
   pg_temp.old(), pg_temp.old(), pg_temp.old() at time zone 'utc'),
  -- signed in long ago, refreshed yesterday
  ('c0000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000006',
   pg_temp.old(), pg_temp.recent(), pg_temp.recent() at time zone 'utc');

-- Attempts on seed.sql's "Hauptstädte Europas" and answers to its first question.
insert into public.attempts (id, user_id, quiz_id, started_at, max_score) values
  ('f0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', pg_temp.old(), 1),
  ('f0000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000005',
   '20000000-0000-4000-8000-000000000001', pg_temp.recent(), 1),
  ('f0000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000007',
   '20000000-0000-4000-8000-000000000001', pg_temp.recent(), 1),
  ('f0000000-0000-4000-8000-000000000008', 'a2000000-0000-4000-8000-000000000008',
   '20000000-0000-4000-8000-000000000001', pg_temp.old(), 1),
  ('f0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', pg_temp.old(), 1);

insert into public.attempt_answers
  (attempt_id, question_id, selected_answer_ids, is_correct, points, answered_at) values
  ('f0000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
   '{40000000-0000-4000-8000-000000000001}', true, 1, pg_temp.old()),
  ('f0000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001',
   '{40000000-0000-4000-8000-000000000001}', true, 1, pg_temp.recent()),
  ('f0000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000001',
   '{40000000-0000-4000-8000-000000000001}', true, 1, pg_temp.recent()),
  ('f0000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-000000000001',
   '{40000000-0000-4000-8000-000000000001}', true, 1, pg_temp.old());

-- Sanity: the fixtures are in place before the cleanup runs.
select results_eq(
  $$ select count(*)::int from public.profiles
     where id in ('a1000000-0000-4000-8000-000000000001',
                  'a1000000-0000-4000-8000-000000000003') $$,
  $$ values (2) $$,
  'before the cleanup the stale users have profiles'
);

-- Run the cleanup as the owner, as the pg_cron job does --------------------

select results_eq(
  $$ select private.delete_stale_anonymous_users() $$,
  $$ values (2) $$,
  'the cleanup returns the number of users it deleted: the two stale anonymous users'
);

-- Deleted -------------------------------------------------------------------

select is_empty(
  $$ select 1 from auth.users where id = 'a1000000-0000-4000-8000-000000000001' $$,
  'an anonymous user whose last sign-in is one second past the cutoff is deleted'
);

select is_empty(
  $$ select 1 from auth.users where id = 'a1000000-0000-4000-8000-000000000003' $$,
  'an anonymous user who never signed in and was created one second past the cutoff is deleted'
);

select results_eq(
  $$ select count(*)::int from public.profiles
     where id in ('a1000000-0000-4000-8000-000000000001',
                  'a1000000-0000-4000-8000-000000000003') $$,
  $$ values (0) $$,
  'the stale users'' profiles are gone'
);

select results_eq(
  $$ select count(*)::int from public.attempts
     where user_id = 'a1000000-0000-4000-8000-000000000001' $$,
  $$ values (0) $$,
  'the stale user''s attempts are gone'
);

select results_eq(
  $$ select count(*)::int from public.attempt_answers
     where attempt_id = 'f0000000-0000-4000-8000-000000000001' $$,
  $$ values (0) $$,
  'the stale user''s attempt answers are gone'
);

select results_eq(
  $$ select count(*)::int from auth.sessions
     where user_id = 'a1000000-0000-4000-8000-000000000001' $$,
  $$ values (0) $$,
  'the stale user''s sessions are gone'
);

-- Kept: anonymous users with activity at or after the cutoff ----------------

select isnt_empty(
  $$ select 1 from auth.users where id = 'a2000000-0000-4000-8000-000000000002' $$,
  'an anonymous user whose last sign-in is exactly at the cutoff stays'
);

select isnt_empty(
  $$ select 1 from auth.users where id = 'a2000000-0000-4000-8000-000000000004' $$,
  'an anonymous user who never signed in but was created recently stays'
);

select isnt_empty(
  $$ select 1 from auth.users where id = 'a2000000-0000-4000-8000-000000000005' $$,
  'a recently active anonymous user stays'
);

select isnt_empty(
  $$ select 1 from auth.users where id = 'a2000000-0000-4000-8000-000000000006' $$,
  'an anonymous user with an old sign-in but a recently refreshed session stays'
);

select isnt_empty(
  $$ select 1 from auth.users where id = 'a2000000-0000-4000-8000-000000000007' $$,
  'an anonymous user with an old sign-in but a recently started attempt stays'
);

select isnt_empty(
  $$ select 1 from auth.users where id = 'a2000000-0000-4000-8000-000000000008' $$,
  'an anonymous user with an old sign-in and attempt but a recent answer stays'
);

select results_eq(
  $$ select count(*)::int from public.profiles where id = 'a2000000-0000-4000-8000-000000000005' $$,
  $$ values (1) $$,
  'the recent anonymous user keeps their profile'
);

select results_eq(
  $$ select count(*)::int from public.attempts
     where user_id = 'a2000000-0000-4000-8000-000000000005' $$,
  $$ values (1) $$,
  'the recent anonymous user keeps their attempt'
);

select results_eq(
  $$ select count(*)::int from public.attempt_answers
     where attempt_id = 'f0000000-0000-4000-8000-000000000005' $$,
  $$ values (1) $$,
  'the recent anonymous user keeps their attempt answer'
);

select results_eq(
  $$ select count(*)::int from auth.sessions
     where user_id = 'a2000000-0000-4000-8000-000000000006' $$,
  $$ values (1) $$,
  'the recently refreshed user keeps their session'
);

select results_eq(
  $$ select count(*)::int from public.attempt_answers
     where attempt_id = 'f0000000-0000-4000-8000-000000000008' $$,
  $$ values (1) $$,
  'the user with a recent answer keeps it'
);

-- Kept: users that are not anonymous, despite stale timestamps --------------

select isnt_empty(
  $$ select 1 from auth.users where id = 'b0000000-0000-4000-8000-000000000001' $$,
  'a linked user (anonymous before, is_anonymous now false) with stale timestamps stays'
);

select isnt_empty(
  $$ select 1 from auth.identities where user_id = 'b0000000-0000-4000-8000-000000000001' $$,
  'the linked user keeps their identity'
);

select results_eq(
  $$ select count(*)::int from public.profiles where id = 'b0000000-0000-4000-8000-000000000001' $$,
  $$ values (1) $$,
  'the linked user keeps their profile'
);

select results_eq(
  $$ select count(*)::int from public.attempts
     where user_id = 'b0000000-0000-4000-8000-000000000001' $$,
  $$ values (1) $$,
  'the linked user keeps their attempt'
);

select results_eq(
  $$ select count(*)::int from public.attempt_answers
     where attempt_id = 'f0000000-0000-4000-8000-0000000000b1' $$,
  $$ values (1) $$,
  'the linked user keeps their attempt answer'
);

select isnt_empty(
  $$ select 1 from auth.users where id = 'b0000000-0000-4000-8000-000000000002' $$,
  'a registered user with stale timestamps stays'
);

select results_eq(
  $$ select count(*)::int from public.profiles where id = 'b0000000-0000-4000-8000-000000000002' $$,
  $$ values (1) $$,
  'the registered user keeps their profile'
);

select isnt_empty(
  $$ select 1 from auth.users where id = 'b0000000-0000-4000-8000-000000000003' $$,
  'an admin with stale timestamps stays'
);

select results_eq(
  $$ select role::text from public.profiles where id = 'b0000000-0000-4000-8000-000000000003' $$,
  $$ values ('admin'::text) $$,
  'the admin keeps their admin profile'
);

select isnt_empty(
  $$ select 1 from auth.users where email = 'admin@example.com' $$,
  'seed.sql''s admin stays'
);

-- Nothing else changed ------------------------------------------------------

select results_eq(
  $$ select count(*)::int from auth.users
     where id in ('a2000000-0000-4000-8000-000000000002',
                  'a2000000-0000-4000-8000-000000000004',
                  'a2000000-0000-4000-8000-000000000005',
                  'a2000000-0000-4000-8000-000000000006',
                  'a2000000-0000-4000-8000-000000000007',
                  'a2000000-0000-4000-8000-000000000008',
                  'b0000000-0000-4000-8000-000000000001',
                  'b0000000-0000-4000-8000-000000000002',
                  'b0000000-0000-4000-8000-000000000003') $$,
  $$ values (9) $$,
  'all nine kept users are still there'
);

select results_eq(
  $$ select count(*)::int from public.attempts
     where user_id in ('a2000000-0000-4000-8000-000000000005',
                       'a2000000-0000-4000-8000-000000000007',
                       'a2000000-0000-4000-8000-000000000008',
                       'b0000000-0000-4000-8000-000000000001') $$,
  $$ values (4) $$,
  'the kept users'' attempts are all still there'
);

-- A second run finds nothing left to delete ---------------------------------

select results_eq(
  $$ select private.delete_stale_anonymous_users() $$,
  $$ values (0) $$,
  'a second run deletes nobody'
);

select results_eq(
  $$ select count(*)::int from auth.users
     where id in ('a2000000-0000-4000-8000-000000000002',
                  'a2000000-0000-4000-8000-000000000004',
                  'a2000000-0000-4000-8000-000000000005',
                  'a2000000-0000-4000-8000-000000000006',
                  'a2000000-0000-4000-8000-000000000007',
                  'a2000000-0000-4000-8000-000000000008',
                  'b0000000-0000-4000-8000-000000000001',
                  'b0000000-0000-4000-8000-000000000002',
                  'b0000000-0000-4000-8000-000000000003') $$,
  $$ values (9) $$,
  'after the second run the kept users are still all there'
);

select * from finish();
rollback;
