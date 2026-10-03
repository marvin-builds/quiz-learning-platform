-- Quiz content: categories > quizzes > questions > answers.
-- Anyone (anon and authenticated) reads published content; nobody writes it
-- through the API yet (admin writes come in phase 2). The solutions,
-- answers.is_correct and questions.explanation, are left out of the column
-- grants, so no select can reach them; only a function returns them.
--
-- Names, titles and texts must hold more than whitespace; btrim trims only
-- spaces by default, so tabs and line breaks are listed explicitly.

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name, E' \t\r\n')) > 0),
  description text,
  sort_order integer not null,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories (id) on delete cascade,
  title text not null check (length(btrim(title, E' \t\r\n')) > 0),
  description text,
  sort_order integer not null,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create index quizzes_category_id_idx on public.quizzes (category_id);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  text text not null check (length(btrim(text, E' \t\r\n')) > 0),
  image_path text,
  image_alt text,
  multiple_correct boolean not null default false,
  explanation text,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  constraint questions_image_alt_required check (
    image_path is null or coalesce(length(btrim(image_alt, E' \t\r\n')) > 0, false)
  )
);

create index questions_quiz_id_idx on public.questions (quiz_id);

create table public.answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  text text not null check (length(btrim(text, E' \t\r\n')) > 0),
  image_path text,
  image_alt text,
  is_correct boolean not null default false,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  constraint answers_image_alt_required check (
    image_path is null or coalesce(length(btrim(image_alt, E' \t\r\n')) > 0, false)
  )
);

create index answers_question_id_idx on public.answers (question_id);

-- Visibility helpers ---------------------------------------------------------
-- Schema `private` is not in the API's exposed schemas (config.toml [api]).
-- It holds only functions, never tables, so it stays out of
-- rls_enabled.test.sql on purpose. The helpers run as security definer, so
-- the policies of a child table don't depend on the caller's rights on its
-- parents. New functions here are closed by the default-privileges migration
-- until granted below.

create schema private;
grant usage on schema private to anon, authenticated;

create function private.is_category_visible(category_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select c.published from public.categories c where c.id = category_id),
    false
  );
$$;

create function private.is_quiz_visible(quiz_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quizzes z
    join public.categories c on c.id = z.category_id
    where z.id = quiz_id and z.published and c.published
  );
$$;

create function private.is_question_visible(question_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.questions q
    join public.quizzes z on z.id = q.quiz_id
    join public.categories c on c.id = z.category_id
    where q.id = question_id and z.published and c.published
  );
$$;

grant execute on function private.is_category_visible(uuid) to anon, authenticated;
grant execute on function private.is_quiz_visible(uuid) to anon, authenticated;
grant execute on function private.is_question_visible(uuid) to anon, authenticated;

-- Row-level security ------------------------------------------------------

alter table public.categories enable row level security;
alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.answers enable row level security;

create policy "Published categories are visible"
  on public.categories for select
  to anon, authenticated
  using (published);

create policy "Published quizzes in published categories are visible"
  on public.quizzes for select
  to anon, authenticated
  using (published and private.is_category_visible(category_id));

create policy "Questions of visible quizzes are visible"
  on public.questions for select
  to anon, authenticated
  using (private.is_quiz_visible(quiz_id));

create policy "Answers of visible questions are visible"
  on public.answers for select
  to anon, authenticated
  using (private.is_question_visible(question_id));

-- Grants: read only, and never the solution columns -----------------------

grant select on public.categories to anon, authenticated;
grant select on public.quizzes to anon, authenticated;
grant select (id, quiz_id, text, image_path, image_alt, multiple_correct, sort_order, created_at)
  on public.questions to anon, authenticated;
grant select (id, question_id, text, image_path, image_alt, sort_order, created_at)
  on public.answers to anon, authenticated;
