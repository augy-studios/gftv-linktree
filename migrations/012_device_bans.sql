-- 012_device_bans.sql
--
-- Run once in the Supabase SQL editor, after 011. Ties banned connections
-- (009) to the devices used on them, so someone banned who comes back on
-- another connection can be spotted.
--
-- The sign-up, sign-in, password reset and editor pages work out a device
-- fingerprint in the browser (FingerprintJS) and send it with their API
-- calls. Only a salted hash of it is kept, made the way the address hash is
-- (sha256 of IP_HASH_SALT:value), never the fingerprint itself:
--
--   - visitor_hash on the audit log, next to ip_hash. The daily cleanup
--     clears it from entries older than 30 days.
--   - gftvonelink_visitor_bans: when a connection is banned, the devices seen
--     on it in the audit log are banned with it, and unbanning the connection
--     lifts them. A banned device on a connection that is not banned is not
--     banned automatically: it is flagged for staff and cannot create a page,
--     but can still sign in and edit an existing one.
--
-- This file is never edited after it has been run. Changes go in 013 onwards.

begin;

alter table gftvonelink_audit_logs
  add column if not exists visitor_hash text
    check (visitor_hash is null or visitor_hash ~ '^[0-9a-f]{64}$');

-- The devices seen on a connection, when it is banned.
create index if not exists gftvonelink_audit_logs_ip_visitor_idx
  on gftvonelink_audit_logs (ip_hash)
  where visitor_hash is not null;

create table if not exists gftvonelink_visitor_bans (
  visitor_hash  text not null check (visitor_hash ~ '^[0-9a-f]{64}$'),
  -- The banned connection it was seen on. One row per device and
  -- connection, so lifting one connection's ban leaves the others.
  ip_hash       text not null references gftvonelink_ip_bans (ip_hash) on delete cascade,
  reason        text check (reason is null or char_length(reason) <= 500),
  -- Null when the system banned it automatically.
  created_by    uuid references gftvhello_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (visitor_hash, ip_hash)
);

create index if not exists gftvonelink_visitor_bans_ip_idx
  on gftvonelink_visitor_bans (ip_hash);

alter table gftvonelink_visitor_bans enable row level security;

commit;

-- Rollback:
--
-- begin;
-- drop table if exists gftvonelink_visitor_bans;
-- drop index if exists gftvonelink_audit_logs_ip_visitor_idx;
-- alter table gftvonelink_audit_logs drop column if exists visitor_hash;
-- commit;
