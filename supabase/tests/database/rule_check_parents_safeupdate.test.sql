-- The rule checks of #127 work in a session like PostgREST's (CI e2e, PR
-- #129). The API's role `authenticator` preloads pg_safeupdate, which
-- refuses a DELETE or UPDATE without a WHERE clause (21000). pgTAP's own
-- session doesn't load it, and supautils forbids loading it here, so an
-- unqualified statement in internal.lock_rule_check_parents() passed the
-- other tests and failed every admin save through the API.
--
-- So the save runs over dblink as `authenticator` (the local stack's
-- well-known password, as in rule_trigger_races), switches to
-- `authenticated` with the seed admin's claims (supabase/seed.sql), and runs
-- the deferred checks at once (set constraints all immediate) inside a
-- transaction that is rolled back: nothing is left behind.
--
-- Re-spec (#122): admin rights need an aal2 session, so the admin's JWT claims
-- carry "aal": "aal2" (password and TOTP). No assertion changed.
begin;
select plan(4);

create extension dblink;

select dblink_connect('api', format(
  'host=%s port=%s dbname=%s user=authenticator password=postgres',
  host(inet_server_addr()), inet_server_port(), current_database()));

select is(
  (select r from dblink('api', $$select current_user::text$$) as t(r text)),
  'authenticator',
  'the session logs in as the API role'
);

select throws_ok(
  $$select dblink_exec('api', 'delete from pg_temp.nothing_here')$$,
  null,
  'the API session refuses an unqualified delete'
);

select dblink_exec('api', 'begin');
select dblink_exec('api', 'set local role authenticated');
select dblink_exec('api', format(
  'set local "request.jwt.claims" = %L',
  json_build_object(
    'sub', (select id from auth.users where email = 'admin@example.com'),
    'role', 'authenticated',
    'aal', 'aal2')::text));

select lives_ok(
  $$select * from dblink('api', $q$
    select public.save_question(
      '20000000-0000-4000-8000-000000000002', null,
      'Was ist die Hauptstadt von Frankreich?', null, false,
      '[{"id": null, "text": "Paris", "is_correct": true},
        {"id": null, "text": "Lyon", "is_correct": false}]'::jsonb)
  $q$) as t(id uuid)$$,
  'an admin saves a new question in an API session'
);

select lives_ok(
  $$select dblink_exec('api', 'set constraints all immediate')$$,
  'the deferred rule checks pass in an API session'
);

select dblink_exec('api', 'rollback');
select dblink_disconnect('api');

select * from finish();
rollback;
