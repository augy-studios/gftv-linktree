// GET /api/admin/overview   counts for the dashboard's first screen

import { route, guard, ok } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { requireStaff, publicStaff } from '../_lib/staff.js';

async function count(table, apply) {
  const { count: n, error } = await apply(db().from(table).select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return n ?? 0;
}

export default route('admin/overview', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  const staff = await requireStaff(req, res);
  if (!staff) return;

  const [active, pending, banned, links, removed, openReports, awaitingReview, quarantined, pendingTestimonials] = await Promise.all([
    count(T.pages, (q) => q.eq('status', 'active')),
    count(T.pages, (q) => q.eq('status', 'pending')),
    count(T.pages, (q) => q.eq('status', 'banned')),
    count(T.links, (q) => q.is('removed_at', null)),
    count(T.links, (q) => q.not('removed_at', 'is', null)),
    count(T.reports, (q) => q.eq('status', 'open')),
    count(T.pages, (q) => q.eq('needs_review', true).is('reviewed_at', null).neq('status', 'banned')),
    count(T.pages, (q) => q.not('quarantined_at', 'is', null).neq('status', 'banned')),
    count(T.testimonials, (q) => q.eq('status', 'pending')),
  ]);

  ok(res, {
    staff: publicStaff(staff.user),
    counts: { active, pending, banned, links, removed, openReports, awaitingReview, quarantined, pendingTestimonials },
  });
});
