-- Free starting credits 5 -> 10 (2026-11-27, DEMO phase).
--
-- A brand-new account starts with 10 free credits so a graduation
-- committee member signing in with their own email can save links
-- and ask the library properly during the demo. The three server
-- routes that create a profile row (/api/analyze, /api/ask,
-- /api/telegram) already insert credits: 10 explicitly; this changes
-- the column default too, so any row created without an explicit
-- value (e.g. a future trigger or a manual insert) also starts at 10.
--
-- Existing balances are untouched: this only changes the default for
-- rows created from now on.
--
-- FUTURE: at the official launch (own domain + working payment
-- gateway) the free starting credits go BACK to 5 — set this default
-- back to 5 and change the three route inserts back to 5 in the same
-- change. Do NOT revert before the official launch.
alter table public.user_profiles
  alter column credits set default 10;
