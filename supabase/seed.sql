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
