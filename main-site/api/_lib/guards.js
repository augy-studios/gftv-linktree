// Rate limits, the audit log, and the staff block lists. Small, and used by
// almost every route.

import { db, T } from './supabase.js';
import { fail, clientIp } from './http.js';
import { hashIp } from './crypto.js';

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

// One row per security-relevant event. Details never carry a secret, a code,
// a password or a full address.
export async function audit(req, { action, actorType = 'system', actorId = null, pageId = null, details = {} }) {
  const { error } = await db().from(T.audit).insert({
    action,
    actor_type: actorType,
    actor_id: actorId,
    page_id: pageId,
    details,
    ip_hash: req ? hashIp(clientIp(req)) : null,
  });
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

export async function slugIsBlocked(slug) {
  const { data, error } = await db().from(T.blockedSlugs).select('slug').eq('slug', slug).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
