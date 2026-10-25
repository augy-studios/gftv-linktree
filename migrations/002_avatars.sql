-- 002_avatars.sql
--
-- Profile pictures for pages. Run once in the Supabase SQL editor, after 001.
--
-- The picture itself lives in a public Supabase Storage bucket, the same
-- arrangement as gftvhello_avatars. The page row keeps only the object's path
-- inside the bucket; the public address is built from SUPABASE_URL by the API.
--
-- Only the API writes to the bucket, with the service role key. The bucket is
-- public for reading, so a page's picture loads without a signed URL, and it
-- has no storage policies, so nobody else can upload, replace or delete.
--
-- Every picture is stored as WebP. The browser crops and compresses it to
-- WebP before upload, and the API re-encodes whatever arrives to a 512 by 512
-- WebP with all metadata (including any location) stripped, so the bucket
-- only ever holds small WebP files. The bucket enforces the same limits as a
-- second line.
--
-- This file is never edited after it has been run. Changes go in 003 onwards.

begin;

-- <page id>/<random name>.webp. A new random name on every upload, so a
-- replaced picture is never served from a stale cache.
alter table gftvonelink_pages
  add column if not exists avatar_path text
    check (avatar_path is null
           or avatar_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{16,64}\.webp$');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gftvonelink_avatars', 'gftvonelink_avatars', true, 262144, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;

-- Rollback, if this ever has to be undone (empty the bucket first in the
-- Storage dashboard; Supabase will not drop a bucket that still has files):
--
-- begin;
-- delete from storage.buckets where id = 'gftvonelink_avatars';
-- alter table gftvonelink_pages drop column if exists avatar_path;
-- commit;
