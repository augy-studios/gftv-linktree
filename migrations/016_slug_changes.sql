-- 016_slug_changes.sql
--
-- Run once in the Supabase SQL editor, after 015. Lets an owner change their
-- page name (the slug) from the editor.
--
-- Every change is a row here. The rows do three things:
--   - hold the old name for 30 days, so nobody else can take it while
--     links to it are still going around. The page that had it can take it
--     back. Code: SLUG_HOLD_DAYS in api/_lib/slug-changes.js
--   - send visitors to /<old name> on to the page's name now, for as long
--     as the old name is held
--   - space renames out: one every 30 days (RENAME_COOLDOWN_DAYS)
--
-- A new name on the staff review list (004) puts the page back in review,
-- like a new page, and the staff Telegram chat hears about it when
-- TELEGRAM_STAFF_CHAT_ID is set.
--
-- This file is never edited after it has been run. Changes go in 017 onwards.

begin;

create table if not exists gftvonelink_slug_changes (
  id          uuid primary key default gen_random_uuid(),
  page_id     uuid not null references gftvonelink_pages (id) on delete cascade,
  old_slug    text not null check (old_slug ~ '^[a-z0-9-]{2,32}$'),
  new_slug    text not null check (new_slug ~ '^[a-z0-9-]{2,32}$'),
  -- Whether the new name was on the review list, for the record.
  needed_review boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Is this old name held, and by which page?
create index if not exists gftvonelink_slug_changes_old_idx
  on gftvonelink_slug_changes (old_slug, created_at desc);

-- A page's latest rename, for the cooldown and the admin dashboard.
create index if not exists gftvonelink_slug_changes_page_idx
  on gftvonelink_slug_changes (page_id, created_at desc);

alter table gftvonelink_slug_changes enable row level security;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop table if exists gftvonelink_slug_changes;
-- commit;
