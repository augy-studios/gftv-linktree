// How many links a page may have (migration 013).
//
// Admins set a default for every page (gftvonelink_settings, key links_cap)
// and can give any page its own limit (gftvonelink_pages.links_cap). A page's
// limit is its own one if set, else the default. Links staff have removed do
// not count; hidden ones do. A page over its limit keeps its links and just
// cannot add more.
//
// The API checks before inserting, and a trigger in the database checks again
// on every insert, with the page row locked, so two links added at the same
// moment cannot both get under the limit.

import { db, T } from './supabase.js';
import { MAX_LINKS } from './validate.js';

export const DEFAULT_LINK_CAP = 20;
const SETTING = 'links_cap';

// What PostgREST says when a table or column is not there yet: the code is
// deployed but migration 013 has not been run. Reads fall back to the
// default rather than breaking the editor.
const MISSING = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205']);
export function missingSchema(error) {
  return Boolean(error && MISSING.has(error.code));
}

// A whole number from 1 to MAX_LINKS, from a number or a string of digits,
// or null.
export function checkCap(value) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*\d{1,4}\s*$/.test(value)) n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LINKS ? n : null;
}

// The links that count towards the limit.
export function linksUsed(links) {
  return (links ?? []).filter((l) => !l.removed_at).length;
}

export async function defaultLinkCap() {
  const { data, error } = await db().from(T.settings).select('value').eq('key', SETTING).maybeSingle();
  if (error) {
    if (missingSchema(error)) return DEFAULT_LINK_CAP;
    throw error;
  }
  return checkCap(data?.value) ?? DEFAULT_LINK_CAP;
}

export async function setDefaultLinkCap(cap, staffId) {
  const { error } = await db()
    .from(T.settings)
    .upsert({ key: SETTING, value: cap, updated_by: staffId, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// The page's own limit, or null when it follows the default.
async function pageOverride(pageId) {
  const { data, error } = await db().from(T.pages).select('links_cap').eq('id', pageId).maybeSingle();
  if (error) {
    if (missingSchema(error)) return null;
    throw error;
  }
  return checkCap(data?.links_cap);
}

// { limit, override, defaultCap } for one page.
export async function linkCapFor(pageId) {
  const [override, defaultCap] = await Promise.all([pageOverride(pageId), defaultLinkCap()]);
  return { limit: override ?? defaultCap, override, defaultCap };
}

// The database trigger's refusal, as supabase-js reports it.
export function isCapRefusal(error) {
  return Boolean(error && /too_many_links/.test(String(error.message || '')));
}

export const REQUEST_COLUMNS = 'id, page_id, requested_cap, current_cap, reason, status, granted_cap, review_note, reviewed_at, created_at';

// The page's open request if it has one, else its most recent, whatever an
// admin decided; null if it never asked.
export async function latestCapRequest(pageId) {
  const { data, error } = await db()
    .from(T.linkCapRequests)
    .select(REQUEST_COLUMNS)
    .eq('page_id', pageId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    if (missingSchema(error)) return null;
    throw error;
  }
  return (data ?? []).find((r) => r.status === 'pending') ?? data?.[0] ?? null;
}
