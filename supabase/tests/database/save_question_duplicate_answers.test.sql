-- public.save_question refuses a payload that names the same answer id
-- twice (#82, review finding after bbc8d23). Counted per element, such a
-- payload would pass the in-call rules check (two answers, one correct)
-- although it keeps only one answer; the deferred rule triggers would refuse
-- it only at commit. The pre-check counts distinct answers instead, so the
-- call itself raises 23514 and leaves the stored rows as they were.
-- Fixtures are created here as the owner, independent of seed.sql, and
-- vanish on rollback.
begin;
select plan(3);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Entwurf', 1, false);

insert into public.questions (id, quiz_id, text, multiple_correct, sort_order) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
   'Was ist die Hauptstadt von Frankreich?', false, 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'Paris', true, 1),
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'Lyon', false, 2);

-- admin (carol) -------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select throws_ok(
  $$ select public.save_question(
       quiz_id => 'd0000000-0000-0000-0000-000000000002',
       question_id => 'e0000000-0000-0000-0000-000000000001',
       text => 'Was ist die Hauptstadt von Frankreich?', explanation => null,
       multiple_correct => false,
       answers => '[{"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": true},
                    {"id": "a0000000-0000-0000-0000-000000000001", "text": "Paris", "is_correct": false}]') $$,
  '23514', null,
  'a payload naming the same answer twice is refused in the call'
);

reset role;

select results_eq(
  $$ select id::text, text, is_correct from public.answers
     where question_id = 'e0000000-0000-0000-0000-000000000001' order by sort_order $$,
  $$ values ('a0000000-0000-0000-0000-000000000001', 'Paris', true),
            ('a0000000-0000-0000-0000-000000000002', 'Lyon', false) $$,
  'the refused save left the answers as they were'
);

select is(
  (select text from public.questions where id = 'e0000000-0000-0000-0000-000000000001'),
  'Was ist die Hauptstadt von Frankreich?',
  'the refused save left the question as it was'
);

select * from finish();
rollback;
