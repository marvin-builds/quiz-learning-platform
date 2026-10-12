-- pg_graphql reaches no solution. Supabase serves /graphql/v1 through
-- graphql_public.graphql(), which builds its schema from what the calling
-- role may select, so the column grants that hide `answers.is_correct` and
-- `questions.explanation` from PostgREST must hide them here too: as a field,
-- nested under another collection, in a filter or in an ordering. Plain
-- columns (`text`) are the positive control, so a broken GraphQL setup can't
-- make the rejections pass vacuously.
--
-- The local stack doesn't install pg_graphql, the hosted project may, so the
-- test installs it inside its own transaction (rolled back at the end). The
-- extension must be available (Supabase's Postgres image ships it); if it
-- isn't, the first assertion fails and the run stops at the install.
--
-- The project runs pg_graphql without inflection: types and fields keep their
-- SQL names (`answers`, `is_correct`). The camelCase spellings are checked as
-- well, so turning inflection on can't open the solutions under a new name.
-- The probes at the end grant the columns and show that every rejected case
-- then gets data (the camelCase ones once inflection is on too); they come
-- last because pg_graphql caches its schema per transaction.
begin;
select plan(48);

-- Fixtures: a learner and an admin; the content is seed.sql's.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.test');

update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

select ok(
  exists (select 1 from pg_available_extensions where name = 'pg_graphql'),
  'pg_graphql is available to install'
);

create extension if not exists pg_graphql;

-- The checks, shared by every role and the probe. A rejected query answers
-- with errors and no data; an accepted one with data and no errors.
create function pg_temp.rejected(result jsonb)
returns boolean
language sql
immutable
as $$
  select result ? 'errors' and jsonb_typeof(result -> 'data') is distinct from 'object'
$$;

create function pg_temp.accepted(result jsonb, collection text)
returns boolean
language sql
immutable
as $$
  select not result ? 'errors'
    and jsonb_array_length(result -> 'data' -> collection -> 'edges') > 0
$$;

grant execute on function pg_temp.rejected(jsonb) to anon, authenticated;
grant execute on function pg_temp.accepted(jsonb, text) to anon, authenticated;

-- The queries every role runs: (description, collection, query, should pass,
-- spelling). `camel` cases name a field only inflection would create.
create temporary table cases (
  n int, description text, collection text, query text, allowed boolean,
  spelling text
);

insert into cases (n, description, collection, query, allowed, spelling) values
  (1, 'reads answers.text (positive control)', 'answersCollection',
   $q$ { answersCollection { edges { node { text } } } } $q$, true, 'sql'),
  (2, 'reads questions.text (positive control)', 'questionsCollection',
   $q$ { questionsCollection { edges { node { text } } } } $q$, true, 'sql'),
  (3, 'cannot read answers.is_correct', null,
   $q$ { answersCollection { edges { node { is_correct } } } } $q$, false, 'sql'),
  (4, 'cannot read answers.isCorrect', null,
   $q$ { answersCollection { edges { node { isCorrect } } } } $q$, false, 'camel'),
  (5, 'cannot read is_correct nested under questions', null,
   $q$ { questionsCollection { edges { node { text
         answersCollection { edges { node { is_correct } } } } } } } $q$, false, 'sql'),
  (6, 'cannot read questions.explanation', null,
   $q$ { questionsCollection { edges { node { explanation } } } } $q$, false, 'sql'),
  (7, 'cannot read explanation nested under quizzes', null,
   $q$ { quizzesCollection { edges { node { title
         questionsCollection { edges { node { explanation } } } } } } } $q$, false, 'sql'),
  (8, 'cannot filter answers on is_correct', null,
   $q$ { answersCollection(filter: {is_correct: {eq: true}}) { edges { node { text } } } } $q$, false, 'sql'),
  (9, 'cannot filter answers on isCorrect', null,
   $q$ { answersCollection(filter: {isCorrect: {eq: true}}) { edges { node { text } } } } $q$, false, 'camel'),
  (10, 'cannot order answers by is_correct', null,
   $q$ { answersCollection(orderBy: [{is_correct: DescNullsLast}]) { edges { node { text } } } } $q$, false, 'sql'),
  (11, 'cannot filter questions on explanation', null,
   $q$ { questionsCollection(filter: {explanation: {is: NOT_NULL}}) { edges { node { text } } } } $q$, false, 'sql');

grant select on cases to anon, authenticated;

-- One assertion per case.
create function pg_temp.check_cases(role_label text)
returns setof text
language sql
as $$
  select ok(
    case
      when c.allowed then pg_temp.accepted(graphql_public.graphql(query => c.query), c.collection)
      else pg_temp.rejected(graphql_public.graphql(query => c.query))
    end,
    role_label || ' ' || c.description || ' through GraphQL'
  )
  from pg_temp.cases c
  order by c.n
$$;

-- The probe: every rejected case of one spelling gets data once granted.
create function pg_temp.probe_cases(spelling text)
returns setof text
language sql
as $$
  select ok(
    not pg_temp.rejected(graphql_public.graphql(query => c.query)),
    'the check reports the case "' || c.description || '" once anon is granted the column'
  )
  from pg_temp.cases c
  where not c.allowed and c.spelling = probe_cases.spelling
  order by c.n
$$;

grant execute on function pg_temp.check_cases(text) to anon, authenticated;

-- Whether pg_graphql answered that the Query type has no such field, so a
-- test can tell an absent field from one that exists and refuses. The
-- project's pg_graphql serves no introspection, so the error message is the
-- only way to ask.
create function pg_temp.unknown_field(result jsonb, field text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    result -> 'errors' -> 0 ->> 'message' = format('Unknown field "%s" on type Query', field),
    false)
$$;

grant execute on function pg_temp.unknown_field(jsonb, text) to anon, authenticated;
grant execute on function pg_temp.probe_cases(text) to anon;

-- anon --------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select * from pg_temp.check_cases('anon');

reset role;

-- learner -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);

select * from pg_temp.check_cases('a learner');

-- The admin's read of the explanation (#81) is a public function that
-- authenticated may execute, and pg_graphql exposes such functions as query
-- fields: a learner must get no data through it, under either spelling.
-- Seed question "Frankreich" has an explanation.
select ok(
  pg_temp.rejected(graphql_public.graphql(query => $q$
    { admin_question(question_id: "30000000-0000-4000-8000-000000000001") { explanation } } $q$)),
  'a learner cannot read an explanation through admin_question in GraphQL'
);

select ok(
  pg_temp.rejected(graphql_public.graphql(query => $q$
    { adminQuestion(questionId: "30000000-0000-4000-8000-000000000001") { explanation } } $q$)),
  'a learner cannot read an explanation through adminQuestion in GraphQL'
);

select ok(
  graphql_public.graphql(query => $q$
    { admin_question(question_id: "30000000-0000-4000-8000-000000000001") { id text explanation } } $q$)::text
    not like '%Paris ist seit dem Mittelalter%',
  'no GraphQL answer to a learner carries the explanation admin_question would return'
);

-- The rejections above would also pass for an unknown field, so this pins
-- that the field is absent, under either spelling (returns table(...) is a
-- shape pg_graphql doesn't expose); the probe at the end shows that a public
-- function the role may execute is not an unknown field.
select ok(
  pg_temp.unknown_field(graphql_public.graphql(query => $q$
    { admin_question(question_id: "30000000-0000-4000-8000-000000000001") { explanation } } $q$),
    'admin_question')
  and pg_temp.unknown_field(graphql_public.graphql(query => $q$
    { adminQuestion(questionId: "30000000-0000-4000-8000-000000000001") { explanation } } $q$),
    'adminQuestion'),
  'GraphQL has no admin_question field for a learner, under either spelling'
);

reset role;

-- admin (in phase 1 like a learner) ---------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}', true);

select * from pg_temp.check_cases('an admin');

reset role;

-- Probe: granted solutions are reported -----------------------------------
-- Last on purpose: pg_graphql keeps the schema it built from these grants.

grant select (is_correct) on public.answers to anon;
grant select (explanation) on public.questions to anon;

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select * from pg_temp.probe_cases('sql');

reset role;

-- With inflection on, the camelCase spellings are the ones that leak.
comment on schema public is '@graphql({"inflect_names": true})';

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select * from pg_temp.probe_cases('camel');

reset role;

-- A public function a role may execute is a Query field pg_graphql answers,
-- not an unknown one, so the learner's admin_question check above can fail.
-- Inflection is on here, hence the camelCase name.
create function public.graphql_probe()
returns text
language sql
stable
as $$ select 'probe' $$;

grant execute on function public.graphql_probe() to anon;

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select ok(
  not pg_temp.unknown_field(graphql_public.graphql(query => '{ graphqlProbe }'), 'graphqlProbe')
  and graphql_public.graphql(query => '{ graphqlProbe }') -> 'data' ->> 'graphqlProbe' = 'probe',
  'the absent-field check reports a function GraphQL exposes to the role'
);

reset role;

select * from finish();
rollback;
