// Reports from visitors, for staff.
//
// GET ?status=open|resolved|dismissed&offset=
// POST { action: "resolve" | "dismiss", id, note?, removeLink? }
//   removeLink soft-deletes the reported link in the same step.
// POST { action: "delete", id }   admin only; removes the report for good,
//   after recording what it was in the audit log.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminReportRow } from '../_lib/serialize.js';
import { PAGE_SIZE, offsetOf } from '../_lib/admin.js';

const REPORT_COLUMNS =
  'id, page_id, link_id, reason, details, status, resolution_note, resolved_at, created_at, ' +
  'page:gftvonelink_pages ( slug, status ), link:gftvonelink_links ( id, title, url, removed_at )';

export default route('admin/reports', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const staff = await requireStaff(req, res);
  if (!staff) return;

  if (req.method === 'GET') {
    const offset = offsetOf(req);
    const status = ['open', 'resolved', 'dismissed'].includes(query(req, 'status')) ? query(req, 'status') : 'open';
    const { data, error, count } = await db()
      .from(T.reports)
      .select(REPORT_COLUMNS, { count: 'exact' })
      .eq('status', status)
      .order('created_at', { ascending: status !== 'open' ? false : true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    return ok(res, { total: count ?? 0, offset, pageSize: PAGE_SIZE, reports: (data ?? []).map(adminReportRow) });
  }

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'staffWrite', [`staff:${staff.user.id}`])) return;
  if (!isUuid(body.id) || !['resolve', 'dismiss', 'delete'].includes(body.action)) return fail(res, 400, 'bad_request');
  if (body.action === 'delete' && staff.user.is_admin !== true) return fail(res, 403, 'admin_only');

  const { data: report, error } = await db().from(T.reports).select('id, page_id, link_id, status, reason, details, page:gftvonelink_pages ( slug )').eq('id', body.id).maybeSingle();
  if (error) throw error;
  if (!report) return fail(res, 404, 'report_not_found');

  if (body.action === 'delete') {
    // Written first, so the log keeps what the report said once it is gone.
    await audit(req, {
      action: 'mod.report_deleted',
      actorType: 'staff',
      actorId: staff.user.id,
      pageId: report.page_id,
      details: { reportId: report.id, slug: report.page?.slug ?? null, reason: report.reason, status: report.status, details: String(report.details || '').slice(0, 200) },
    });
    const { error: deleteError } = await db().from(T.reports).delete().eq('id', report.id);
    if (deleteError) throw deleteError;
    return ok(res, { deleted: true });
  }

  const note = cleanText(body.note, LIMITS.reason, { multiline: true }) || null;
  const status = body.action === 'resolve' ? 'resolved' : 'dismissed';

  if (body.removeLink === true && report.link_id && status === 'resolved') {
    await audit(req, { action: 'mod.link_removed', actorType: 'staff', actorId: staff.user.id, pageId: report.page_id, details: { linkId: report.link_id, reportId: report.id, reason: note || 'Reported' } });
    const { error: linkError } = await db()
      .from(T.links)
      .update({ removed_at: new Date().toISOString(), removed_by: staff.user.id, removed_reason: note || 'Removed after a report' })
      .eq('id', report.link_id)
      .is('removed_at', null);
    if (linkError) throw linkError;
  }

  await audit(req, { action: `mod.report_${status}`, actorType: 'staff', actorId: staff.user.id, pageId: report.page_id, details: { reportId: report.id } });
  const { error: updateError } = await db()
    .from(T.reports)
    .update({ status, resolution_note: note, resolved_by: staff.user.id, resolved_at: new Date().toISOString() })
    .eq('id', report.id);
  if (updateError) throw updateError;

  const { data: fresh, error: freshError } = await db().from(T.reports).select(REPORT_COLUMNS).eq('id', report.id).single();
  if (freshError) throw freshError;
  ok(res, { report: adminReportRow(fresh) });
});
