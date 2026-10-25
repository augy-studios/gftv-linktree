-- 006_quarantine.sql
--
-- Run once in the Supabase SQL editor, after 005. Quarantine for pages whose
-- owner keeps trying to add harmful addresses.
--
-- When a page has three links or redirects refused in a day for being on a
-- blocklist (harmful, gambling, adult, a staff block, or a non-web scheme),
-- the API sets quarantined_at: the page is hidden from visitors, its owner is
-- told why, and a report is filed for staff, who release it from the
-- dashboard. The connection the attempts came from is flagged separately,
-- in the rate limit table, and cannot save addresses for the rest of the day.
--
-- This file is never edited after it has been run. Changes go in 007 onwards.

begin;

alter table gftvonelink_pages
  add column if not exists quarantined_at timestamptz,
  add column if not exists quarantine_reason text
    check (quarantine_reason is null or char_length(quarantine_reason) <= 500);

create index if not exists gftvonelink_pages_quarantine_idx
  on gftvonelink_pages (quarantined_at desc)
  where quarantined_at is not null;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop index if exists gftvonelink_pages_quarantine_idx;
-- alter table gftvonelink_pages
--   drop column if exists quarantine_reason,
--   drop column if exists quarantined_at;
-- commit;
