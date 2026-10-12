-- Bound profiles.display_name (#77): it will be shown to others (history,
-- leaderboards), so every writer is held to one rule: null, or 1 to 50
-- characters (char_length, not bytes) that aren't all whitespace and hold no
-- control characters (U+0001-U+001F, U+007F-U+009F) and no bidi controls
-- (U+202A-U+202E, U+2066-U+2069). Code points are explicit because
-- [[:space:]] and [[:cntrl:]] depend on the locale, and every one is written
-- as a \uXXXX escape, since raw they are invisible in an editor or a diff.
-- Known gap: invisible characters that aren't whitespace, such as zero-width
-- ones (U+200B-U+200D, U+2060, U+FEFF), the Hangul filler U+3164 and the
-- braille blank U+2800, are allowed, so a name made only of them looks blank.
-- ZWJ and ZWNJ are part of emoji sequences and some scripts.
--
-- The check constraint is the only place the rule is written down. The
-- signup trigger and the cleanup of existing rows below don't repeat it: they
-- try the write and fall back to null on a check violation, so they can't
-- drift from the constraint. (A shared SQL function would need EXECUTE for
-- `authenticated`, since a check constraint runs with the writer's rights,
-- and so would widen the API's function allow-list.)

alter table public.profiles
  add constraint profiles_display_name_check check (
    display_name is null
    or (
      char_length(display_name) <= 50
      and display_name ~ '[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]'
      and display_name !~ '[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]'
    )
  ) not valid;

-- Existing names that break the rule become null (no truncation: a cut name
-- could still hold control characters), then the constraint is validated.
do $$
declare
  profile_id uuid;
begin
  for profile_id in select id from public.profiles where display_name is not null loop
    begin
      update public.profiles set display_name = display_name where id = profile_id;
    exception when check_violation then
      update public.profiles set display_name = null where id = profile_id;
    end;
  end loop;
end;
$$;

alter table public.profiles validate constraint profiles_display_name_check;

-- Sign-up never fails over the client-controlled metadata: only a JSON string
-- is taken as a display name, and one the constraint rejects is stored as
-- null, for regular and anonymous users alike.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  name text;
begin
  if jsonb_typeof(new.raw_user_meta_data -> 'display_name') = 'string' then
    name := new.raw_user_meta_data ->> 'display_name';
  end if;

  begin
    insert into public.profiles (id, display_name) values (new.id, name);
  exception when check_violation then
    insert into public.profiles (id, display_name) values (new.id, null);
  end;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
