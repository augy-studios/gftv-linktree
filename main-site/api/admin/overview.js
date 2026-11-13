// GET /api/admin/overview   counts for the dashboard's first screen

import { route, guard, ok } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { requireStaff, publicStaff } from '../_lib/staff.js';

async function count(table, apply) {
  const { count: n, error } = await apply(database().from(table).select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return n ?? 0;
}

// Requests for more links, which any staff member can answer. Before
// migration 013 there is no such table, and the card is left out rather than
// the whole overview failing.
async function pendingLinkCaps() {
  try {
    return await count(TABLES.linkCapRequests, (q) => q.eq('status', 'pending'));
  } catch (cause) {
    console.error('[onelink] overview link caps:', cause?.message ?? cause);
    return undefined;
  }
}

export default route('admin/overview', async (request, response) => {
  if (guard(request, response, ['GET'])) return;
  const staff = await requireStaff(request, response);
  if (!staff) return;

  const [active, pending, banned, links, removed, openReports, awaitingReview, quarantined, pendingTestimonials, linkCapRequests] = await Promise.all([
    count(TABLES.pages, (q) => q.eq('status', 'active')),
    count(TABLES.pages, (q) => q.eq('status', 'pending')),
    count(TABLES.pages, (q) => q.eq('status', 'banned')),
    count(TABLES.links, (q) => q.is('removed_at', null)),
    count(TABLES.links, (q) => q.not('removed_at', 'is', null)),
    count(TABLES.reports, (q) => q.eq('status', 'open')),
    count(TABLES.pages, (q) => q.eq('needs_review', true).is('reviewed_at', null).neq('status', 'banned')),
    count(TABLES.pages, (q) => q.not('quarantined_at', 'is', null).neq('status', 'banned')),
    count(TABLES.testimonials, (q) => q.eq('status', 'pending')),
    pendingLinkCaps(),
  ]);

  ok(response, {
    staff: publicStaff(staff.user),
    counts: { active, pending, banned, links, removed, openReports, awaitingReview, quarantined, pendingTestimonials, linkCapRequests },
  });
});
