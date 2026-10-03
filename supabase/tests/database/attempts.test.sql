-- public.attempts: structure, constraints, cascades and access per role (anon,
-- anonymous user, learner, admin). Attempts are created only by
-- start_attempt() and filled only by submit_answer(); no API role may write
-- them directly. A signed-in user, anonymous or not, reads their own attempts
-- and nobody else's. Fixtures are created here as the owner, independent of
-- seed.sql, and vanish on rollback. In phase 1 an admin is treated like a
-- learner; phase 2 changes the admin tests on purpose.
begin;
select plan(52);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'dave@example.test');

insert into auth.users (id, is_anonymous) values
  ('44444444-4444-4444-4444-444444444444', true);

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

insert into public.categories (id, name, sort_order, published) values
  ('c0000000-0000-0000-0000-000000000001', 'Sichtbares Thema', 1, true);

insert into public.quizzes (id, category_id, title, sort_order, published) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Veröffentlichtes Quiz', 1, true),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Quiz, das gelöscht wird', 2, true);

insert into public.attempts (id, user_id, quiz_id, score, max_score) values
  ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'd0000000-0000-0000-0000-000000000001', 1.5, 2),
  ('f0000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'd0000000-0000-0000-0000-000000000001', 2, 2),
  ('f0000000-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333',
   'd0000000-0000-0000-0000-000000000001', 0, 2),
  ('f0000000-0000-0000-0000-000000000004', '44444444-4444-4444-4444-444444444444',
   'd0000000-0000-0000-0000-000000000001', 0.5, 2);

-- Dave's attempts are only for the cascade checks.
insert into public.attempts (id, user_id, quiz_id, finished_at, score, max_score) values
  ('f0000000-0000-0000-0000-000000000005', '55555555-5555-5555-5555-555555555555',
   'd0000000-0000-0000-0000-000000000002', now(), 1.25, 3),
  ('f0000000-0000-0000-0000-000000000006', '55555555-5555-5555-5555-555555555555',
   'd0000000-0000-0000-0000-000000000001', null, 0, 2);

-- Structure ---------------------------------------------------------------

select has_table('public', 'attempts', 'attempts table exists');

select columns_are('public', 'attempts',
  array['id', 'user_id', 'quiz_id', 'started_at', 'finished_at', 'score', 'max_score'],
  'attempts has exactly the planned columns');

select col_is_pk('public', 'attempts', 'id', 'attempts.id is the primary key');
select col_type_is('public', 'attempts', 'id', 'uuid', 'attempts.id is a uuid');
select col_has_default('public', 'attempts', 'id', 'attempts.id has a default');

select col_type_is('public', 'attempts', 'user_id', 'uuid', 'attempts.user_id is a uuid');
select col_not_null('public', 'attempts', 'user_id', 'attempts.user_id is required');
select fk_ok('public', 'attempts', 'user_id', 'auth', 'users', 'id',
  'attempts.user_id references auth.users.id');

select col_type_is('public', 'attempts', 'quiz_id', 'uuid', 'attempts.quiz_id is a uuid');
select col_is_null('public', 'attempts', 'quiz_id',
  'attempts.quiz_id is nullable, so deleting the quiz can set it to null');
select fk_ok('public', 'attempts', 'quiz_id', 'public', 'quizzes', 'id',
  'attempts.quiz_id references quizzes.id');

select col_type_is('public', 'attempts', 'started_at', 'timestamp with time zone',
  'attempts.started_at is a timestamptz');
select col_not_null('public', 'attempts', 'started_at', 'attempts.started_at is required');

select col_type_is('public', 'attempts', 'finished_at', 'timestamp with time zone',
  'attempts.finished_at is a timestamptz');
select col_is_null('public', 'attempts', 'finished_at',
  'attempts.finished_at is empty until the attempt is finished');

select col_type_is('public', 'attempts', 'score', 'numeric(6,2)',
  'attempts.score is a numeric(6,2)');
select col_not_null('public', 'attempts', 'score', 'attempts.score is required');

select col_type_is('public', 'attempts', 'max_score', 'integer',
  'attempts.max_score is an integer');
select col_not_null('public', 'attempts', 'max_score', 'attempts.max_score is required');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.attempts'::regclass
      and a.attname = 'user_id'
  ),
  'an index leads with attempts.user_id'
);

select ok(
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.attempts'::regclass
      and a.attname = 'quiz_id'
  ),
  'an index leads with attempts.quiz_id'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.attempts'::regclass),
  'attempts has row-level security enabled'
);

-- Constraints and defaults (as the owner) ---------------------------------

insert into public.attempts (user_id, quiz_id, max_score)
values ('55555555-5555-5555-5555-555555555555', 'd0000000-0000-0000-0000-000000000001', 7);

select results_eq(
  $$ select id is not null, started_at = now(), finished_at is null, score = 0
     from public.attempts where max_score = 7 $$,
  $$ values (true, true, true, true) $$,
  'a new attempt gets an id, started_at = now(), no finished_at and score 0 by default'
);

select throws_ok(
  $$ insert into public.attempts (user_id, quiz_id)
     values ('55555555-5555-5555-5555-555555555555', 'd0000000-0000-0000-0000-000000000001') $$,
  '23502', null,
  'an attempt without max_score is rejected'
);

select throws_ok(
  $$ insert into public.attempts (quiz_id, max_score)
     values ('d0000000-0000-0000-0000-000000000001', 1) $$,
  '23502', null,
  'an attempt without a user is rejected'
);

select throws_ok(
  $$ insert into public.attempts (user_id, quiz_id, max_score)
     values ('99999999-9999-9999-9999-999999999999', 'd0000000-0000-0000-0000-000000000001', 1) $$,
  '23503', null,
  'an attempt of a user that does not exist is rejected'
);

select throws_ok(
  $$ insert into public.attempts (user_id, quiz_id, max_score)
     values ('55555555-5555-5555-5555-555555555555', 'd0000000-0000-0000-0000-0000000000ff', 1) $$,
  '23503', null,
  'an attempt on a quiz that does not exist is rejected'
);

-- Cascades (as the owner) -------------------------------------------------

delete from public.quizzes where id = 'd0000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select quiz_id, finished_at is not null, score, max_score from public.attempts
     where id = 'f0000000-0000-0000-0000-000000000005' $$,
  $$ values (null::uuid, true, 1.25::numeric, 3) $$,
  'deleting a quiz keeps its attempts with their score and sets quiz_id to null'
);

delete from auth.users where id = '55555555-5555-5555-5555-555555555555';

select is_empty(
  $$ select 1 from public.attempts where user_id = '55555555-5555-5555-5555-555555555555' $$,
  'deleting the auth user deletes their attempts'
);

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select * from public.attempts $$,
  '42501', null,
  'anon cannot read attempts'
);

select throws_ok(
  $$ insert into public.attempts (user_id, quiz_id, max_score)
     values ('11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001', 2) $$,
  '42501', null,
  'anon cannot insert an attempt'
);

select throws_ok(
  $$ update public.attempts set score = 2
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot update an attempt'
);

select throws_ok(
  $$ delete from public.attempts where id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'anon cannot delete an attempt'
);

reset role;

-- anonymous user (guest) --------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-4444-444444444444", "role": "authenticated", "is_anonymous": true}',
  true);

select results_eq(
  $$ select id, user_id, quiz_id, score, max_score from public.attempts $$,
  $$ values ('f0000000-0000-0000-0000-000000000004'::uuid,
             '44444444-4444-4444-4444-444444444444'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid, 0.5::numeric, 2) $$,
  'an anonymous user reads their own attempts and no others'
);

select is_empty(
  $$ select 1 from public.attempts where id = 'f0000000-0000-0000-0000-000000000001' $$,
  'an anonymous user cannot read a learner''s attempt'
);

select throws_ok(
  $$ insert into public.attempts (user_id, quiz_id, max_score)
     values ('44444444-4444-4444-4444-444444444444', 'd0000000-0000-0000-0000-000000000001', 2) $$,
  '42501', null,
  'an anonymous user cannot insert an attempt directly'
);

select throws_ok(
  $$ update public.attempts set score = 2
     where id = 'f0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an anonymous user cannot update their own attempt'
);

select throws_ok(
  $$ delete from public.attempts where id = 'f0000000-0000-0000-0000-000000000004' $$,
  '42501', null,
  'an anonymous user cannot delete their own attempt'
);

reset role;

-- learner (alice) ---------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select results_eq(
  $$ select id, user_id, quiz_id, score, max_score from public.attempts $$,
  $$ values ('f0000000-0000-0000-0000-000000000001'::uuid,
             '11111111-1111-1111-1111-111111111111'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid, 1.5::numeric, 2) $$,
  'a learner reads their own attempts and no others'
);

select is_empty(
  $$ select 1 from public.attempts where id = 'f0000000-0000-0000-0000-000000000002' $$,
  'a learner cannot read another learner''s attempt'
);

select is_empty(
  $$ select 1 from public.attempts where id = 'f0000000-0000-0000-0000-000000000004' $$,
  'a learner cannot read an anonymous user''s attempt'
);

select throws_ok(
  $$ insert into public.attempts (user_id, quiz_id, max_score)
     values ('11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001', 2) $$,
  '42501', null,
  'a learner cannot insert an attempt directly'
);

select throws_ok(
  $$ update public.attempts set score = 2
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot update their own attempt'
);

select throws_ok(
  $$ update public.attempts set score = 0
     where id = 'f0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'a learner cannot update another learner''s attempt'
);

select throws_ok(
  $$ delete from public.attempts where id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'a learner cannot delete their own attempt'
);

reset role;

-- admin (carol), treated like a learner in phase 1 ------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select results_eq(
  $$ select id, user_id, quiz_id, score, max_score from public.attempts $$,
  $$ values ('f0000000-0000-0000-0000-000000000003'::uuid,
             '33333333-3333-3333-3333-333333333333'::uuid,
             'd0000000-0000-0000-0000-000000000001'::uuid, 0::numeric, 2) $$,
  'an admin reads their own attempts and no others in phase 1'
);

select is_empty(
  $$ select 1 from public.attempts where id = 'f0000000-0000-0000-0000-000000000001' $$,
  'an admin cannot read a learner''s attempt in phase 1'
);

select throws_ok(
  $$ insert into public.attempts (user_id, quiz_id, max_score)
     values ('33333333-3333-3333-3333-333333333333', 'd0000000-0000-0000-0000-000000000001', 2) $$,
  '42501', null,
  'an admin cannot insert an attempt directly in phase 1'
);

select throws_ok(
  $$ update public.attempts set score = 2
     where id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot update an attempt in phase 1'
);

select throws_ok(
  $$ delete from public.attempts where id = 'f0000000-0000-0000-0000-000000000001' $$,
  '42501', null,
  'an admin cannot delete an attempt in phase 1'
);

reset role;

-- Effects, checked as the owner -------------------------------------------

select results_eq(
  $$ select id, user_id, score from public.attempts
     where id in ('f0000000-0000-0000-0000-000000000001',
                  'f0000000-0000-0000-0000-000000000002',
                  'f0000000-0000-0000-0000-000000000003',
                  'f0000000-0000-0000-0000-000000000004')
     order by id $$,
  $$ values
       ('f0000000-0000-0000-0000-000000000001'::uuid,
        '11111111-1111-1111-1111-111111111111'::uuid, 1.5::numeric),
       ('f0000000-0000-0000-0000-000000000002'::uuid,
        '22222222-2222-2222-2222-222222222222'::uuid, 2::numeric),
       ('f0000000-0000-0000-0000-000000000003'::uuid,
        '33333333-3333-3333-3333-333333333333'::uuid, 0::numeric),
       ('f0000000-0000-0000-0000-000000000004'::uuid,
        '44444444-4444-4444-4444-444444444444'::uuid, 0.5::numeric) $$,
  'the rejected writes left the attempts unchanged'
);

select results_eq(
  $$ select count(*)::int from public.attempts
     where user_id in ('11111111-1111-1111-1111-111111111111',
                       '22222222-2222-2222-2222-222222222222',
                       '33333333-3333-3333-3333-333333333333',
                       '44444444-4444-4444-4444-444444444444') $$,
  $$ values (4) $$,
  'the rejected inserts added no attempts'
);

select * from finish();
rollback;
