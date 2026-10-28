// Rate limits, the audit log, the staff block lists (names, domains and
// patterns) and the domains staff allow past the threat lists. Small, and
// used by almost every route.

import { db, T } from './supabase.js';
import { fail, clientIp, clientVisitor } from './http.js';
import { hashIp, hashVisitor } from './crypto.js';
import { sanitizeUrl, addressBlocked, patternBlocks, isShortener, addressesInText, linkHost, lookupUrl, hostIsBlocked } from './validate.js';
import { unsafeUrls } from './safe-browsing.js';
import { blocklistCategory } from './domain-blocklist.js';
import { missingSchema } from './link-cap.js';

// The error an owner sees for each blocklist category.
const LIST_ERRORS = { unsafe: 'url_unsafe', gambling: 'url_gambling', adult: 'url_adult', piracy: 'url_piracy', shortener: 'url_shortener' };

// name: [hits allowed, window in seconds]
export const LIMITS = Object.freeze({
  slugCheck: [60, 60],
  register: [5, 3600],
  login: [10, 900],
  loginSubject: [10, 900],
  secondFactor: [10, 900],
  telegramSend: [3, 900],
  recover: [5, 3600],
  ownerWrite: [120, 60],
  avatar: [20, 3600],
  click: [30, 60],
  report: [5, 3600],
  staffLogin: [8, 900],
  staffWrite: [240, 60],
  visit: [120, 60],
  ownerRead: [120, 60],
  // Asking for a higher link limit, per page and per connection. Only one
  // can be open at a time anyway; this stops ask, withdraw, ask again.
  capRequest: [10, 86400],
});

// Count one hit for each subject and answer 429 if any is over. Returns true
// when the request has been answered. A failure of the limiter itself lets
// the request through, so a database hiccup does not lock everybody out.
export async function limited(req, res, name, subjects = []) {
  const [max, windowSeconds] = LIMITS[name];
  const keys = [`${name}:ip:${hashIp(clientIp(req))}`, ...subjects.map((s) => `${name}:${s}`)];
  try {
    for (const bucket of keys) {
      const { data, error } = await db().rpc('gftvonelink_rate_hit', {
        p_bucket: bucket,
        p_window_seconds: windowSeconds,
      });
      if (error) throw error;
      if (Number(data) > max) {
        res.setHeader('Retry-After', String(windowSeconds));
        fail(res, 429, 'rate_limited');
        return true;
      }
    }
  } catch (cause) {
    console.error('[onelink] rate limiter:', cause?.message ?? cause);
  }
  return false;
}

// The hash of the device fingerprint a request carries, or null. Only the
// sign-up, sign-in and editor pages send one (js/visitor.js).
export function visitorHash(req) {
  const visitor = req ? clientVisitor(req) : '';
  return visitor ? hashVisitor(visitor) : null;
}

// One row per security-relevant event. Details never carry a secret, a code,
// a password or a full address. The device hash goes next to the address
// hash when the request has one (migration 012), so a ban on the connection
// can take the devices used on it too.
export async function audit(req, { action, actorType = 'system', actorId = null, pageId = null, details = {} }) {
  const row = {
    action,
    actor_type: actorType,
    actor_id: actorId,
    page_id: pageId,
    details,
    ip_hash: req ? hashIp(clientIp(req)) : null,
  };
  const visitor = visitorHash(req);
  if (visitor) row.visitor_hash = visitor;
  let { error } = await db().from(T.audit).insert(row);
  // Before migration 012 there is no visitor_hash column: keep the entry.
  if (error && visitor) {
    delete row.visitor_hash;
    ({ error } = await db().from(T.audit).insert(row));
  }
  if (error) console.error('[onelink] audit insert:', action, error.message);
}

let domainCache = { at: 0, list: [] };

// Blocked domains, cached per instance for a minute. A newly blocked domain
// takes at most that long to stop being served.
export async function blockedDomains() {
  if (Date.now() - domainCache.at < 60_000) return domainCache.list;
  const { data, error } = await db().from(T.blockedDomains).select('domain');
  if (error) {
    console.error('[onelink] blocked domains:', error.message);
    return domainCache.list;
  }
  domainCache = { at: Date.now(), list: (data ?? []).map((r) => r.domain) };
  return domainCache.list;
}

export function forgetBlockedDomains() {
  domainCache = { at: 0, list: [] };
}

let patternCache = { at: 0, list: [] };

// Staff block patterns, compiled, cached per instance for a minute like the
// domains. A pattern that no longer compiles is skipped rather than
// blocking everything.
export async function blockedPatterns() {
  if (Date.now() - patternCache.at < 60_000) return patternCache.list;
  const { data, error } = await db().from(T.blockedPatterns).select('id, pattern, applies_to');
  if (error) {
    console.error('[onelink] blocked patterns:', error.message);
    return patternCache.list;
  }
  const list = [];
  for (const row of data ?? []) {
    try {
      list.push({ id: row.id, re: new RegExp(row.pattern, 'i'), appliesTo: row.applies_to });
    } catch {
      console.warn('[onelink] blocked pattern does not compile:', row.id);
    }
  }
  patternCache = { at: Date.now(), list };
  return list;
}

export function forgetBlockedPatterns() {
  patternCache = { at: 0, list: [] };
}

// Both lists at once, for serving a page: { domains, patterns }.
export async function blockLists() {
  const [domains, patterns] = await Promise.all([blockedDomains(), blockedPatterns()]);
  return { domains, patterns };
}

let allowedCache = { at: 0, list: [] };

// Domains staff vouch for (migration 014), cached per instance for a minute
// like the blocked ones. Before 014 is run there are none.
export async function allowedDomains() {
  if (Date.now() - allowedCache.at < 60_000) return allowedCache.list;
  const { data, error } = await db().from(T.allowedDomains).select('domain');
  if (error) {
    if (missingSchema(error)) {
      allowedCache = { at: Date.now(), list: [] };
    } else {
      console.error('[onelink] allowed domains:', error.message);
    }
    return allowedCache.list;
  }
  allowedCache = { at: Date.now(), list: (data ?? []).map((r) => r.domain) };
  return allowedCache.list;
}

export function forgetAllowedDomains() {
  allowedCache = { at: 0, list: [] };
}

// True when host is an allowed domain or a subdomain of one. Such a host
// skips the threat lists (HaGeZi and Safe Browsing), never the staff lists.
export async function domainAllowed(host) {
  return hostIsBlocked(host, await allowedDomains());
}

// A link or redirect address an owner is saving: { ok, url, host } or
// { ok: false, error }. { mail: true } lets it be an email address, for
// links but never a redirect. Refused: generic shorteners (validate.js),
// anything on the staff block lists, any domain on the HaGeZi blocklists
// (domain-blocklist.js: harmful sites, gambling, adult, piracy, shorteners), and
// anything Google Safe Browsing lists, when that check is switched on
// (safe-browsing.js). A domain staff have allowed skips those last two. An
// email address is checked by its domain.
export async function checkLinkUrl(input, { mail = false } = {}) {
  const check = sanitizeUrl(input, { mail });
  if (!check.ok) return check;
  if (!check.mail && isShortener(check.host)) return { ok: false, error: 'url_shortener' };
  if (addressBlocked(check.url, await blockLists())) return { ok: false, error: 'url_blocked' };
  if (await domainAllowed(check.host)) return check;
  const listed = await blocklistCategory(check.host);
  if (listed) return { ok: false, error: LIST_ERRORS[listed] };
  const probe = lookupUrl(check.url);
  if ((await unsafeUrls([probe])).has(probe)) return { ok: false, error: 'url_unsafe' };
  return check;
}

let reviewCache = { at: 0, list: [] };

// Names that need a staff member's approval before the page goes live
// (migration 004), compiled and cached like the block patterns.
export async function reviewPatterns() {
  if (Date.now() - reviewCache.at < 60_000) return reviewCache.list;
  const { data, error } = await db().from(T.reviewPatterns).select('id, pattern');
  if (error) {
    console.error('[onelink] review patterns:', error.message);
    return reviewCache.list;
  }
  const list = [];
  for (const row of data ?? []) {
    try {
      list.push({ id: row.id, re: new RegExp(row.pattern, 'i'), appliesTo: 'names' });
    } catch {
      console.warn('[onelink] review pattern does not compile:', row.id);
    }
  }
  reviewCache = { at: Date.now(), list };
  return list;
}

export function forgetReviewPatterns() {
  reviewCache = { at: 0, list: [] };
}

export async function nameNeedsReview(slug) {
  return patternBlocks(slug, await reviewPatterns(), 'names');
}

// The first address written into text that would be refused as a link, as
// { host, error }, or null. For bios, display names and link titles: there an
// address is not a link, but a visitor could still type it in, so the same
// lists apply.
export async function addressRefusedInText(...texts) {
  const found = addressesInText(texts.filter(Boolean).join('\n'));
  if (found.length === 0) return null;
  const lists = await blockLists();
  const unvouched = [];
  for (const { host, url } of found) {
    if (isShortener(host)) return { host, error: 'url_shortener' };
    if (addressBlocked(url, lists)) return { host, error: 'url_blocked' };
    if (await domainAllowed(host)) continue;
    const listed = await blocklistCategory(host);
    if (listed) return { host, error: LIST_ERRORS[listed] };
    unvouched.push({ host, url });
  }
  const unsafe = await unsafeUrls(unvouched.map((f) => f.url));
  const bad = unvouched.find((f) => unsafe.has(f.url));
  return bad ? { host: bad.host, error: 'url_unsafe' } : null;
}

// Why a well-formed page name cannot be registered, or null when it can:
// staff blocked it by name, or a staff pattern for names matches it.
export async function slugRefusal(slug) {
  if (await slugIsBlocked(slug)) return 'slug_reserved';
  if (patternBlocks(slug, await blockedPatterns(), 'names')) return 'slug_not_allowed';
  return null;
}

// ---------------------------------------------------------------------------
// Repeated attempts at harmful addresses
//
// A refusal for one of these reasons counts against the page and against the
// connection, for a day. Three on one page quarantine it (hidden, reported to
// staff, released by them); five from one connection flag it, and it cannot
// save addresses until the day is up. Typos and shortened links do not count.
// ---------------------------------------------------------------------------

export const SUSPICIOUS_LINK_ERRORS = new Set(['url_unsafe', 'url_blocked', 'url_gambling', 'url_adult', 'url_piracy', 'url_scheme', 'url_scheme_link', 'url_credentials']);
export const QUARANTINE_AFTER = 3;
export const IP_FLAG_AFTER = 5;
const SUSPICION_WINDOW = 86400;

const ipBucket = (req) => `badlink:ip:${hashIp(clientIp(req))}`;

async function bump(bucket) {
  const { data, error } = await db().rpc('gftvonelink_rate_hit', { p_bucket: bucket, p_window_seconds: SUSPICION_WINDOW });
  if (error) throw error;
  return Number(data) || 0;
}

// Whether this connection has been flagged today. Answers 429 when it has.
export async function refusedForAttempts(req, res) {
  const { data, error } = await db().from('gftvonelink_rate_limits').select('hits, window_start').eq('bucket', ipBucket(req)).maybeSingle();
  if (error) {
    console.error('[onelink] flagged check:', error.message);
    return false;
  }
  const live = data && Date.now() - new Date(data.window_start).getTime() < SUSPICION_WINDOW * 1000;
  if (live && data.hits >= IP_FLAG_AFTER) {
    res.setHeader('Retry-After', String(SUSPICION_WINDOW));
    fail(res, 429, 'too_many_refused_links');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Banned connections (migration 009) and devices (migration 012)
//
// A second page quarantined from the same connection bans it. A banned
// connection cannot create or change pages; it can still view, sign in and
// report. Bans last until staff lift them.
//
// The devices seen on a connection (the device hash in its audit entries)
// are banned with it, and lifted with it. A banned device on a connection
// that is not banned is never banned automatically: device fingerprints are
// not unique, and many phones of one model look alike. It is flagged for
// staff for the day, and cannot create a page; it can still sign in and edit
// one it has.
// ---------------------------------------------------------------------------

export const BAN_AFTER_PAGES = 2;

// Answers 403 and returns true when this request comes from a banned
// connection, or, with newPage, from a banned device. For every route that
// creates or changes a page; pageId is the page being changed, for staff.
export async function refusedForBan(req, res, { newPage = false, pageId = null } = {}) {
  const { data, error } = await db().from(T.ipBans).select('ip_hash').eq('ip_hash', hashIp(clientIp(req))).maybeSingle();
  if (error) {
    console.error('[onelink] ban check:', error.message);
    return false;
  }
  if (data) {
    fail(res, 403, 'ip_banned');
    return true;
  }
  if ((await noteBannedVisitor(req, pageId)) && newPage) {
    fail(res, 403, 'visitor_banned');
    return true;
  }
  return false;
}

const visitorBucket = (visitor, ip) => `badvisitor:${visitor}:${ip}`;

// Whether this request's device is banned. When it is, the device and this
// connection are flagged for staff for the day, and the first sighting goes
// in the audit log. Never refuses anything itself, and a database error
// counts as not banned.
export async function noteBannedVisitor(req, pageId = null) {
  const visitor = visitorHash(req);
  if (!visitor) return false;
  const { data, error } = await db().from(T.visitorBans).select('visitor_hash').eq('visitor_hash', visitor).limit(1);
  if (error) {
    console.error('[onelink] device ban check:', error.message);
    return false;
  }
  if ((data ?? []).length === 0) return false;
  try {
    if ((await bump(visitorBucket(visitor, hashIp(clientIp(req))))) === 1) {
      await audit(req, { action: 'security.visitor_flagged', actorType: 'system', pageId });
    }
  } catch (cause) {
    console.error('[onelink] device flag:', cause?.message ?? cause);
  }
  return true;
}

async function banHash(hash, { reason, pageIds = [], staffId = null }) {
  const { error } = await db().from(T.ipBans).upsert({ ip_hash: hash, reason, page_ids: pageIds, created_by: staffId });
  if (error) throw error;
  await banVisitorsOf(hash, { reason, staffId });
}

// Ban the devices seen on a connection that has just been banned. A failure
// here leaves the connection's ban in place.
async function banVisitorsOf(hash, { reason, staffId }) {
  try {
    const { data, error } = await db().from(T.audit).select('visitor_hash').eq('ip_hash', hash).not('visitor_hash', 'is', null);
    if (error) throw error;
    const visitors = [...new Set((data ?? []).map((r) => r.visitor_hash))];
    if (visitors.length === 0) return;
    const rows = visitors.map((visitor) => ({ visitor_hash: visitor, ip_hash: hash, reason, created_by: staffId }));
    const { error: banError } = await db().from(T.visitorBans).upsert(rows, { onConflict: 'visitor_hash,ip_hash' });
    if (banError) throw banError;
  } catch (cause) {
    console.error('[onelink] device bans:', cause?.message ?? cause);
  }
}

// After a page is quarantined: ban the connection if it is now the second.
async function banIfRepeat(req, hash) {
  const { data, error } = await db().from(T.audit).select('page_id').eq('action', 'mod.page_quarantined').eq('ip_hash', hash);
  if (error) throw error;
  const pages = [...new Set((data ?? []).map((r) => r.page_id).filter(Boolean))];
  if (pages.length < BAN_AFTER_PAGES) return;
  await banHash(hash, { reason: `${pages.length} pages quarantined from this connection`, pageIds: pages });
  await audit(req, { action: 'security.ip_banned', actorType: 'system', details: { pages: pages.length } });
}

// Banned connections, newest first: [{ id, reason, since, slugs, byStaff,
// devices }], devices being how many devices were banned with it.
export async function bannedConnections() {
  const { data, error } = await db().from(T.ipBans).select('ip_hash, reason, page_ids, created_by, created_at').order('created_at', { ascending: false });
  if (error) throw error;
  const devices = new Map();
  if ((data ?? []).length > 0) {
    const { data: bans, error: deviceError } = await db().from(T.visitorBans).select('ip_hash').in('ip_hash', data.map((b) => b.ip_hash));
    if (deviceError) console.error('[onelink] device bans:', deviceError.message);
    for (const ban of bans ?? []) devices.set(ban.ip_hash, (devices.get(ban.ip_hash) ?? 0) + 1);
  }
  const rows = [];
  for (const ban of data ?? []) {
    let slugs = [];
    if ((ban.page_ids ?? []).length > 0) {
      const { data: pages, error: pageError } = await db().from(T.pages).select('slug').in('id', ban.page_ids);
      if (pageError) throw pageError;
      slugs = (pages ?? []).map((p) => p.slug);
    }
    rows.push({ id: ban.ip_hash.slice(0, 16), reason: ban.reason, since: ban.created_at, slugs, byStaff: Boolean(ban.created_by), devices: devices.get(ban.ip_hash) ?? 0 });
  }
  return rows;
}

// Ban a connection staff can see flagged, by the start of its hash.
export async function banFlaggedConnection(id, staffId, reason) {
  if (!/^[0-9a-f]{16}$/.test(String(id))) return false;
  const { data, error } = await db().from('gftvonelink_rate_limits').select('bucket').like('bucket', `badlink:ip:${id}%`).limit(1);
  if (error) throw error;
  if (!data?.[0]) return false;
  await banHash(data[0].bucket.slice('badlink:ip:'.length), { reason: reason || 'Banned by staff', staffId });
  return true;
}

// Lift a connection's ban, and the bans on the devices seen on it.
export async function unbanConnection(id) {
  if (!/^[0-9a-f]{16}$/.test(String(id))) return false;
  const { data, error } = await db().from(T.ipBans).delete().like('ip_hash', `${id}%`).select('ip_hash');
  if (error) throw error;
  const hashes = (data ?? []).map((r) => r.ip_hash);
  if (hashes.length === 0) return false;
  // The table's foreign key does this too; this covers a database without it.
  const { error: deviceError } = await db().from(T.visitorBans).delete().in('ip_hash', hashes);
  if (deviceError) console.error('[onelink] device unban:', deviceError.message);
  return true;
}

// Devices from a banned connection seen today on one that is not banned,
// newest first: [{ id, device, connection, requests, since, slug }]. id is
// the start of the device hash and then of the connection hash, as the
// actions below take it; slug is the page it was last seen on, if any.
export async function flaggedVisitors() {
  const since = new Date(Date.now() - SUSPICION_WINDOW * 1000).toISOString();
  const { data, error } = await db().from('gftvonelink_rate_limits').select('bucket, hits, window_start').like('bucket', 'badvisitor:%').gte('window_start', since);
  if (error) throw error;
  const rows = [];
  for (const row of data ?? []) {
    const [, visitor, ip] = row.bucket.split(':');
    const { data: last, error: auditError } = await db()
      .from(T.audit)
      .select('page_id, created_at')
      .eq('action', 'security.visitor_flagged')
      .eq('visitor_hash', visitor)
      .eq('ip_hash', ip)
      .order('created_at', { ascending: false })
      .limit(1);
    if (auditError) throw auditError;
    let slug = null;
    if (last?.[0]?.page_id) {
      const { data: page } = await db().from(T.pages).select('slug').eq('id', last[0].page_id).maybeSingle();
      slug = page?.slug ?? null;
    }
    const device = visitor.slice(0, 16);
    const connection = ip.slice(0, 16);
    rows.push({ id: device + connection, device, connection, requests: row.hits, since: row.window_start, slug });
  }
  return rows.sort((a, b) => (a.since < b.since ? 1 : -1));
}

function flaggedVisitorBuckets(id) {
  if (!/^[0-9a-f]{32}$/.test(String(id))) return null;
  return `badvisitor:${id.slice(0, 16)}%:${id.slice(16)}%`;
}

// Staff found the flagged device is not the banned person (one phone model
// looks much like another): lift the flag and the device's bans, so it can
// create pages again. Its connections stay banned. True when it was flagged.
export async function unflagVisitor(id) {
  const pattern = flaggedVisitorBuckets(id);
  if (!pattern) return false;
  const { data, error } = await db().from('gftvonelink_rate_limits').delete().like('bucket', pattern).select('bucket');
  if (error) throw error;
  if ((data ?? []).length === 0) return false;
  const { error: unbanError } = await db().from(T.visitorBans).delete().like('visitor_hash', `${id.slice(0, 16)}%`);
  if (unbanError) throw unbanError;
  return true;
}

// Staff found it is the banned person: ban the connection it was flagged on,
// which bans the devices seen there too. True when it was flagged.
export async function banFlaggedVisitor(id, staffId, reason) {
  const pattern = flaggedVisitorBuckets(id);
  if (!pattern) return false;
  const { data, error } = await db().from('gftvonelink_rate_limits').select('bucket').like('bucket', pattern).limit(1);
  if (error) throw error;
  if (!data?.[0]) return false;
  const [, , ip] = data[0].bucket.split(':');
  await banHash(ip, { reason: reason || 'Banned by staff: a device from a banned connection', staffId });
  const { error: clearError } = await db().from('gftvonelink_rate_limits').delete().eq('bucket', data[0].bucket);
  if (clearError) throw clearError;
  return true;
}

// Connections flagged today, newest first, for staff to look at and lift:
// [{ id, attempts, since, slug }]. id is the start of the stored hash of the
// address (the address itself is never kept), enough to tell them apart.
export async function flaggedConnections() {
  const since = new Date(Date.now() - SUSPICION_WINDOW * 1000).toISOString();
  const { data, error } = await db()
    .from('gftvonelink_rate_limits')
    .select('bucket, hits, window_start')
    .like('bucket', 'badlink:ip:%')
    .gte('hits', IP_FLAG_AFTER)
    .gte('window_start', since);
  if (error) throw error;
  const rows = [];
  for (const row of data ?? []) {
    const hash = row.bucket.slice('badlink:ip:'.length);
    const { data: last, error: auditError } = await db()
      .from(T.audit)
      .select('page_id, created_at')
      .eq('action', 'security.link_refused')
      .eq('ip_hash', hash)
      .order('created_at', { ascending: false })
      .limit(1);
    if (auditError) throw auditError;
    let slug = null;
    if (last?.[0]?.page_id) {
      const { data: page } = await db().from(T.pages).select('slug').eq('id', last[0].page_id).maybeSingle();
      slug = page?.slug ?? null;
    }
    rows.push({ id: hash.slice(0, 16), attempts: row.hits, since: row.window_start, slug });
  }
  return rows.sort((a, b) => (a.since < b.since ? 1 : -1));
}

// Lift a flag by the start of its hash, as flaggedConnections shows it.
// True when one was lifted.
export async function unflagConnection(id) {
  if (!/^[0-9a-f]{16}$/.test(String(id))) return false;
  const { data, error } = await db().from('gftvonelink_rate_limits').delete().like('bucket', `badlink:ip:${id}%`).select('bucket');
  if (error) throw error;
  return (data ?? []).length > 0;
}

// Forget a page's refused addresses for the day, so a page staff have
// released is not quarantined again by the next mistake.
export async function resetRefusedLinks(pageId) {
  const { error } = await db().from('gftvonelink_rate_limits').delete().eq('bucket', `badlink:page:${pageId}`);
  if (error) throw error;
}

// Count a refused address. Returns { quarantined } so the route can say so.
export async function noteRefusedLink(req, page, error, url) {
  if (!SUSPICIOUS_LINK_ERRORS.has(error)) return { quarantined: false };
  const host = linkHost(url) || String(url ?? '').slice(0, 80);
  let quarantined = false;
  try {
    const [pageHits, ipHits] = await Promise.all([bump(`badlink:page:${page.id}`), bump(ipBucket(req))]);
    await audit(req, { action: 'security.link_refused', actorType: 'owner', actorId: page.id, pageId: page.id, details: { error, host } });
    if (ipHits === IP_FLAG_AFTER) {
      await audit(req, { action: 'security.ip_flagged', actorType: 'system', pageId: page.id, details: { attempts: ipHits } });
    }
    if (pageHits >= QUARANTINE_AFTER) {
      const reason = `${pageHits} harmful addresses refused in a day, the last on ${host}`;
      const { data, error: updateError } = await db()
        .from(T.pages)
        .update({ quarantined_at: new Date().toISOString(), quarantine_reason: reason })
        .eq('id', page.id)
        .is('quarantined_at', null)
        .select('id');
      if (updateError) throw updateError;
      quarantined = (data ?? []).length === 1;
      if (quarantined) {
        await db().from(T.reports).insert({ page_id: page.id, reason: 'scam', details: `Automatic: ${reason}.` });
        await audit(req, { action: 'mod.page_quarantined', actorType: 'system', pageId: page.id, details: { reason } });
        await banIfRepeat(req, hashIp(clientIp(req)));
      }
    }
  } catch (cause) {
    console.error('[onelink] refused link bookkeeping:', cause?.message ?? cause);
  }
  return { quarantined };
}

// True the first time a bucket is hit inside its window, false after. For
// counting a visit once per visitor and page per half hour, not for refusing
// anything, so a failure of the limiter counts the visit.
export async function firstHit(bucket, windowSeconds) {
  try {
    const { data, error } = await db().rpc('gftvonelink_rate_hit', { p_bucket: bucket, p_window_seconds: windowSeconds });
    if (error) throw error;
    return Number(data) <= 1;
  } catch (cause) {
    console.error('[onelink] first hit:', cause?.message ?? cause);
    return true;
  }
}

export async function slugIsBlocked(slug) {
  const { data, error } = await db().from(T.blockedSlugs).select('slug').eq('slug', slug).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
