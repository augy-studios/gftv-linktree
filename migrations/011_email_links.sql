-- 011_email_links.sql
--
-- Run once in the Supabase SQL editor, after 010. Lets a link be an email
-- address (mailto:) as well as a web address. The API decides what a valid
-- one is (validate.js sanitizeUrl: one plain address, no ?subject= or other
-- headers); this is the last line. A page's redirect stays web addresses
-- only, as 003 has it.
--
-- 001 wrote the old rule as an unnamed column check, which Postgres named
-- gftvonelink_links_url_check. It is replaced, under the same name.
--
-- This file is never edited after it has been run. Changes go in 012 onwards.

begin;

alter table gftvonelink_links drop constraint if exists gftvonelink_links_url_check;
alter table gftvonelink_links
  add constraint gftvonelink_links_url_check
    check ((url ~* '^https?://' or url ~* '^mailto:') and char_length(url) <= 2048);

commit;

-- Rollback (fails while any link is an email address):
--
-- begin;
-- alter table gftvonelink_links drop constraint if exists gftvonelink_links_url_check;
-- alter table gftvonelink_links
--   add constraint gftvonelink_links_url_check
--     check (url ~* '^https?://' and char_length(url) <= 2048);
-- commit;
