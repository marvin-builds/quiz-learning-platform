-- public.submit_answer(attempt_id, question_id, answer_ids) without a user
-- (auth.uid() is null) refuses like every other rejection: SQLSTATE P0001,
-- exactly 'not available', and nothing is recorded, even for a real attempt
-- and a real question of it. Today only authenticated may call it, so a
-- missing user means a token without `sub`; the case as the owner without
-- claims models a future grant to anon without making it. The attempt is
-- started by a learner on seed.sql's "Hauptstädte Europas"; the positive
-- control at the end shows the same call works for its owner.
-- submit_answer.test.sql has the function's other rules.
begin;
select plan(7);

-- Fixtures: a learner and their attempt ------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select set_config('test.attempt',
  public.start_attempt('20000000-0000-4000-8000-000000000001')::text, true);

reset role;

-- The call every case makes: the attempt's first question, answered Paris.
create function pg_temp.submit()
returns void
language sql
as $$
  select null from public.submit_answer(
    current_setting('test.attempt')::uuid,
    '30000000-0000-4000-8000-000000000001',
    '{40000000-0000-4000-8000-000000000001}')
$$;

grant execute on function pg_temp.submit() to authenticated;

-- authenticated, claims without any content ---------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{}', true);

select throws_ok(
  $$ select pg_temp.submit() $$,
  'P0001', 'not available',
  'without claims submit_answer refuses with P0001 not available'
);

reset role;

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = current_setting('test.attempt')::uuid $$,
  'without claims nothing is recorded'
);

-- authenticated, claims without sub -----------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);

select throws_ok(
  $$ select pg_temp.submit() $$,
  'P0001', 'not available',
  'with claims but no sub submit_answer refuses with P0001 not available'
);

reset role;

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = current_setting('test.attempt')::uuid $$,
  'with claims but no sub nothing is recorded'
);

-- the owner without claims (stands in for a caller granted later) ----------

select set_config('request.jwt.claims', '', true);

select throws_ok(
  $$ select pg_temp.submit() $$,
  'P0001', 'not available',
  'a caller without a user gets P0001 not available'
);

select is_empty(
  $$ select 1 from public.attempt_answers
     where attempt_id = current_setting('test.attempt')::uuid $$,
  'a caller without a user records nothing'
);

-- Positive control: the attempt's owner can submit the same answer ----------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select lives_ok(
  $$ select pg_temp.submit() $$,
  'the attempt''s owner can submit the same answer, so the refusals are about the missing user'
);

reset role;

select * from finish();
rollback;
