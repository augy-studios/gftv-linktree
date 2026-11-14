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

import { database, TABLES } from './supabase.js';
import { MAX_LINKS } from './validate.js';

export const DEFAULT_LINK_CAP = 20;
const SETTING = 'links_cap';

// What PostgREST says when a table or column is not there yet: the code is
// deployed but migration 013 has not been run. Reads fall back to the
// default rather than breaking the editor.
const MISSING = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205']);
export function missingSchema(error) {
  if (error && MISSING.has(error.code)) {
    return true;
  }
  return false;
}

// A whole number from 1 to MAX_LINKS, from a number or a string of digits,
// or null.
export function checkCap(value) {
  let cap = NaN;
  if (typeof value === 'number') {
    cap = value;
  } else if (typeof value === 'string' && /^\s*\d{1,4}\s*$/.test(value)) {
    cap = Number(value);
  }
  if (Number.isInteger(cap) && cap >= 1 && cap <= MAX_LINKS) {
    return cap;
  }
  return null;
}

// The links that count towards the limit.
export function linksUsed(links) {
  let list = [];
  if (links !== null && links !== undefined) {
    list = links;
  }
  return list.filter((link) => !link.removed_at).length;
}

export async function defaultLinkCap() {
  const { data, error } = await database().from(TABLES.settings).select('value').eq('key', SETTING).maybeSingle();
  if (error) {
    if (missingSchema(error)) {
      return DEFAULT_LINK_CAP;
    }
    throw error;
  }
  let stored;
  if (data !== null && data !== undefined) {
    stored = data.value;
  }
  const cap = checkCap(stored);
  if (cap === null || cap === undefined) {
    return DEFAULT_LINK_CAP;
  }
  return cap;
}

export async function setDefaultLinkCap(cap, staffId) {
  const { error } = await database()
    .from(TABLES.settings)
    .upsert({ key: SETTING, value: cap, updated_by: staffId, updated_at: new Date().toISOString() });
  if (error) {
    throw error;
  }
}

// The page's own limit, or null when it follows the default.
async function pageOverride(pageId) {
  const { data, error } = await database().from(TABLES.pages).select('links_cap').eq('id', pageId).maybeSingle();
  if (error) {
    if (missingSchema(error)) {
      return null;
    }
    throw error;
  }
  let stored;
  if (data !== null && data !== undefined) {
    stored = data.links_cap;
  }
  return checkCap(stored);
}

// { limit, override, defaultCap } for one page.
export async function linkCapFor(pageId) {
  const [override, defaultCap] = await Promise.all([pageOverride(pageId), defaultLinkCap()]);
  let limit = defaultCap;
  if (override !== null && override !== undefined) {
    limit = override;
  }
  return { limit, override, defaultCap };
}

// The database trigger's refusal, as supabase-js reports it.
export function isCapRefusal(error) {
  if (!error) {
    return false;
  }
  let message = '';
  if (error.message) {
    message = error.message;
  }
  return /too_many_links/.test(String(message));
}

export const REQUEST_COLUMNS = 'id, page_id, requested_cap, current_cap, reason, status, granted_cap, review_note, reviewed_at, created_at';

// The page's open request if it has one, else its most recent, whatever an
// admin decided; null if it never asked.
export async function latestCapRequest(pageId) {
  const { data, error } = await database()
    .from(TABLES.linkCapRequests)
    .select(REQUEST_COLUMNS)
    .eq('page_id', pageId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    if (missingSchema(error)) {
      return null;
    }
    throw error;
  }
  let rows = [];
  if (data !== null && data !== undefined) {
    rows = data;
  }
  const pending = rows.find((row) => row.status === 'pending');
  if (pending !== null && pending !== undefined) {
    return pending;
  }
  // Newest first, so the first row is the most recent.
  const newest = rows[0];
  if (newest !== null && newest !== undefined) {
    return newest;
  }
  return null;
}
