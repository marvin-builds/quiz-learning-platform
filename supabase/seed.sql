-- Local development and test content (German), loaded by `supabase db reset`.
-- Never reaches the hosted database. Fixed UUIDs keep links and tests stable:
-- 1… categories, 2… quizzes, 3… questions, 4… answers.

insert into public.categories (id, name, description, sort_order, published) values
  ('10000000-0000-4000-8000-000000000001', 'Geografie',
   'Länder, Städte und Flüsse', 1, true),
  ('10000000-0000-4000-8000-000000000002', 'Naturwissenschaften',
   'Chemie, Physik und Biologie', 2, true),
  -- published, but no quizzes yet
  ('10000000-0000-4000-8000-000000000003', 'Geschichte',
   'Von der Antike bis heute', 3, true),
  -- unpublished, although its quiz is published
  ('10000000-0000-4000-8000-000000000004', 'Musik',
   'Komponisten und Instrumente', 4, false);

insert into public.quizzes (id, category_id, title, description, sort_order, published) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Hauptstädte Europas', 'Kennst du die Hauptstädte unserer Nachbarn?', 1, true),
  -- unpublished draft in a published category
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'Flüsse in Deutschland', 'Noch in Arbeit', 2, false),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002',
   'Chemie-Grundlagen', 'Elemente und ihre Eigenschaften', 1, true),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
   'Komponisten', 'Wer hat was geschrieben?', 1, true);

insert into public.questions (id, quiz_id, text, multiple_correct, explanation, sort_order) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Was ist die Hauptstadt von Frankreich?', false,
   'Paris ist seit dem Mittelalter die Hauptstadt Frankreichs.', 1),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
   'Was ist die Hauptstadt von Italien?', false, null, 2),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001',
   'Welche dieser Hauptstädte liegen an der Donau?', true,
   'Wien, Bratislava und Budapest liegen an der Donau, Prag an der Moldau.', 3),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000003',
   'Welche dieser Elemente sind Edelgase?', true, null, 1),
  ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000003',
   'Welches chemische Symbol hat Gold?', false,
   'Au kommt vom lateinischen Wort „aurum“.', 2),
  ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000002',
   'Welcher Fluss hat die längste Strecke in Deutschland?', false, null, 1),
  ('30000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000004',
   'Wer komponierte „Die Zauberflöte“?', false, null, 1);

insert into public.answers (id, question_id, text, is_correct, sort_order) values
  -- Frankreich
  ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Paris', true, 1),
  ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'Lyon', false, 2),
  ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 'Marseille', false, 3),
  -- Italien
  ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000002', 'Mailand', false, 1),
  ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000002', 'Rom', true, 2),
  ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000002', 'Neapel', false, 3),
  -- Donau: three correct answers
  ('40000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000003', 'Wien', true, 1),
  ('40000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000003', 'Prag', false, 2),
  ('40000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000003', 'Bratislava', true, 3),
  ('40000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000003', 'Budapest', true, 4),
  -- Edelgase
  ('40000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000004', 'Helium', true, 1),
  ('40000000-0000-4000-8000-000000000012', '30000000-0000-4000-8000-000000000004', 'Stickstoff', false, 2),
  ('40000000-0000-4000-8000-000000000013', '30000000-0000-4000-8000-000000000004', 'Neon', true, 3),
  ('40000000-0000-4000-8000-000000000014', '30000000-0000-4000-8000-000000000004', 'Sauerstoff', false, 4),
  -- Gold
  ('40000000-0000-4000-8000-000000000015', '30000000-0000-4000-8000-000000000005', 'Ag', false, 1),
  ('40000000-0000-4000-8000-000000000016', '30000000-0000-4000-8000-000000000005', 'Au', true, 2),
  ('40000000-0000-4000-8000-000000000017', '30000000-0000-4000-8000-000000000005', 'Go', false, 3),
  -- Flüsse (draft)
  ('40000000-0000-4000-8000-000000000018', '30000000-0000-4000-8000-000000000006', 'Rhein', true, 1),
  ('40000000-0000-4000-8000-000000000019', '30000000-0000-4000-8000-000000000006', 'Elbe', false, 2),
  ('40000000-0000-4000-8000-000000000020', '30000000-0000-4000-8000-000000000006', 'Main', false, 3),
  -- Komponisten (hidden category)
  ('40000000-0000-4000-8000-000000000021', '30000000-0000-4000-8000-000000000007', 'Ludwig van Beethoven', false, 1),
  ('40000000-0000-4000-8000-000000000022', '30000000-0000-4000-8000-000000000007', 'Wolfgang Amadeus Mozart', true, 2),
  ('40000000-0000-4000-8000-000000000023', '30000000-0000-4000-8000-000000000007', 'Johann Sebastian Bach', false, 3);

-- Images (supabase/seed-images/, uploaded to the quiz-images bucket by
-- `supabase start` and `db reset`). Named by random UUIDs, so a file name
-- gives nothing away. Only in Chemie-Grundlagen: the e2e specs of Hauptstädte
-- find its answers by their exact names, which an answer image would extend.
update public.questions
set image_path = '063fa988-b996-4b4e-908f-1118f445ae46.png',
    image_alt = 'Ausschnitt aus dem Periodensystem mit den Edelgasen'
where id = '30000000-0000-4000-8000-000000000004';

update public.answers
set image_path = '39c5ec8d-57d6-4ab5-8ff7-f32a80a0a25d.png',
    image_alt = 'Mit Helium gefüllter Ballon'
where id = '40000000-0000-4000-8000-000000000011';

-- Admin (e2e tests and ui-verifier): admin@example.com / admin-password.
-- GoTrue fails the sign-in on null token columns, so they are empty strings.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'admin@example.com',
  extensions.crypt('admin-password', extensions.gen_salt('bf')), now(),
  '', '', '', '',
  '{"provider": "email", "providers": ["email"]}', '{}', now(), now()
);

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (
  '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  '{"sub": "50000000-0000-4000-8000-000000000001", "email": "admin@example.com", "email_verified": true}',
  'email', now(), now(), now()
);

update public.profiles set role = 'admin' where id = '50000000-0000-4000-8000-000000000001';

-- Admin rights need an aal2 session (#122), so the seed admin has a verified
-- TOTP factor. Its secret is local-only and shared with the e2e helper
-- (e2e/admin-auth.ts), which computes the codes from it.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
values (
  '50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001',
  'Seed admin', 'totp', 'verified', 'LOCALONLYADMINTOTPSECRETDONTUSE2', now(), now()
);

-- Dedicated e2e admins (#122), local only like the seed admin: a TOTP verify
-- ends the user's other sessions below aal2, so the e2e tests that sign in
-- with password and code (or sign out) each get their own admin per spec file
-- and Playwright project (TEST_ADMINS and API_ADMIN in e2e/admin-auth.ts,
-- which holds the same secrets). Password: the local part plus `-password`.
create temporary table e2e_admin_seed (id uuid, factor_id uuid, email text, secret text);
insert into e2e_admin_seed (id, factor_id, email, secret) values
  ('51000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001',
   'admin-mfa-phone@example.com', 'LOCALONLYMFAPHONETOTPDONTUSEABCD'),
  ('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000002',
   'admin-mfa-desktop@example.com', 'LOCALONLYMFADESKTOPTOTPDONTUSEAB'),
  ('51000000-0000-4000-8000-000000000003', '52000000-0000-4000-8000-000000000003',
   'admin-sign-in-phone@example.com', 'LOCALONLYSIGNINPHONETOTPDONTUSEA'),
  ('51000000-0000-4000-8000-000000000004', '52000000-0000-4000-8000-000000000004',
   'admin-sign-in-desktop@example.com', 'LOCALONLYSIGNINDESKTOPTOTPDONTUS'),
  ('51000000-0000-4000-8000-000000000005', '52000000-0000-4000-8000-000000000005',
   'admin-nav-phone@example.com', 'LOCALONLYNAVPHONETOTPDONTUSEABCD'),
  ('51000000-0000-4000-8000-000000000006', '52000000-0000-4000-8000-000000000006',
   'admin-nav-desktop@example.com', 'LOCALONLYNAVDESKTOPTOTPDONTUSEAB'),
  ('51000000-0000-4000-8000-000000000007', '52000000-0000-4000-8000-000000000007',
   'admin-api-aal1@example.com', 'LOCALONLYAPIAALONETOTPDONTUSEABC');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', id,
  'authenticated', 'authenticated', email,
  extensions.crypt(split_part(email, '@', 1) || '-password', extensions.gen_salt('bf')), now(),
  '', '', '', '',
  '{"provider": "email", "providers": ["email"]}', '{}', now(), now()
from e2e_admin_seed;

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select
  id::text, id,
  jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
  'email', now(), now(), now()
from e2e_admin_seed;

update public.profiles set role = 'admin' where id in (select id from e2e_admin_seed);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
select factor_id, id, 'E2E admin', 'totp', 'verified', secret, now(), now()
from e2e_admin_seed;

drop table e2e_admin_seed;
