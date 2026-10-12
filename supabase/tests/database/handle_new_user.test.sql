-- The signup trigger public.handle_new_user() copies display_name from the
-- client-controlled raw_user_meta_data into public.profiles. Sign-up must
-- never fail because of that value: a name the profiles check constraint
-- would reject (over 50 characters, blank, control or bidi characters) or a
-- value that isn't a JSON string is stored as null instead, for regular and
-- anonymous users alike. Only JSON strings count as a display name: a number
-- or an object is never turned into text. The user and its profile always
-- exist afterwards. The function stays security definer, since Supabase Auth
-- runs the trigger as a role that can't write profiles itself.
-- (Null rather than truncation: a cut name could still hold control
-- characters or end mid-way.) Access rules for profiles live in
-- profiles.test.sql; the function's privileges in function_privileges.test.sql.
begin;
select plan(15);

-- Fixtures: one auth user per metadata value, inserted as Supabase Auth does.
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'max@example.test',
   jsonb_build_object('display_name', repeat('m', 50)));
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000002', 'long@example.test',
   jsonb_build_object('display_name', repeat('l', 51)));
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000003', 'newline@example.test',
   jsonb_build_object('display_name', E'New\nline'));
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000004', 'nel@example.test',
   jsonb_build_object('display_name', 'Ne' || chr(133) || 'l'));
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000005', 'bidi@example.test',
   jsonb_build_object('display_name', 'Bi' || chr(8238) || 'di'));
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000006', 'empty@example.test',
   '{"display_name": ""}');
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000007', 'blank@example.test',
   '{"display_name": "   "}');
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000008', 'object@example.test',
   jsonb_build_object('display_name',
     jsonb_build_object('padding', repeat('o', 200))));
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000009', 'small-object@example.test',
   '{"display_name": {"x": 1}}');
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-00000000000a', 'number@example.test',
   '{"display_name": 42}');

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-00000000000b', 'nbsp@example.test',
   jsonb_build_object('display_name', repeat(chr(160), 3)));

-- Anonymous sign-in can carry metadata too (signInAnonymously options.data).
insert into auth.users (id, is_anonymous, raw_user_meta_data) values
  ('b0000000-0000-0000-0000-000000000001', true,
   jsonb_build_object('display_name', repeat('l', 51)));
insert into auth.users (id, is_anonymous, raw_user_meta_data) values
  ('b0000000-0000-0000-0000-000000000002', true,
   jsonb_build_object('display_name', E'New\nline'));
insert into auth.users (id, is_anonymous, raw_user_meta_data) values
  ('b0000000-0000-0000-0000-000000000003', true,
   '{"display_name": "   "}');

-- Structure (catalog) -------------------------------------------------------

select ok(
  coalesce((
    select p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))
    from pg_proc p
    where p.oid = to_regprocedure('public.handle_new_user()')
  ), false),
  'handle_new_user is security definer with an empty search_path'
);

-- Each check joins auth.users with public.profiles, so it fails unless both
-- the user and its profile exist.

-- Regular users -------------------------------------------------------------

select results_eq(
  $$ select char_length(p.display_name) from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000001' $$,
  $$ values (50) $$,
  'sign-up keeps a display name of exactly 50 characters'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000002' $$,
  $$ values (null::text) $$,
  'sign-up with a 51-character name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000003' $$,
  $$ values (null::text) $$,
  'sign-up with a newline in the name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000004' $$,
  $$ values (null::text) $$,
  'sign-up with a C1 control (U+0085) in the name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000005' $$,
  $$ values (null::text) $$,
  'sign-up with a bidi override (U+202E) in the name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000006' $$,
  $$ values (null::text) $$,
  'sign-up with an empty name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000007' $$,
  $$ values (null::text) $$,
  'sign-up with a whitespace-only name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-00000000000b' $$,
  $$ values (null::text) $$,
  'sign-up with a name of only no-break spaces creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000008' $$,
  $$ values (null::text) $$,
  'sign-up with a large JSON object as the name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-000000000009' $$,
  $$ values (null::text) $$,
  'sign-up with a small JSON object as the name creates the user with no display name'
);

select results_eq(
  $$ select p.display_name from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'a0000000-0000-0000-0000-00000000000a' $$,
  $$ values (null::text) $$,
  'sign-up with a JSON number as the name creates the user with no display name'
);

-- Anonymous users -----------------------------------------------------------

select results_eq(
  $$ select p.display_name, p.role::text from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'b0000000-0000-0000-0000-000000000001' $$,
  $$ values (null::text, 'learner'::text) $$,
  'anonymous sign-in with a 51-character name creates a learner with no display name'
);

select results_eq(
  $$ select p.display_name, p.role::text from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'b0000000-0000-0000-0000-000000000002' $$,
  $$ values (null::text, 'learner'::text) $$,
  'anonymous sign-in with a newline in the name creates a learner with no display name'
);

select results_eq(
  $$ select p.display_name, p.role::text from auth.users u
     join public.profiles p on p.id = u.id
     where u.id = 'b0000000-0000-0000-0000-000000000003' $$,
  $$ values (null::text, 'learner'::text) $$,
  'anonymous sign-in with a whitespace-only name creates a learner with no display name'
);

select * from finish();
rollback;
