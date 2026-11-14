// GET /api/admin/audit?action=&offset=   the audit log, newest first. Admin only.
// action filters by prefix: "mod." for moderation, "login." for owner sign
// ins, "staff." for staff sign ins, and so on.

import { route, guard, ok, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { requireStaff } from '../_lib/staff.js';
import { adminAuditRow } from '../_lib/serialize.js';
import { PAGE_SIZE, offsetOf } from '../_lib/admin.js';

// Checks the caller is an admin, reads one page of the log (filtered by
// action prefix when one is given), then adds the staff names behind it.
export default route('admin/audit', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const staff = await requireStaff(request, response, { admin: true });
  if (!staff) {
    return;
  }

  const offset = offsetOf(request);
  const prefix = query(request, 'action').replace(/[^a-z_.]/g, '').slice(0, 40);
  let auditQuery = database()
    .from(TABLES.audit)
    .select('id, action, details, actor_type, actor_id, page_id, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (prefix) {
    auditQuery = auditQuery.like('action', `${prefix}%`);
  }
  const { data, error, count } = await auditQuery;
  if (error) {
    throw error;
  }
  let rows = [];
  if (data) {
    rows = data;
  }

  // Staff names for the staff actors on this page of results, so the log
  // reads as people rather than ids. Usernames only, never emails.
  const staffRows = rows.filter((row) => {
    if (row.actor_type === 'staff' && row.actor_id) {
      return true;
    }
    return false;
  });
  const staffIds = [...new Set(staffRows.map((row) => row.actor_id))];
  let names = {};
  if (staffIds.length > 0) {
    const { data: users, error: userError } = await database().from(TABLES.staffUsers).select('id, username').in('id', staffIds);
    if (userError) {
      throw userError;
    }
    let userRows = [];
    if (users) {
      userRows = users;
    }
    names = Object.fromEntries(userRows.map((user) => [user.id, user.username]));
  }

  let total = 0;
  if (count !== null && count !== undefined) {
    total = count;
  }
  ok(response, {
    total,
    offset,
    pageSize: PAGE_SIZE,
    entries: rows.map((row) => {
      let actorName = names[row.actor_id];
      if (actorName === null || actorName === undefined) {
        actorName = null;
      }
      return { ...adminAuditRow(row), actorName };
    }),
  });
});
