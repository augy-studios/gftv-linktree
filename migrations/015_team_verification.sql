-- 015_team_verification.sql
--
-- Run once in the Supabase SQL editor, after 014. Marks a page as belonging
-- to someone on the GFTV team. A verified page shows a ring and a tick on its
-- picture and a "GFTV team" line under the name, so the page itself is a way
-- to check that someone is on the team.
--
-- Only admins set or clear it, from the admin dashboard. Taking a page down
-- clears it, so a page that comes back is not verified until an admin says so
-- again.
--
-- team_role is an optional label shown with the mark, such as "Moderator".
--
-- This file is never edited after it has been run. Changes go in 016 onwards.

begin;

alter table gftvonelink_pages
  add column if not exists team_verified_at timestamptz,
  add column if not exists team_verified_by uuid references gftvhello_users (id) on delete set null,
  add column if not exists team_role text check (team_role is null or char_length(team_role) <= 40);

-- For the admin filter of verified pages.
create index if not exists gftvonelink_pages_team_verified_idx
  on gftvonelink_pages (team_verified_at)
  where team_verified_at is not null;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop index if exists gftvonelink_pages_team_verified_idx;
-- alter table gftvonelink_pages
--   drop column if exists team_role,
--   drop column if exists team_verified_by,
--   drop column if exists team_verified_at;
-- commit;
