// GET /api/admin/overview   counts for the dashboard's first screen

import { route, guard, ok } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { requireStaff, publicStaff } from '../_lib/staff.js';

// How many rows of a table match the filters apply() adds, or 0.
async function count(table, apply) {
  const { count: total, error } = await apply(database().from(table).select('id', { count: 'exact', head: true }));
  if (error) {
    throw error;
  }
  if (total === null || total === undefined) {
    return 0;
  }
  return total;
}

// Requests for more links, which any staff member can answer. Before
// migration 013 there is no such table, and the card is left out rather than
// the whole overview failing.
async function pendingLinkCaps() {
  try {
    return await count(TABLES.linkCapRequests, (countQuery) => countQuery.eq('status', 'pending'));
  } catch (cause) {
    let detail = cause;
    if (cause !== null && cause !== undefined && cause.message !== null && cause.message !== undefined) {
      detail = cause.message;
    }
    console.error('[onelink] overview link caps:', detail);
    return undefined;
  }
}

// Checks the caller is staff, then counts pages, links, reports,
// testimonials and link limit requests by state, all at once.
export default route('admin/overview', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const staff = await requireStaff(request, response);
  if (!staff) {
    return;
  }

  const [active, pending, banned, links, removed, openReports, awaitingReview, quarantined, pendingTestimonials, linkCapRequests] = await Promise.all([
    count(TABLES.pages, (countQuery) => countQuery.eq('status', 'active')),
    count(TABLES.pages, (countQuery) => countQuery.eq('status', 'pending')),
    count(TABLES.pages, (countQuery) => countQuery.eq('status', 'banned')),
    count(TABLES.links, (countQuery) => countQuery.is('removed_at', null)),
    count(TABLES.links, (countQuery) => countQuery.not('removed_at', 'is', null)),
    count(TABLES.reports, (countQuery) => countQuery.eq('status', 'open')),
    count(TABLES.pages, (countQuery) => countQuery.eq('needs_review', true).is('reviewed_at', null).neq('status', 'banned')),
    count(TABLES.pages, (countQuery) => countQuery.not('quarantined_at', 'is', null).neq('status', 'banned')),
    count(TABLES.testimonials, (countQuery) => countQuery.eq('status', 'pending')),
    pendingLinkCaps(),
  ]);

  ok(response, {
    staff: publicStaff(staff.user),
    counts: { active, pending, banned, links, removed, openReports, awaitingReview, quarantined, pendingTestimonials, linkCapRequests },
  });
});
