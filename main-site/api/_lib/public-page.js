// Loading a page the way a visitor sees it. Shared by the JSON route and the
// server-rendered /<slug> route.

import { db, T } from './supabase.js';
import { normaliseSlug, isDormant } from './validate.js';
import { blockLists } from './guards.js';
import { publicPage } from './serialize.js';

// { state: "active", page } | { state: "banned" | "dormant" | "review", slug }
// | { state: "missing" }. Dormant: live, but the owner has not signed in for
// a year, so it is not shown until they do. Review: its name is on the staff
// review list and nobody has approved it yet.
export async function loadPublicPage(slugInput) {
  const slug = normaliseSlug(slugInput);
  if (!/^[a-z0-9-]{2,32}$/.test(slug)) return { state: 'missing' };

  const { data: page, error } = await db()
    .from(T.pages)
    .select('id, slug, display_name, bio, avatar_path, status, redirect_url, last_sign_in_at, needs_review, reviewed_at, quarantined_at')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!page || page.status === 'pending') return { state: 'missing' };
  if (page.status === 'banned') return { state: 'banned', slug: page.slug };
  // Quarantined pages read the same as ones awaiting approval: being checked.
  if ((page.needs_review && !page.reviewed_at) || page.quarantined_at) return { state: 'review', slug: page.slug };
  if (isDormant(page.last_sign_in_at)) return { state: 'dormant', slug: page.slug };

  const [{ data: links, error: linkError }, blocked] = await Promise.all([
    db()
      .from(T.links)
      .select('id, title, url, icon, order_index, is_active, removed_at')
      .eq('page_id', page.id)
      .eq('is_active', true)
      .is('removed_at', null),
    blockLists(),
  ]);
  if (linkError) throw linkError;
  return { state: 'active', page: publicPage(page, links, blocked) };
}
