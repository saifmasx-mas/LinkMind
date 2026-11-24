-- LinkMind core tables: bookmarks and user_profiles.
-- These are the two most important tables in the app, yet no migration
-- defined them before this one. Apply with:
--   supabase db push
-- or paste this file into the Supabase dashboard SQL editor.
--
-- IMPORTANT: if you already created these tables by hand in the dashboard,
-- check that their columns match the definitions below before running this
-- migration. In particular, `bookmarks.embedding` is stored as jsonb here
-- (the app reads it back with JSON.parse); if your table uses the pgvector
-- `vector` type instead, keep that column type and skip the embedding part.

create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  title text not null default '',
  summary text not null default '',
  category text not null default 'General',
  image_url text,
  checklist jsonb not null default '[]'::jsonb,
  embedding jsonb,
  -- N12: the kind of saved item, instead of encoding it in a fake
  -- "file://pdf/..." URL. 'link' for web links, 'pdf' / 'word' for uploads.
  source_type text not null default 'link'
    check (source_type in ('link', 'pdf', 'word')),
  created_at timestamptz not null default now()
);

-- One user can save the same URL only once (I5).
create unique index if not exists bookmarks_user_id_url_uidx
  on public.bookmarks (user_id, url);

create index if not exists bookmarks_user_id_created_at_idx
  on public.bookmarks (user_id, created_at desc);

alter table public.bookmarks enable row level security;
revoke all on public.bookmarks from anon, authenticated;
grant select, insert, update, delete on public.bookmarks to authenticated;
grant all on public.bookmarks to service_role;

-- Owner-only access: a signed-in user sees and changes only their own rows.
drop policy if exists "bookmarks_owner_select" on public.bookmarks;
create policy "bookmarks_owner_select" on public.bookmarks
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "bookmarks_owner_insert" on public.bookmarks;
create policy "bookmarks_owner_insert" on public.bookmarks
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "bookmarks_owner_update" on public.bookmarks;
create policy "bookmarks_owner_update" on public.bookmarks
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "bookmarks_owner_delete" on public.bookmarks;
create policy "bookmarks_owner_delete" on public.bookmarks
  for delete to authenticated using (user_id = auth.uid());

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  credits integer not null default 5 check (credits >= 0),
  plan_type text not null default 'free' check (plan_type in ('free', 'pro')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;
-- SECURITY FIX (2026-11-24 audit, critical): a user must NEVER be able to
-- write their own profile row. The previous version granted insert/update
-- to authenticated with owner-only policies, which let any signed-in user
-- set their own plan_type = 'pro' and credits = 9999 from the browser
-- console, bypassing the whole credit system. Only the server, using the
-- service-role (admin) client that bypasses RLS, may create a profile row
-- and change credits / plan_type. Users may only READ their own row
-- (credits / plan_type for the UI). There is deliberately NO insert or
-- update policy on this table for authenticated users.
revoke all on public.user_profiles from anon, authenticated;
grant select on public.user_profiles to authenticated;
grant all on public.user_profiles to service_role;

drop policy if exists "user_profiles_owner_select" on public.user_profiles;
create policy "user_profiles_owner_select" on public.user_profiles
  for select to authenticated using (user_id = auth.uid());

-- Remove the dangerous policies if a previous run of this migration (or a
-- manual setup) created them. Do NOT re-create insert/update policies here.
drop policy if exists "user_profiles_owner_insert" on public.user_profiles;
drop policy if exists "user_profiles_owner_update" on public.user_profiles;

-- Atomic credit deduction (I8): one statement checks the balance and
-- deducts, so two simultaneous requests cannot spend the same credit.
-- Returns the new balance, or NULL when the balance is already 0.
create or replace function public.deduct_credit(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.user_profiles
  set credits = credits - 1,
      updated_at = now()
  where user_id = p_user_id
    and credits > 0
  returning credits;
$$;

revoke all on function public.deduct_credit(uuid) from public;
grant execute on function public.deduct_credit(uuid) to authenticated, service_role;
