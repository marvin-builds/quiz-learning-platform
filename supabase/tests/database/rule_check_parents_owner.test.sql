-- The rule checks' record of a transaction's parents (pg_temp.rule_check_parents,
-- issue #127) belongs to the functions' owner. A table of that name the
-- session created itself, as an API role, is never trusted: neither the
-- trigger that records a parent nor the function that locks the recorded
-- parents reads it, both refuse. Otherwise the security definer lock
-- function would lock whatever rows that table lists.

begin;

select plan(2);

set local role authenticated;
create temporary table rule_check_parents (kind text, id uuid);
reset role;

select throws_ok(
  $$ select internal.lock_rule_check_parents() $$,
  'P0001',
  'pg_temp.rule_check_parents is not the rule checks'' table',
  'the lock function refuses a rule_check_parents table it does not own'
);

select throws_ok(
  $$ update public.questions set multiple_correct = multiple_correct
     where id = (select id from public.questions limit 1) $$,
  'P0001',
  'pg_temp.rule_check_parents is not the rule checks'' table',
  'the record trigger refuses a rule_check_parents table it does not own'
);

select * from finish();

rollback;
