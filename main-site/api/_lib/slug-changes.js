// Page names that owners changed (migration 016).
//
// A rename holds the old name for SLUG_HOLD_DAYS: nobody else can register
// it or rename to it, and /<old name> sends visitors on to the page's name
// now. The page that had it can take it back. An owner can rename once every
// RENAME_COOLDOWN_DAYS.
//
// Before 016 is run nothing is held, and renaming answers
// rename_unavailable, because neither the hold nor the cooldown could be kept.

import { database, TABLES } from './supabase.js';
import { missingSchema } from './link-cap.js';

export const SLUG_HOLD_DAYS = 30;
export const RENAME_COOLDOWN_DAYS = 30;

const daysAgo = (days) => new Date(Date.now() - days * 86400_000).toISOString();

// The id of the page holding this old name, or null. A name the page holding
// it has taken back counts as that page's name, not as held.
export async function slugHeldBy(slug) {
  const { data, error } = await database()
    .from(TABLES.slugChanges)
    .select('page_id, created_at')
    .eq('old_slug', slug)
    .gte('created_at', daysAgo(SLUG_HOLD_DAYS))
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    if (missingSchema(error)) return null;
    throw error;
  }
  return data?.[0]?.page_id ?? null;
}

// Where /<slug> should go now, when slug is a held old name: the page's name
// now, or null.
export async function slugMovedTo(slug) {
  const pageId = await slugHeldBy(slug);
  if (!pageId) return null;
  const { data, error } = await database().from(TABLES.pages).select('slug, status').eq('id', pageId).maybeSingle();
  if (error) throw error;
  if (!data || data.status === 'pending' || data.slug === slug) return null;
  return data.slug;
}

// The page's latest rename, as { oldSlug, newSlug, at }, or null. Throws
// { code: 'rename_unavailable' } before migration 016 is run.
export async function lastRename(pageId) {
  const { data, error } = await database()
    .from(TABLES.slugChanges)
    .select('old_slug, new_slug, created_at')
    .eq('page_id', pageId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    if (missingSchema(error)) throw Object.assign(new Error('rename_unavailable'), { code: 'rename_unavailable' });
    throw error;
  }
  const row = data?.[0];
  return row ? { oldSlug: row.old_slug, newSlug: row.new_slug, at: row.created_at } : null;
}

// When the page may be renamed again, as an ISO date, or null for now.
export function nextRenameAt(last) {
  if (!last) return null;
  const next = new Date(last.at).getTime() + RENAME_COOLDOWN_DAYS * 86400_000;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

export async function recordRename({ pageId, oldSlug, newSlug, neededReview }) {
  const { error } = await database()
    .from(TABLES.slugChanges)
    .insert({ page_id: pageId, old_slug: oldSlug, new_slug: newSlug, needed_review: neededReview });
  if (error) throw error;
}

// For staff: each page's latest previous name, as Map(pageId -> { slug, at }).
// Empty before migration 016 is run.
export async function previousSlugs(pageIds) {
  const result = new Map();
  if (pageIds.length === 0) return result;
  const { data, error } = await database()
    .from(TABLES.slugChanges)
    .select('page_id, old_slug, created_at')
    .in('page_id', pageIds)
    .order('created_at', { ascending: false });
  if (error) {
    if (missingSchema(error)) return result;
    throw error;
  }
  for (const row of data ?? []) {
    if (!result.has(row.page_id)) result.set(row.page_id, { slug: row.old_slug, at: row.created_at });
  }
  return result;
}

// For the owner's editor: { available, nextAt, previous }. available is
// false before migration 016 is run; nextAt is when the next rename is
// allowed (null for now); previous is the last old name and the day its hold
// ends, while it is still held.
export async function ownerRenameState(pageId) {
  let last;
  try {
    last = await lastRename(pageId);
  } catch (cause) {
    if (cause.code === 'rename_unavailable') return { available: false, nextAt: null, previous: null };
    throw cause;
  }
  const heldUntil = last ? new Date(new Date(last.at).getTime() + SLUG_HOLD_DAYS * 86400_000) : null;
  return {
    available: true,
    nextAt: nextRenameAt(last),
    previous: heldUntil && heldUntil.getTime() > Date.now() ? { slug: last.oldSlug, heldUntil: heldUntil.toISOString() } : null,
  };
}
