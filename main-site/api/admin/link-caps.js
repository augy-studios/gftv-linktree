// Link limits, for admins (migration 013).
//
// GET                                         -> { defaultCap, maxCap, pending, custom }
// POST { action: "set-default", cap }         the limit for every page without its own
// POST { action: "set-page", id, cap }        a page's own limit; cap: null puts it
//                                             back on the default
// POST { action: "approve", id, cap?, note? } grant a request: the page's limit
//                                             becomes cap, or what it asked for
// POST { action: "decline", id, note? }       refuse a request; the owner can ask again
//
// pending is every open request, oldest first, with how many links the page
// uses now and its limit now. custom is the pages that have a limit of their
// own. Every answer is the whole picture again. Lowering a limit never
// deletes links: a page over it just cannot add more.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, isUuid, LIMITS, MAX_LINKS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminCapRequestRow, adminCapPageRow } from '../_lib/serialize.js';
import { defaultLinkCap, setDefaultLinkCap, checkCap, REQUEST_COLUMNS } from '../_lib/link-cap.js';

const CUSTOM_LIMIT = 200;

// Links in use per page, removed ones left out.
async function usedByPage(pageIds) {
  const used = new Map(pageIds.map((id) => [id, 0]));
  if (pageIds.length === 0) return used;
  const { data, error } = await db().from(T.links).select('page_id, removed_at').in('page_id', pageIds);
  if (error) throw error;
  for (const l of data ?? []) if (!l.removed_at) used.set(l.page_id, (used.get(l.page_id) ?? 0) + 1);
  return used;
}

async function overview() {
  const [defaultCap, { data: pending, error }, { data: custom, error: customError }] = await Promise.all([
    defaultLinkCap(),
    db()
      .from(T.linkCapRequests)
      .select(`${REQUEST_COLUMNS}, page:${T.pages} ( id, slug, display_name, links_cap )`)
      .eq('status', 'pending')
      .order('created_at'),
    db()
      .from(T.pages)
      .select('id, slug, display_name, links_cap')
      .not('links_cap', 'is', null)
      .order('slug')
      .limit(CUSTOM_LIMIT),
  ]);
  if (error || customError) throw error || customError;
  const used = await usedByPage([...new Set([...(pending ?? []).map((r) => r.page_id), ...(custom ?? []).map((p) => p.id)])]);
  return {
    defaultCap,
    maxCap: MAX_LINKS,
    pending: (pending ?? []).map((r) => adminCapRequestRow(r, { used: used.get(r.page_id), limit: r.page?.links_cap ?? defaultCap })),
    custom: (custom ?? []).map((p) => adminCapPageRow(p, used.get(p.id))),
  };
}

export default route('admin/link-caps', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const staff = await requireStaff(req, res, { admin: true });
  if (!staff) return;
  const answer = async () => ok(res, await overview());
  if (req.method === 'GET') return answer();

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'staffWrite', [`staff:${staff.user.id}`])) return;
  const actor = { actorType: 'staff', actorId: staff.user.id };

  if (body.action === 'set-default') {
    const cap = checkCap(body.cap);
    if (cap === null) return fail(res, 400, 'cap_invalid', { max: MAX_LINKS });
    const from = await defaultLinkCap();
    await setDefaultLinkCap(cap, staff.user.id);
    await audit(req, { action: 'mod.link_cap_default', ...actor, details: { from, to: cap } });
    return answer();
  }

  if (!isUuid(body.id)) return fail(res, 400, 'bad_request');

  if (body.action === 'set-page') {
    const clearing = body.cap === null || body.cap === '';
    const cap = clearing ? null : checkCap(body.cap);
    if (!clearing && cap === null) return fail(res, 400, 'cap_invalid', { max: MAX_LINKS });
    const { data: page, error } = await db().from(T.pages).select('id, slug, links_cap').eq('id', body.id).maybeSingle();
    if (error) throw error;
    if (!page) return fail(res, 404, 'page_not_found');
    const { error: updateError } = await db().from(T.pages).update({ links_cap: cap }).eq('id', page.id);
    if (updateError) throw updateError;
    await audit(req, { action: 'mod.link_cap_page', ...actor, pageId: page.id, details: { slug: page.slug, from: page.links_cap ?? null, to: cap } });
    return answer();
  }

  if (body.action === 'approve' || body.action === 'decline') {
    const { data: request, error } = await db()
      .from(T.linkCapRequests)
      .select(`id, page_id, requested_cap, status, page:${T.pages} ( slug )`)
      .eq('id', body.id)
      .maybeSingle();
    if (error) throw error;
    if (!request) return fail(res, 404, 'cap_request_not_found');
    if (request.status !== 'pending') return fail(res, 409, 'cap_request_closed');
    const note = cleanText(body.note, LIMITS.reason, { multiline: true }) || null;
    const approving = body.action === 'approve';
    let granted = null;
    if (approving) {
      granted = body.cap === undefined || body.cap === null || body.cap === '' ? request.requested_cap : checkCap(body.cap);
      if (granted === null) return fail(res, 400, 'cap_invalid', { max: MAX_LINKS });
    }
    // Only a request still open changes, so two admins answering at once
    // cannot both act on it.
    const { data: closed, error: closeError } = await db()
      .from(T.linkCapRequests)
      .update({
        status: approving ? 'approved' : 'declined',
        granted_cap: granted,
        review_note: note,
        reviewed_by: staff.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', request.id)
      .eq('status', 'pending')
      .select('id');
    if (closeError) throw closeError;
    if (!closed || closed.length === 0) return fail(res, 409, 'cap_request_closed');
    if (approving) {
      const { error: pageError } = await db().from(T.pages).update({ links_cap: granted }).eq('id', request.page_id);
      if (pageError) throw pageError;
    }
    await audit(req, {
      action: approving ? 'mod.link_cap_approved' : 'mod.link_cap_declined',
      ...actor,
      pageId: request.page_id,
      details: { slug: request.page?.slug ?? null, requested: request.requested_cap, granted },
    });
    return answer();
  }

  fail(res, 400, 'bad_request');
});
