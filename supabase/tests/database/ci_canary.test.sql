-- Deliberately failing: proves CI goes red. Reverted right after.
begin;
select plan(1);
select ok(false, 'fails on purpose');
select * from finish();
rollback;
