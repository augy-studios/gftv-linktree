-- 003_redirects_insights_dormancy.sql
--
-- Run once in the Supabase SQL editor, after 002. Adds:
--
--   Redirect pages   a page can send visitors to one address instead of
--                    showing links (redirect_url). Visitors see a five second
--                    "you will be redirected to" screen with a Report button.
--   Dormancy         a page whose owner has not signed in for a year stops
--                    being shown until they sign in again (last_sign_in_at).
--                    Nothing is deleted and the name stays held. The daily
--                    cron sends a Telegram reminder 30 days before, once
--                    (dormancy_warned_at), when Telegram is linked.
--   Insights         daily totals per page: visits, clicks, and visits by
--                    country, device and referring site. Counts only: no
--                    address, no visitor identifier, nothing per person.
--   Blocked patterns regular expressions staff set, on top of the blocked
--                    domains, refused in link addresses, page names or both.
--   Testimonials     quotes for the home page's community section, entered
--                    by staff.
--
-- This file is never edited after it has been run. Changes go in 004 onwards.

begin;

-- ---------------------------------------------------------------------------
-- Pages: redirect address and sign-in clock
-- ---------------------------------------------------------------------------

alter table gftvonelink_pages
  add column if not exists redirect_url text
    check (redirect_url is null or (redirect_url ~* '^https?://' and char_length(redirect_url) <= 2048)),
  add column if not exists last_sign_in_at timestamptz,
  add column if not exists dormancy_warned_at timestamptz;

-- Every page that exists now starts with a full year from today, rather than
-- going dormant the moment this runs.
update gftvonelink_pages set last_sign_in_at = now() where last_sign_in_at is null;

alter table gftvonelink_pages
  alter column last_sign_in_at set default now(),
  alter column last_sign_in_at set not null;

-- The cron's reminder sweep looks for live pages by sign-in age.
create index if not exists gftvonelink_pages_sign_in_idx
  on gftvonelink_pages (last_sign_in_at)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- Insights: one row per page, day, kind and key, holding a running count
-- ---------------------------------------------------------------------------
--
--   visits    key ''              visits to the public page
--   clicks    key ''              clicks on its links
--   country   key 'SG', 'MY' ...  visits by country (Vercel's geo header);
--                                 'XX' when unknown
--   device    key 'mobile' | 'tablet' | 'desktop'
--   referrer  key 'instagram.com' ...  the referring site's host; '' when
--                                 the visitor came direct or it was withheld
--
-- Days are Singapore days, the audience's own.

create table if not exists gftvonelink_page_stats (
  page_id  uuid not null references gftvonelink_pages (id) on delete cascade,
  day      date not null,
  kind     text not null check (kind in ('visits', 'clicks', 'country', 'device', 'referrer')),
  key      text not null default '' check (char_length(key) <= 64),
  hits     bigint not null default 0,
  primary key (page_id, day, kind, key)
);

create index if not exists gftvonelink_page_stats_day_idx
  on gftvonelink_page_stats (page_id, day desc);

-- Count one visit: the total and each breakdown, in one statement. Returns
-- whether it counted, so a visit to a page that is not live is not recorded.
create or replace function gftvonelink_page_visit(p_page_id uuid, p_country text, p_device text, p_referrer text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Singapore')::date;
begin
  if not exists (select 1 from gftvonelink_pages where id = p_page_id and status = 'active') then
    return false;
  end if;
  insert into gftvonelink_page_stats as s (page_id, day, kind, key, hits)
  values
    (p_page_id, v_day, 'visits', '', 1),
    (p_page_id, v_day, 'country', left(coalesce(p_country, 'XX'), 64), 1),
    (p_page_id, v_day, 'device', left(coalesce(p_device, 'desktop'), 64), 1),
    (p_page_id, v_day, 'referrer', left(coalesce(p_referrer, ''), 64), 1)
  on conflict (page_id, day, kind, key) do update set hits = s.hits + 1;
  return true;
end;
$$;

-- 001's click counter, now also adding to the page's daily click total.
-- Same signature, so 001's grants still apply.
create or replace function gftvonelink_link_click(p_link_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page uuid;
begin
  update gftvonelink_links l
     set click_count = l.click_count + 1
    from gftvonelink_pages p
   where l.id = p_link_id
     and p.id = l.page_id
     and p.status = 'active'
     and l.is_active
     and l.removed_at is null
  returning l.page_id into v_page;
  if v_page is null then
    return false;
  end if;
  insert into gftvonelink_page_stats as s (page_id, day, kind, key, hits)
  values (v_page, (now() at time zone 'Asia/Singapore')::date, 'clicks', '', 1)
  on conflict (page_id, day, kind, key) do update set hits = s.hits + 1;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Blocked patterns
-- ---------------------------------------------------------------------------

-- JavaScript regular expressions, matched case-insensitively by the API
-- against a link's full address ('links'), a page name ('names'), or both.
-- The API refuses patterns that do not compile and the nested repeats that
-- make a pattern slow; the length cap here is the last line.
create table if not exists gftvonelink_blocked_patterns (
  id          uuid primary key default gen_random_uuid(),
  pattern     text not null unique check (char_length(pattern) between 1 and 200),
  applies_to  text not null default 'links' check (applies_to in ('links', 'names', 'both')),
  reason      text check (reason is null or char_length(reason) <= 500),
  created_by  uuid references gftvhello_users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Testimonials for the home page
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_testimonials (
  id           uuid primary key default gen_random_uuid(),
  quote        text not null check (char_length(quote) between 1 and 280),
  author       text not null check (char_length(author) between 1 and 60),
  -- The author's OneLink page, linked under the quote when given.
  page_slug    text check (page_slug is null or page_slug ~ '^[a-z0-9-]{2,32}$'),
  is_visible   boolean not null default true,
  order_index  integer not null default 0,
  created_by   uuid references gftvhello_users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists gftvonelink_testimonials_order_idx
  on gftvonelink_testimonials (order_index);

drop trigger if exists gftvonelink_testimonials_touch on gftvonelink_testimonials;
create trigger gftvonelink_testimonials_touch
  before update on gftvonelink_testimonials
  for each row execute function gftvonelink_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants and row level security, as in 001: service role only
-- ---------------------------------------------------------------------------

revoke all on function gftvonelink_page_visit(uuid, text, text, text) from public, anon, authenticated;
grant execute on function gftvonelink_page_visit(uuid, text, text, text) to service_role;

alter table gftvonelink_page_stats        enable row level security;
alter table gftvonelink_blocked_patterns  enable row level security;
alter table gftvonelink_testimonials      enable row level security;

commit;

-- Rollback, if this ever has to be undone before anything depends on it.
-- The click counter goes back to 001's version, which is in that file.
--
-- begin;
-- drop function if exists gftvonelink_page_visit(uuid, text, text, text);
-- drop table if exists gftvonelink_testimonials, gftvonelink_blocked_patterns,
--   gftvonelink_page_stats;
-- drop index if exists gftvonelink_pages_sign_in_idx;
-- alter table gftvonelink_pages
--   drop column if exists dormancy_warned_at,
--   drop column if exists last_sign_in_at,
--   drop column if exists redirect_url;
-- commit;
