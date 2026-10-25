-- 001_onelink_schema.sql
--
-- OneLink GFTV (links.gftv.asia), first schema.
-- Run once in the Supabase SQL editor. Every table this app owns carries the
-- gftvonelink_ prefix so it cannot collide with the gftvhello_, gftvjobs_ and
-- gftvlinks_ tables that share the project.
--
-- Two realms, kept apart on purpose:
--
--   Page owners  the public. A page is the account: a slug, a password, and a
--                mandatory second factor (TOTP or a passkey). No email.
--   Staff        GFTV admins and editors. Accounts are gftvhello_users, which
--                this file references and never alters. Staff sessions and
--                staff passkeys live in this app's own tables, so signing in or
--                out here never touches a session on another GFTV site.
--
-- Secrets are never stored as issued: passwords and backup codes are bcrypt,
-- session and challenge tokens are SHA-256, TOTP secrets are AES-256-GCM
-- encrypted by the API before they reach this table.
--
-- RLS is enabled on every table with no policies, so the anon and
-- authenticated keys can read nothing. Only the service role key, which lives
-- in the Vercel environment and never in the browser, gets through.
--
-- This file is never edited after it has been run. Changes go in 002 onwards.

begin;

-- gen_random_uuid() is built into Postgres 13 and later, so no extension.

-- ---------------------------------------------------------------------------
-- Pages: one per public profile, and the owner's account at the same time
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_pages (
  id                   uuid primary key default gen_random_uuid(),
  -- 2 to 32 characters, lowercase letters, digits and single inner dashes.
  -- The reserved list is enforced in the API, where it can grow without a
  -- migration; the shape is enforced here as well, as the last line.
  slug                 text not null unique
                         check (slug ~ '^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$'),
  display_name         text not null default ''
                         check (char_length(display_name) <= 60),
  bio                  text not null default ''
                         check (char_length(bio) <= 280),
  password_hash        text not null,
  -- AES-256-GCM ciphertext written by the API (v1:iv:tag:data), never the
  -- base32 secret itself. Null when the owner has no authenticator app.
  totp_secret          text,
  telegram_chat_id     bigint,
  telegram_username    text,
  -- pending  created, second factor not set up yet; not public, and the slug
  --          is released again if setup is abandoned for an hour
  -- active   live at links.gftv.asia/<slug>
  -- banned   taken down by staff; the slug stays held
  status               text not null default 'pending'
                         check (status in ('pending', 'active', 'banned')),
  ban_reason           text,
  banned_at            timestamptz,
  banned_by            uuid references gftvhello_users (id) on delete set null,
  password_changed_at  timestamptz not null default now(),
  activated_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists gftvonelink_pages_status_idx
  on gftvonelink_pages (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Links on a page
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_links (
  id              uuid primary key default gen_random_uuid(),
  page_id         uuid not null references gftvonelink_pages (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 80),
  -- http and https only, checked in the API and again here.
  url             text not null check (url ~* '^https?://' and char_length(url) <= 2048),
  order_index     integer not null default 0,
  -- A name from the app's own inline SVG set, never a URL or markup.
  icon            text not null default 'link' check (icon ~ '^[a-z0-9-]{1,24}$'),
  click_count     bigint not null default 0,
  -- The owner's own show/hide switch.
  is_active       boolean not null default true,
  -- Staff moderation. A soft delete: the row stays for the audit trail and
  -- can be restored, but the link is never served while removed_at is set.
  removed_at      timestamptz,
  removed_by      uuid references gftvhello_users (id) on delete set null,
  removed_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists gftvonelink_links_page_idx
  on gftvonelink_links (page_id, order_index);

create index if not exists gftvonelink_links_removed_idx
  on gftvonelink_links (removed_at);

-- ---------------------------------------------------------------------------
-- Second factors for page owners
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_passkeys (
  id             uuid primary key default gen_random_uuid(),
  page_id        uuid not null references gftvonelink_pages (id) on delete cascade,
  -- base64url, as the authenticator reports it.
  credential_id  text not null unique,
  -- base64url of the COSE public key. Public by definition.
  public_key     text not null,
  -- Rejected on a decrease, the one signal WebAuthn gives of a cloned key.
  counter        bigint not null default 0,
  transports     text[],
  label          text check (label is null or char_length(label) <= 60),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create index if not exists gftvonelink_passkeys_page_idx
  on gftvonelink_passkeys (page_id);

-- One-time backup codes, issued in a set of ten when the second factor is
-- first set up and again on regeneration. Good for the second factor only:
-- a backup code never gets past the password.
create table if not exists gftvonelink_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  page_id     uuid not null references gftvonelink_pages (id) on delete cascade,
  code_hash   text not null,
  used        boolean not null default false,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists gftvonelink_recovery_codes_page_idx
  on gftvonelink_recovery_codes (page_id, used);

-- ---------------------------------------------------------------------------
-- Owner sessions
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_sessions (
  id            uuid primary key default gen_random_uuid(),
  page_id       uuid not null references gftvonelink_pages (id) on delete cascade,
  -- SHA-256 of the cookie value. The cookie itself is never stored.
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists gftvonelink_sessions_page_idx
  on gftvonelink_sessions (page_id);

create index if not exists gftvonelink_sessions_expires_idx
  on gftvonelink_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Staff: sessions and passkeys for gftvhello_users accounts, on this site only
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_staff_sessions (
  id             uuid primary key default gen_random_uuid(),
  staff_user_id  uuid not null references gftvhello_users (id) on delete cascade,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);

create index if not exists gftvonelink_staff_sessions_user_idx
  on gftvonelink_staff_sessions (staff_user_id);

create index if not exists gftvonelink_staff_sessions_expires_idx
  on gftvonelink_staff_sessions (expires_at);

-- A passkey is bound to the domain that created it, so a staff passkey made
-- here works on links.gftv.asia only. gftvhello_users is referenced, never
-- written, the same arrangement as gftvjobs_staff_passkeys.
create table if not exists gftvonelink_staff_passkeys (
  id             uuid primary key default gen_random_uuid(),
  staff_user_id  uuid not null references gftvhello_users (id) on delete cascade,
  credential_id  text not null unique,
  public_key     text not null,
  counter        bigint not null default 0,
  transports     text[],
  label          text check (label is null or char_length(label) <= 60),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create index if not exists gftvonelink_staff_passkeys_user_idx
  on gftvonelink_staff_passkeys (staff_user_id);

-- ---------------------------------------------------------------------------
-- Challenges: a sign in that has passed the password and waits on a second
-- factor, a new page waiting on its first second factor, or a recovery in
-- progress. Never a session.
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_auth_challenges (
  id                        uuid primary key default gen_random_uuid(),
  realm                     text not null check (realm in ('owner', 'staff')),
  purpose                   text not null check (purpose in ('login', 'enrol', 'recover')),
  -- gftvonelink_pages.id for owners, gftvhello_users.id for staff. No foreign
  -- key, since a column cannot reference both; rows live for minutes.
  subject_id                uuid not null,
  token_hash                text not null unique,
  attempts                  integer not null default 0,
  -- A pending TOTP secret during enrolment, encrypted like the real one.
  pending_totp_secret       text,
  -- A six digit code sent by Telegram for this challenge, bcrypt hashed.
  telegram_code_hash        text,
  telegram_code_expires_at  timestamptz,
  expires_at                timestamptz not null,
  created_at                timestamptz not null default now()
);

create index if not exists gftvonelink_auth_challenges_subject_idx
  on gftvonelink_auth_challenges (realm, subject_id);

create index if not exists gftvonelink_auth_challenges_expires_idx
  on gftvonelink_auth_challenges (expires_at);

-- WebAuthn ceremonies. Server generated, single use, minutes long. Kept in a
-- table because the request that verifies a ceremony is rarely served by the
-- function instance that started it.
create table if not exists gftvonelink_webauthn_challenges (
  id          uuid primary key default gen_random_uuid(),
  realm       text not null check (realm in ('owner', 'staff')),
  purpose     text not null check (purpose in ('register', 'authenticate')),
  subject_id  uuid not null,
  challenge   text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists gftvonelink_webauthn_challenges_lookup_idx
  on gftvonelink_webauthn_challenges (realm, subject_id, purpose);

create index if not exists gftvonelink_webauthn_challenges_expires_idx
  on gftvonelink_webauthn_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- Telegram linking: a one-time token carried in a t.me deep link
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_telegram_links (
  id          uuid primary key default gen_random_uuid(),
  page_id     uuid not null references gftvonelink_pages (id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists gftvonelink_telegram_links_page_idx
  on gftvonelink_telegram_links (page_id);

-- ---------------------------------------------------------------------------
-- Moderation
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_reports (
  id               uuid primary key default gen_random_uuid(),
  page_id          uuid not null references gftvonelink_pages (id) on delete cascade,
  link_id          uuid references gftvonelink_links (id) on delete set null,
  reason           text not null
                     check (reason in ('spam', 'scam', 'malware', 'impersonation', 'abuse', 'adult', 'other')),
  details          text not null default '' check (char_length(details) <= 500),
  -- Salted SHA-256 of the reporter's address, for spotting a flood from one
  -- source. Never the address itself.
  reporter_hash    text,
  status           text not null default 'open'
                     check (status in ('open', 'resolved', 'dismissed')),
  resolved_by      uuid references gftvhello_users (id) on delete set null,
  resolved_at      timestamptz,
  resolution_note  text check (resolution_note is null or char_length(resolution_note) <= 500),
  created_at       timestamptz not null default now()
);

create index if not exists gftvonelink_reports_status_idx
  on gftvonelink_reports (status, created_at desc);

create index if not exists gftvonelink_reports_page_idx
  on gftvonelink_reports (page_id);

-- Slugs staff have closed to registration, on top of the system list in code.
create table if not exists gftvonelink_blocked_slugs (
  slug        text primary key check (slug ~ '^[a-z0-9-]{1,32}$'),
  reason      text,
  created_by  uuid references gftvhello_users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Domains no link may point at, including any subdomain of them. Checked when
-- a link is saved and again when a page is served.
create table if not exists gftvonelink_blocked_domains (
  domain      text primary key check (domain ~ '^[a-z0-9.-]{3,253}$'),
  reason      text,
  created_by  uuid references gftvhello_users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  action      text not null,
  details     jsonb not null default '{}'::jsonb,
  actor_type  text not null default 'system'
                check (actor_type in ('owner', 'staff', 'visitor', 'system')),
  actor_id    uuid,
  page_id     uuid,
  ip_hash     text,
  created_at  timestamptz not null default now()
);

create index if not exists gftvonelink_audit_logs_created_idx
  on gftvonelink_audit_logs (created_at desc);

create index if not exists gftvonelink_audit_logs_action_idx
  on gftvonelink_audit_logs (action, created_at desc);

create index if not exists gftvonelink_audit_logs_page_idx
  on gftvonelink_audit_logs (page_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Rate limiting, shared across every function instance
-- ---------------------------------------------------------------------------

create table if not exists gftvonelink_rate_limits (
  bucket        text primary key,
  hits          integer not null default 0,
  window_start  timestamptz not null default now()
);

create index if not exists gftvonelink_rate_limits_window_idx
  on gftvonelink_rate_limits (window_start);

-- Count one hit against a bucket and return the total inside the current
-- window. Atomic, so two instances cannot both read 4 and both allow a fifth.
create or replace function gftvonelink_rate_hit(p_bucket text, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
  insert into gftvonelink_rate_limits as r (bucket, hits, window_start)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
    set hits = case
                 when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
                 else r.hits + 1
               end,
        window_start = case
                         when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
                         else r.window_start
                       end
  returning hits into v_hits;
  return v_hits;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers the API calls through RPC
-- ---------------------------------------------------------------------------

-- Count a click on a link that is actually being served. Returns whether it
-- counted, so a click on a hidden or removed link is not recorded.
create or replace function gftvonelink_link_click(p_link_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update gftvonelink_links l
     set click_count = l.click_count + 1
    from gftvonelink_pages p
   where l.id = p_link_id
     and p.id = l.page_id
     and p.status = 'active'
     and l.is_active
     and l.removed_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- Rewrite order_index for a page's links in one statement, in the order given.
-- Ids that do not belong to the page are ignored.
create or replace function gftvonelink_reorder_links(p_page_id uuid, p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update gftvonelink_links l
     set order_index = o.ord - 1,
         updated_at = now()
    from unnest(p_ids) with ordinality as o(id, ord)
   where l.id = o.id
     and l.page_id = p_page_id;
$$;

-- Keep updated_at honest without every API route remembering to set it.
create or replace function gftvonelink_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists gftvonelink_pages_touch on gftvonelink_pages;
create trigger gftvonelink_pages_touch
  before update on gftvonelink_pages
  for each row execute function gftvonelink_touch_updated_at();

drop trigger if exists gftvonelink_links_touch on gftvonelink_links;
create trigger gftvonelink_links_touch
  before update of title, url, order_index, icon, is_active, removed_at on gftvonelink_links
  for each row execute function gftvonelink_touch_updated_at();

-- The RPC helpers are for the service role only.
revoke all on function gftvonelink_rate_hit(text, integer) from public, anon, authenticated;
revoke all on function gftvonelink_link_click(uuid) from public, anon, authenticated;
revoke all on function gftvonelink_reorder_links(uuid, uuid[]) from public, anon, authenticated;
grant execute on function gftvonelink_rate_hit(text, integer) to service_role;
grant execute on function gftvonelink_link_click(uuid) to service_role;
grant execute on function gftvonelink_reorder_links(uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Row level security: on everywhere, no policies, service role only
-- ---------------------------------------------------------------------------

alter table gftvonelink_pages                enable row level security;
alter table gftvonelink_links                enable row level security;
alter table gftvonelink_passkeys             enable row level security;
alter table gftvonelink_recovery_codes       enable row level security;
alter table gftvonelink_sessions             enable row level security;
alter table gftvonelink_staff_sessions       enable row level security;
alter table gftvonelink_staff_passkeys       enable row level security;
alter table gftvonelink_auth_challenges      enable row level security;
alter table gftvonelink_webauthn_challenges  enable row level security;
alter table gftvonelink_telegram_links       enable row level security;
alter table gftvonelink_reports              enable row level security;
alter table gftvonelink_blocked_slugs        enable row level security;
alter table gftvonelink_blocked_domains      enable row level security;
alter table gftvonelink_audit_logs           enable row level security;
alter table gftvonelink_rate_limits          enable row level security;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop function if exists gftvonelink_reorder_links(uuid, uuid[]);
-- drop function if exists gftvonelink_link_click(uuid);
-- drop function if exists gftvonelink_rate_hit(text, integer);
-- drop table if exists gftvonelink_rate_limits, gftvonelink_audit_logs,
--   gftvonelink_blocked_domains, gftvonelink_blocked_slugs, gftvonelink_reports,
--   gftvonelink_telegram_links, gftvonelink_webauthn_challenges,
--   gftvonelink_auth_challenges, gftvonelink_staff_passkeys,
--   gftvonelink_staff_sessions, gftvonelink_sessions,
--   gftvonelink_recovery_codes, gftvonelink_passkeys, gftvonelink_links,
--   gftvonelink_pages;
-- drop function if exists gftvonelink_touch_updated_at();
-- commit;
