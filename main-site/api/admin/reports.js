// Reports from visitors, for staff.
//
// GET ?status=open|resolved|dismissed&offset=
// POST { action: "resolve" | "dismiss", id, note?, removeLink? }
//   removeLink soft-deletes the reported link in the same step.
// POST { action: "delete", id }   admin only; removes the report for good,
//   after recording what it was in the audit log.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminReportRow } from '../_lib/serialize.js';
import { PAGE_SIZE, offsetOf } from '../_lib/admin.js';

const REPORT_COLUMNS =
  'id, page_id, link_id, reason, details, status, resolution_note, resolved_at, created_at, ' +
  'page:gftvonelink_pages ( slug, status ), link:gftvonelink_links ( id, title, url, removed_at )';

// Checks the caller is staff. GET lists reports in one state, a page at a
// time. POST checks the action (delete is admin only), finds the report,
// then deletes it, or resolves or dismisses it, removing the reported link
// first when asked. Audit rows go in before each change.
export default route('admin/reports', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const staff = await requireStaff(request, response);
  if (!staff) {
    return;
  }

  if (request.method === 'GET') {
    const offset = offsetOf(request);
    let status;
    if (['open', 'resolved', 'dismissed'].includes(query(request, 'status'))) {
      status = query(request, 'status');
    } else {
      status = 'open';
    }
    // Open reports oldest first, so the longest waiting is at the top.
    let ascending = true;
    if (status !== 'open') {
      ascending = false;
    }
    const { data, error, count } = await database()
      .from(TABLES.reports)
      .select(REPORT_COLUMNS, { count: 'exact' })
      .eq('status', status)
      .order('created_at', { ascending })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      throw error;
    }
    let total = 0;
    if (count !== null && count !== undefined) {
      total = count;
    }
    let rows = [];
    if (data) {
      rows = data;
    }
    return ok(response, { total, offset, pageSize: PAGE_SIZE, reports: rows.map(adminReportRow) });
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'staffWrite', [`staff:${staff.user.id}`])) {
    return;
  }
  if (!isUuid(body.id) || !['resolve', 'dismiss', 'delete'].includes(body.action)) {
    return fail(response, 400, 'bad_request');
  }
  if (body.action === 'delete' && staff.user.is_admin !== true) {
    return fail(response, 403, 'admin_only');
  }

  const { data: report, error } = await database().from(TABLES.reports).select('id, page_id, link_id, status, reason, details, page:gftvonelink_pages ( slug )').eq('id', body.id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!report) {
    return fail(response, 404, 'report_not_found');
  }

  if (body.action === 'delete') {
    let reportedSlug = null;
    if (report.page && report.page.slug !== null && report.page.slug !== undefined) {
      reportedSlug = report.page.slug;
    }
    let reportDetails = report.details;
    if (!reportDetails) {
      reportDetails = '';
    }
    // Written first, so the log keeps what the report said once it is gone.
    await audit(request, {
      action: 'mod.report_deleted',
      actorType: 'staff',
      actorId: staff.user.id,
      pageId: report.page_id,
      details: { reportId: report.id, slug: reportedSlug, reason: report.reason, status: report.status, details: String(reportDetails).slice(0, 200) },
    });
    const { error: deleteError } = await database().from(TABLES.reports).delete().eq('id', report.id);
    if (deleteError) {
      throw deleteError;
    }
    return ok(response, { deleted: true });
  }

  let note = cleanText(body.note, LIMITS.reason, { multiline: true });
  if (!note) {
    note = null;
  }
  let status;
  if (body.action === 'resolve') {
    status = 'resolved';
  } else {
    status = 'dismissed';
  }

  if (body.removeLink === true && report.link_id && status === 'resolved') {
    // Without a note, the audit log and the owner each get a stock reason.
    let auditReason = note;
    if (!note) {
      auditReason = 'Reported';
    }
    let removedReason = note;
    if (!note) {
      removedReason = 'Removed after a report';
    }
    await audit(request, { action: 'mod.link_removed', actorType: 'staff', actorId: staff.user.id, pageId: report.page_id, details: { linkId: report.link_id, reportId: report.id, reason: auditReason } });
    const { error: linkError } = await database()
      .from(TABLES.links)
      .update({ removed_at: new Date().toISOString(), removed_by: staff.user.id, removed_reason: removedReason })
      .eq('id', report.link_id)
      .is('removed_at', null);
    if (linkError) {
      throw linkError;
    }
  }

  await audit(request, { action: `mod.report_${status}`, actorType: 'staff', actorId: staff.user.id, pageId: report.page_id, details: { reportId: report.id } });
  const { error: updateError } = await database()
    .from(TABLES.reports)
    .update({ status, resolution_note: note, resolved_by: staff.user.id, resolved_at: new Date().toISOString() })
    .eq('id', report.id);
  if (updateError) {
    throw updateError;
  }

  const { data: fresh, error: freshError } = await database().from(TABLES.reports).select(REPORT_COLUMNS).eq('id', report.id).single();
  if (freshError) {
    throw freshError;
  }
  ok(response, { report: adminReportRow(fresh) });
});
