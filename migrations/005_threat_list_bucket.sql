-- 005_threat_list_bucket.sql
--
-- Run once in the Supabase SQL editor, after 004. A private Storage bucket
-- for the compact copy of the domain blocklist (HaGeZi's Threat Intelligence
-- Feeds by default, about two million domains) that links are checked
-- against.
--
-- The list itself is far too big to download on every request, so the daily
-- cron rebuilds it every two weeks: it downloads the list once, turns each
-- domain into an 8-byte fingerprint, sorts them, and stores the result here
-- as one file (about 17 MB) with a small JSON file describing it. Each API
-- instance loads that file once and searches it in memory.
--
-- Private, and with no storage policies: only the API, with the service role
-- key, reads or writes it.
--
-- This file is never edited after it has been run. Changes go in 006 onwards.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gftvonelink_lists', 'gftvonelink_lists', false, 52428800, array['application/octet-stream', 'application/json'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;

-- Rollback (empty the bucket first in the Storage dashboard):
--
-- begin;
-- delete from storage.buckets where id = 'gftvonelink_lists';
-- commit;
