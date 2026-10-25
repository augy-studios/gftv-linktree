-- 007_longer_bio.sql
--
-- Run once in the Supabase SQL editor, after 006. Lets a page's bio be up to
-- 512 characters instead of 280. The API enforces the same limit
-- (validate.js LIMITS.bio); this is the last line.
--
-- 001 wrote the old limit as an unnamed column check, which Postgres named
-- gftvonelink_pages_bio_check. It is replaced, under the same name.
--
-- This file is never edited after it has been run. Changes go in 008 onwards.

begin;

alter table gftvonelink_pages drop constraint if exists gftvonelink_pages_bio_check;
alter table gftvonelink_pages
  add constraint gftvonelink_pages_bio_check check (char_length(bio) <= 512);

commit;

-- Rollback (fails while any bio is longer than 280 characters):
--
-- begin;
-- alter table gftvonelink_pages drop constraint if exists gftvonelink_pages_bio_check;
-- alter table gftvonelink_pages
--   add constraint gftvonelink_pages_bio_check check (char_length(bio) <= 280);
-- commit;
