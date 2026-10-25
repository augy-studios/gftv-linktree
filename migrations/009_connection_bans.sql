-- 009_connection_bans.sql
--
-- Run once in the Supabase SQL editor, after 008. Bans on connections that
-- keep producing harmful pages.
--
-- When a second page is quarantined from the same connection (006), that
-- connection is banned: it can no longer create pages or change one (links,
-- redirect, profile, picture). Viewing, signing in and reporting still work,
-- so someone caught by a shared address (a mobile network, a school or a
-- convention's Wi-Fi) can still read why and ask for help. Staff can also ban
-- a flagged connection by hand. A ban lasts until staff lift it.
--
-- The address itself is never stored, only the salted hash the rest of the
-- app uses (ip_hash in the audit log), and the pages that led to the ban.
--
-- This file is never edited after it has been run. Changes go in 010 onwards.

begin;

create table if not exists gftvonelink_ip_bans (
  ip_hash     text primary key check (ip_hash ~ '^[0-9a-f]{64}$'),
  reason      text check (reason is null or char_length(reason) <= 500),
  page_ids    uuid[] not null default '{}',
  -- Null when the system banned it automatically.
  created_by  uuid references gftvhello_users (id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table gftvonelink_ip_bans enable row level security;

commit;

-- Rollback:
--
-- drop table if exists gftvonelink_ip_bans;
