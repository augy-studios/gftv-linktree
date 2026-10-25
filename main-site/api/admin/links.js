// Links, for staff.
//
// GET ?q=&state=all|live|removed&offset=     search titles and addresses
// POST { action: "remove", id, reason }      soft delete: hidden everywhere,
//                                            kept for the record, restorable
// POST { action: "restore", id }

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminLinkRow } from '../_lib/serialize.js';
import { PAGE_SIZE, offsetOf, searchTerm, pattern } from '../_lib/admin.js';

const LINK_COLUMNS = 'id, page_id, title, url, icon, is_active, click_count, removed_at, removed_reason, created_at, page:gftvonelink_pages ( slug )';

export default route('admin/links', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const staff = await requireStaff(req, res);
  if (!staff) return;

  if (req.method === 'GET') {
    const offset = offsetOf(req);
    const term = searchTerm(req);
    const state = query(req, 'state');
    let q = db()
      .from(T.links)
      .select(LINK_COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (state === 'removed') q = q.not('removed_at', 'is', null);
    if (state === 'live') q = q.is('removed_at', null);
    if (term) q = q.or(`title.ilike."${pattern(term)}",url.ilike."${pattern(term)}"`);
    const { data, error, count } = await q;
    if (error) throw error;
    return ok(res, { total: count ?? 0, offset, pageSize: PAGE_SIZE, links: (data ?? []).map(adminLinkRow) });
  }

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'staffWrite', [`staff:${staff.user.id}`])) return;
  if (!isUuid(body.id)) return fail(res, 400, 'bad_request');

  const { data: link, error } = await db().from(T.links).select('id, page_id, url, removed_at').eq('id', body.id).maybeSingle();
  if (error) throw error;
  if (!link) return fail(res, 404, 'link_not_found');

  if (body.action === 'remove') {
    const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
    if (!reason) return fail(res, 400, 'reason_required');
    await audit(req, { action: 'mod.link_removed', actorType: 'staff', actorId: staff.user.id, pageId: link.page_id, details: { linkId: link.id, url: link.url, reason } });
    const { error: updateError } = await db()
      .from(T.links)
      .update({ removed_at: new Date().toISOString(), removed_by: staff.user.id, removed_reason: reason })
      .eq('id', link.id);
    if (updateError) throw updateError;
  } else if (body.action === 'restore') {
    await audit(req, { action: 'mod.link_restored', actorType: 'staff', actorId: staff.user.id, pageId: link.page_id, details: { linkId: link.id } });
    const { error: updateError } = await db()
      .from(T.links)
      .update({ removed_at: null, removed_by: null, removed_reason: null })
      .eq('id', link.id);
    if (updateError) throw updateError;
  } else {
    return fail(res, 400, 'bad_request');
  }

  const { data: fresh, error: freshError } = await db().from(T.links).select(LINK_COLUMNS).eq('id', link.id).single();
  if (freshError) throw freshError;
  ok(res, { link: adminLinkRow(fresh) });
});
