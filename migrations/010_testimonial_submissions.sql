-- 010_testimonial_submissions.sql
--
-- Run once in the Supabase SQL editor, after 009. Lets page owners send in a
-- testimonial for the home page, which waits for an admin or editor to
-- approve it.
--
-- page_id is the page that sent it (null for quotes staff entered, as in
-- 003). One per page: sending again replaces it and it waits again. A page
-- deleted takes its testimonial with it. status says whether staff have
-- approved it; only approved and visible ones are shown. Quotes that exist
-- now were entered by staff and count as approved.
--
-- This file is never edited after it has been run. Changes go in 011 onwards.

begin;

alter table gftvonelink_testimonials
  add column if not exists page_id uuid references gftvonelink_pages (id) on delete cascade,
  add column if not exists status text not null default 'approved'
    check (status in ('pending', 'approved', 'declined')),
  -- When the owner agreed to it being shown with their page's name.
  add column if not exists consented_at timestamptz,
  add column if not exists reviewed_by uuid references gftvhello_users (id) on delete set null,
  add column if not exists reviewed_at timestamptz;

create unique index if not exists gftvonelink_testimonials_page_idx
  on gftvonelink_testimonials (page_id)
  where page_id is not null;

create index if not exists gftvonelink_testimonials_status_idx
  on gftvonelink_testimonials (status, created_at);

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop index if exists gftvonelink_testimonials_status_idx;
-- drop index if exists gftvonelink_testimonials_page_idx;
-- alter table gftvonelink_testimonials
--   drop column if exists reviewed_at,
--   drop column if exists reviewed_by,
--   drop column if exists consented_at,
--   drop column if exists status,
--   drop column if exists page_id;
-- commit;
