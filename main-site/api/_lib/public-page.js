// Loading a page the way a visitor sees it. Shared by the JSON route and the
// server-rendered /<slug> route.

import { db, T } from './supabase.js';
import { normaliseSlug } from './validate.js';
import { blockedDomains } from './guards.js';
import { publicPage } from './serialize.js';

// { state: "active", page } | { state: "banned" } | { state: "missing" }
export async function loadPublicPage(slugInput) {
  const slug = normaliseSlug(slugInput);
  if (!/^[a-z0-9-]{2,32}$/.test(slug)) return { state: 'missing' };

  const { data: page, error } = await db()
    .from(T.pages)
    .select('id, slug, display_name, bio, status')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!page || page.status === 'pending') return { state: 'missing' };
  if (page.status === 'banned') return { state: 'banned', slug: page.slug };

  const [{ data: links, error: linkError }, blocked] = await Promise.all([
    db()
      .from(T.links)
      .select('id, title, url, icon, order_index, is_active, removed_at')
      .eq('page_id', page.id)
      .eq('is_active', true)
      .is('removed_at', null),
    blockedDomains(),
  ]);
  if (linkError) throw linkError;
  return { state: 'active', page: publicPage(page, links, blocked) };
}
