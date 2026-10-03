-- supabase/seed.sql, as loaded by `supabase db reset`: every question can be
-- answered correctly, and the seed holds the shapes the app and its tests need
-- (visible content, an empty category and each kind of hidden content). Read
-- as the owner, so RLS doesn't filter anything. The shape checks also keep
-- the integrity checks from passing vacuously on an empty database.
begin;
select plan(13);

-- Integrity ---------------------------------------------------------------

select ok(
  (select count(*) from public.questions) > 0,
  'the seed contains questions'
);

select is_empty(
  $$ select q.id
     from public.questions q
     where not exists (
       select 1 from public.answers a where a.question_id = q.id and a.is_correct
     ) $$,
  'every seeded question has at least one correct answer'
);

select is_empty(
  $$ select q.id
     from public.questions q
     where not q.multiple_correct
       and (select count(*) from public.answers a
            where a.question_id = q.id and a.is_correct) <> 1 $$,
  'every seeded single-choice question has exactly one correct answer'
);

-- Shape -------------------------------------------------------------------

select ok(
  (select count(*)
   from public.categories c
   where c.published
     and exists (select 1 from public.quizzes z
                 where z.category_id = c.id and z.published)) >= 2,
  'the seed has at least 2 published categories with published quizzes'
);

select ok(
  exists (
    select 1
    from public.categories c
    where c.published
      and not exists (select 1 from public.quizzes z where z.category_id = c.id)
  ),
  'the seed has an empty published category'
);

select ok(
  exists (
    select 1
    from public.categories c
    join public.quizzes z on z.category_id = c.id
    where not c.published and z.published
  ),
  'the seed has an unpublished category holding a published quiz'
);

select ok(
  exists (
    select 1
    from public.categories c
    join public.quizzes z on z.category_id = c.id
    where c.published and not z.published
  ),
  'the seed has an unpublished quiz in a published category'
);

select ok(
  exists (select 1 from public.questions where not multiple_correct and explanation is not null),
  'the seed has a single-choice question with an explanation'
);

select ok(
  exists (select 1 from public.questions where not multiple_correct and explanation is null),
  'the seed has a single-choice question without an explanation'
);

select ok(
  exists (select 1 from public.questions where multiple_correct and explanation is not null),
  'the seed has a multiple-choice question with an explanation'
);

select ok(
  exists (select 1 from public.questions where multiple_correct and explanation is null),
  'the seed has a multiple-choice question without an explanation'
);

select ok(
  exists (
    select 1
    from public.questions q
    where q.multiple_correct
      and (select count(*) from public.answers a
           where a.question_id = q.id and a.is_correct) = 3
  ),
  'the seed has a multiple-choice question with 3 correct answers'
);

select ok(
  exists (
    select 1
    from public.questions q
    join public.quizzes z on z.id = q.quiz_id
    join public.categories c on c.id = z.category_id
    where z.published and c.published
  ),
  'the seed has questions in a visible quiz'
);

select * from finish();
rollback;
