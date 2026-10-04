-- public.start_attempt(quiz_id) without a user (auth.uid() is null) refuses
-- like every other rejection: SQLSTATE P0001, exactly 'not available', no id
-- in the message or its detail, and no attempt row. Today only authenticated
-- may call it, so a missing user means a token without `sub`; the case as the
-- owner without claims models a future grant to anon (or another caller with
-- no user) without making that grant. Relying on the not-null constraint of
-- attempts.user_id instead would answer 23502 and echo the failing row,
-- quiz id included. The quiz is seed.sql's "Hauptstädte Europas", visible and
-- playable, which the positive control at the end proves. start_attempt.test.sql
-- has the function's other rules.
begin;
select plan(10);

-- Fixtures: a learner for the positive control.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test');

-- The full text of the error start_attempt raises for the current caller:
-- SQLSTATE, message, detail and hint, so a test can look for an echoed id.
create function pg_temp.start_attempt_error(quiz_id uuid)
returns text
language plpgsql
as $$
declare
  state text;
  message text;
  detail text;
  hint text;
begin
  perform public.start_attempt(quiz_id);
  return null;
exception when others then
  get stacked diagnostics
    state = returned_sqlstate, message = message_text,
    detail = pg_exception_detail, hint = pg_exception_hint;
  return concat_ws(' | ', state, message, detail, hint);
end;
$$;

grant execute on function pg_temp.start_attempt_error(uuid) to authenticated;

select set_config('test.attempts_before', (select count(*) from public.attempts)::text, true);

-- authenticated, claims without any content ---------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{}', true);

select throws_ok(
  $$ select public.start_attempt('20000000-0000-4000-8000-000000000001') $$,
  'P0001', 'not available',
  'without claims start_attempt refuses with P0001 not available'
);

select unalike(
  coalesce(pg_temp.start_attempt_error('20000000-0000-4000-8000-000000000001'), ''),
  '%20000000-0000-4000-8000-000000000001%',
  'without claims the error does not echo the quiz id'
);

reset role;

select is(
  (select count(*) from public.attempts)::text,
  current_setting('test.attempts_before'),
  'without claims no attempt is created'
);

-- authenticated, claims without sub -----------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select throws_ok(
  $$ select public.start_attempt('20000000-0000-4000-8000-000000000001') $$,
  'P0001', 'not available',
  'with claims but no sub start_attempt refuses with P0001 not available'
);

select unalike(
  coalesce(pg_temp.start_attempt_error('20000000-0000-4000-8000-000000000001'), ''),
  '%20000000-0000-4000-8000-000000000001%',
  'with claims but no sub the error does not echo the quiz id'
);

reset role;

select is(
  (select count(*) from public.attempts)::text,
  current_setting('test.attempts_before'),
  'with claims but no sub no attempt is created'
);

-- the owner without claims (stands in for a caller granted later) ----------

select set_config('request.jwt.claims', '', true);

select throws_ok(
  $$ select public.start_attempt('20000000-0000-4000-8000-000000000001') $$,
  'P0001', 'not available',
  'a caller without a user gets P0001 not available'
);

select unalike(
  coalesce(pg_temp.start_attempt_error('20000000-0000-4000-8000-000000000001'), ''),
  '%20000000-0000-4000-8000-000000000001%',
  'a caller without a user gets no quiz id in the error'
);

select is(
  (select count(*) from public.attempts)::text,
  current_setting('test.attempts_before'),
  'a caller without a user creates no attempt'
);

-- Positive control: with a user, the same quiz starts ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select lives_ok(
  $$ select public.start_attempt('20000000-0000-4000-8000-000000000001') $$,
  'a learner can start the same quiz, so the refusals are about the missing user'
);

reset role;

select * from finish();
rollback;
