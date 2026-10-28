-- 014_allowed_domains.sql
--
-- Run once in the Supabase SQL editor, after 013. Domains staff vouch for:
-- links to them, and to any subdomain of them, skip the threat lists (the
-- HaGeZi domain blocklists and Google Safe Browsing), for a site one of
-- those lists has caught by mistake.
--
-- The staff block lists still apply: a domain that is both blocked and
-- allowed stays blocked. So does the built-in list of link shorteners.
--
-- This file is never edited after it has been run. Changes go in 015 onwards.

begin;

create table if not exists gftvonelink_allowed_domains (
  domain      text primary key check (domain ~ '^[a-z0-9.-]{3,253}$'),
  reason      text check (reason is null or char_length(reason) <= 500),
  created_by  uuid references gftvhello_users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Row level security: on, no policies, service role only.
alter table gftvonelink_allowed_domains enable row level security;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop table if exists gftvonelink_allowed_domains;
-- commit;
