// Links, for staff.
//
// GET ?q=&state=all|live|removed&offset=     search titles and addresses
// POST { action: "remove", id, reason }      soft delete: hidden everywhere,
//                                            kept for the record, restorable
// POST { action: "restore", id }

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminLinkRow } from '../_lib/serialize.js';
import { PAGE_SIZE, offsetOf, searchTerm, pattern } from '../_lib/admin.js';

const LINK_COLUMNS = 'id, page_id, title, url, icon, is_active, click_count, removed_at, removed_reason, created_at, page:gftvonelink_pages ( slug )';

// Checks the caller is staff. GET searches links a page of results at a
// time; POST finds the link, removes or restores it (audit row first) and
// answers with the link as it is now.
export default route('admin/links', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const staff = await requireStaff(request, response);
  if (!staff) {
    return;
  }

  if (request.method === 'GET') {
    const offset = offsetOf(request);
    const term = searchTerm(request);
    const state = query(request, 'state');
    let linkQuery = database()
      .from(TABLES.links)
      .select(LINK_COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (state === 'removed') {
      linkQuery = linkQuery.not('removed_at', 'is', null);
    }
    if (state === 'live') {
      linkQuery = linkQuery.is('removed_at', null);
    }
    if (term) {
      linkQuery = linkQuery.or(`title.ilike."${pattern(term)}",url.ilike."${pattern(term)}"`);
    }
    const { data, error, count } = await linkQuery;
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
    return ok(response, { total, offset, pageSize: PAGE_SIZE, links: rows.map(adminLinkRow) });
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'staffWrite', [`staff:${staff.user.id}`])) {
    return;
  }
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }

  const { data: link, error } = await database().from(TABLES.links).select('id, page_id, url, removed_at').eq('id', body.id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!link) {
    return fail(response, 404, 'link_not_found');
  }

  if (body.action === 'remove') {
    const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
    if (!reason) {
      return fail(response, 400, 'reason_required');
    }
    await audit(request, { action: 'mod.link_removed', actorType: 'staff', actorId: staff.user.id, pageId: link.page_id, details: { linkId: link.id, url: link.url, reason } });
    const { error: updateError } = await database()
      .from(TABLES.links)
      .update({ removed_at: new Date().toISOString(), removed_by: staff.user.id, removed_reason: reason })
      .eq('id', link.id);
    if (updateError) {
      throw updateError;
    }
  } else if (body.action === 'restore') {
    await audit(request, { action: 'mod.link_restored', actorType: 'staff', actorId: staff.user.id, pageId: link.page_id, details: { linkId: link.id } });
    const { error: updateError } = await database()
      .from(TABLES.links)
      .update({ removed_at: null, removed_by: null, removed_reason: null })
      .eq('id', link.id);
    if (updateError) {
      throw updateError;
    }
  } else {
    return fail(response, 400, 'bad_request');
  }

  const { data: fresh, error: freshError } = await database().from(TABLES.links).select(LINK_COLUMNS).eq('id', link.id).single();
  if (freshError) {
    throw freshError;
  }
  ok(response, { link: adminLinkRow(fresh) });
});
