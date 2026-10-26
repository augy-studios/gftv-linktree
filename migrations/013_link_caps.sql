-- 013_link_caps.sql
--
-- Run once in the Supabase SQL editor, after 012. Puts a limit on how many
-- links a page can have, which admins set, and lets owners ask for more.
--
--   - gftvonelink_settings: site-wide settings admins change from the
--     dashboard. One for now, links_cap, the default limit for every page
--     (20 to start with).
--   - gftvonelink_pages.links_cap: a page's own limit, set by an admin. Null
--     means the page follows the default.
--   - gftvonelink_link_cap_requests: an owner asking for a higher limit, with
--     the number they want and why. One open request per page at a time.
--   - A trigger on gftvonelink_links that refuses a new link once a page is
--     at its limit, so the limit holds even if two links are added at the
--     same moment, or something other than the API inserts one.
--
-- Links staff have removed do not count, since the owner cannot delete them.
-- Hidden links do count. Lowering a limit never deletes anything: a page over
-- its limit keeps its links and just cannot add more.
--
-- No limit can be set above 200 (MAX_LINKS in api/_lib/validate.js).
--
-- This file is never edited after it has been run. Changes go in 014 onwards.

begin;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_settings (
  key         text primary key check (key ~ '^[a-z0-9_]{1,64}$'),
  value       jsonb not null,
  updated_by  uuid references gftvhello_users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

insert into gftvonelink_settings (key, value)
values ('links_cap', '20'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- A page's own limit
-- ---------------------------------------------------------------------------

alter table gftvonelink_pages
  add column if not exists links_cap integer
    check (links_cap is null or links_cap between 1 and 200);

-- ---------------------------------------------------------------------------
-- Requests for a higher limit
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_link_cap_requests (
  id             uuid primary key default gen_random_uuid(),
  page_id        uuid not null references gftvonelink_pages (id) on delete cascade,
  requested_cap  integer not null check (requested_cap between 1 and 200),
  -- The page's limit when it asked.
  current_cap    integer not null check (current_cap between 1 and 200),
  reason         text not null check (char_length(reason) between 1 and 500),
  -- pending    waiting for an admin
  -- approved   granted_cap is now the page's limit
  -- declined   not this time; the owner can ask again
  -- withdrawn  the owner took it back
  status         text not null default 'pending'
                   check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  granted_cap    integer check (granted_cap is null or granted_cap between 1 and 200),
  -- Shown to the owner with the outcome.
  review_note    text check (review_note is null or char_length(review_note) <= 500),
  reviewed_by    uuid references gftvhello_users (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- One open request per page.
create unique index if not exists gftvonelink_link_cap_requests_open_idx
  on gftvonelink_link_cap_requests (page_id)
  where status = 'pending';

create index if not exists gftvonelink_link_cap_requests_status_idx
  on gftvonelink_link_cap_requests (status, created_at);

create index if not exists gftvonelink_link_cap_requests_page_idx
  on gftvonelink_link_cap_requests (page_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The limit, worked out in one place, and held on every insert
-- ---------------------------------------------------------------------------

-- The page's own limit, else the default setting, else 20.
create or replace function gftvonelink_link_cap(p_page_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select links_cap from gftvonelink_pages where id = p_page_id),
    (select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::integer end
       from gftvonelink_settings where key = 'links_cap'),
    20
  );
$$;

-- Locks the page row first, so a second insert for the same page waits until
-- the first has committed and then counts it. Two links added at once cannot
-- both slip under the limit.
create or replace function gftvonelink_links_enforce_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap  integer;
  v_used integer;
begin
  perform 1 from gftvonelink_pages where id = new.page_id for no key update;
  v_cap := gftvonelink_link_cap(new.page_id);
  select count(*) into v_used
    from gftvonelink_links
   where page_id = new.page_id
     and removed_at is null;
  if v_used >= v_cap then
    raise exception 'too_many_links' using errcode = 'P0001', detail = format('limit %s', v_cap);
  end if;
  return new;
end;
$$;

drop trigger if exists gftvonelink_links_cap on gftvonelink_links;
create trigger gftvonelink_links_cap
  before insert on gftvonelink_links
  for each row execute function gftvonelink_links_enforce_cap();

revoke all on function gftvonelink_link_cap(uuid) from public, anon, authenticated;
revoke all on function gftvonelink_links_enforce_cap() from public, anon, authenticated;
grant execute on function gftvonelink_link_cap(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Row level security: on, no policies, service role only
-- ---------------------------------------------------------------------------

alter table gftvonelink_settings           enable row level security;
alter table gftvonelink_link_cap_requests  enable row level security;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop trigger if exists gftvonelink_links_cap on gftvonelink_links;
-- drop function if exists gftvonelink_links_enforce_cap();
-- drop function if exists gftvonelink_link_cap(uuid);
-- drop table if exists gftvonelink_link_cap_requests;
-- alter table gftvonelink_pages drop column if exists links_cap;
-- drop table if exists gftvonelink_settings;
-- commit;
