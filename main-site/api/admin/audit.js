// GET /api/admin/audit?action=&offset=   the audit log, newest first. Admin only.
// action filters by prefix: "mod." for moderation, "login." for owner sign
// ins, "staff." for staff sign ins, and so on.

import { route, guard, ok, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { requireStaff } from '../_lib/staff.js';
import { adminAuditRow } from '../_lib/serialize.js';
import { PAGE_SIZE, offsetOf } from '../_lib/admin.js';

export default route('admin/audit', async (request, response) => {
  if (guard(request, response, ['GET'])) return;
  const staff = await requireStaff(request, response, { admin: true });
  if (!staff) return;

  const offset = offsetOf(request);
  const prefix = query(request, 'action').replace(/[^a-z_.]/g, '').slice(0, 40);
  let q = database()
    .from(TABLES.audit)
    .select('id, action, details, actor_type, actor_id, page_id, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (prefix) q = q.like('action', `${prefix}%`);
  const { data, error, count } = await q;
  if (error) throw error;

  // Staff names for the staff actors on this page of results, so the log
  // reads as people rather than ids. Usernames only, never emails.
  const staffIds = [...new Set((data ?? []).filter((r) => r.actor_type === 'staff' && r.actor_id).map((r) => r.actor_id))];
  let names = {};
  if (staffIds.length > 0) {
    const { data: users, error: userError } = await database().from(TABLES.staffUsers).select('id, username').in('id', staffIds);
    if (userError) throw userError;
    names = Object.fromEntries((users ?? []).map((u) => [u.id, u.username]));
  }

  ok(response, {
    total: count ?? 0,
    offset,
    pageSize: PAGE_SIZE,
    entries: (data ?? []).map((row) => ({ ...adminAuditRow(row), actorName: names[row.actor_id] ?? null })),
  });
});
