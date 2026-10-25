-- 004_name_review.sql
--
-- Run once in the Supabase SQL editor, after 003. Page names that need a
-- person to look at them before the page goes live.
--
-- Staff keep a list of patterns (JavaScript regular expressions, matched
-- case-insensitively against the page name, like the 'names' patterns in
-- 003). A name that matches one can still be registered and set up, but the
-- page is not shown to visitors until a staff member approves it. Refusing
-- one is the existing take down or delete.
--
-- This file is never edited after it has been run. Changes go in 005 onwards.

begin;

create table if not exists gftvonelink_review_patterns (
  id          uuid primary key default gen_random_uuid(),
  pattern     text not null unique check (char_length(pattern) between 1 and 200),
  reason      text check (reason is null or char_length(reason) <= 500),
  created_by  uuid references gftvhello_users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- needs_review is set at registration when the name matches a pattern, and
-- stays true as the record; reviewed_at says whether the review happened.
alter table gftvonelink_pages
  add column if not exists needs_review boolean not null default false,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references gftvhello_users (id) on delete set null;

create index if not exists gftvonelink_pages_review_idx
  on gftvonelink_pages (created_at desc)
  where needs_review and reviewed_at is null;

alter table gftvonelink_review_patterns enable row level security;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop index if exists gftvonelink_pages_review_idx;
-- alter table gftvonelink_pages
--   drop column if exists reviewed_by,
--   drop column if exists reviewed_at,
--   drop column if exists needs_review;
-- drop table if exists gftvonelink_review_patterns;
-- commit;
