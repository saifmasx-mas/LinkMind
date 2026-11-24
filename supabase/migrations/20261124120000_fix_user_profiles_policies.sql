-- SECURITY FIX (2026-11-24 audit, critical): the original version of this
-- migration let any signed-in user update/insert their own user_profiles
-- row, so they could set plan_type = 'pro' and credits = 9999 from the
-- browser. If that migration was already applied to a live database,
-- re-running it does nothing (Supabase only applies a migration once), so
-- this second migration removes the dangerous policies and grants.
-- Safe to run on a fresh database too (the drops are IF EXISTS).
-- Only the server (service-role / admin client) may write user_profiles.

revoke insert, update on public.user_profiles from authenticated;
grant select on public.user_profiles to authenticated;

drop policy if exists "user_profiles_owner_insert" on public.user_profiles;
drop policy if exists "user_profiles_owner_update" on public.user_profiles;

-- The owner-read policy must still exist (fresh DBs get it from the first
-- migration; existing DBs keep it). Re-create it idempotently.
drop policy if exists "user_profiles_owner_select" on public.user_profiles;
create policy "user_profiles_owner_select" on public.user_profiles
  for select to authenticated using (user_id = auth.uid());
