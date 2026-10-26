// Link limits, for staff (migration 013).
//
// GET                                         -> { defaultCap, maxCap, pending, custom? }
// POST { action: "approve", id, cap?, note? } any staff. The page's limit
//        becomes cap, or what it asked for. cap must be above the page's limit
//        now; editors can give up to what was asked, admins up to maxCap.
// POST { action: "decline", id, cap?, note? } any staff. cap, if given, is a
//        compromise: a limit above the page's limit now but below what it
//        asked for, which becomes the page's own limit. The owner can ask again.
// POST { action: "set-default", cap }         admins: the limit for every page
//                                             without its own
// POST { action: "set-page", id, cap }        admins: a page's own limit;
//                                             cap: null puts it back on the default
//
// pending is every open request, oldest first, with how many links the page
// uses now and its limit now. custom, for admins only, is the pages that have
// a limit of their own. Every answer is the whole picture again. Lowering a
// limit never deletes links: a page over it just cannot add more.
//
// The owner is told the outcome on Telegram, when they have it linked. A
// failed send never fails the review.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, isUuid, LIMITS, MAX_LINKS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminCapRequestRow, adminCapPageRow } from '../_lib/serialize.js';
import { defaultLinkCap, setDefaultLinkCap, checkCap, linkCapFor, REQUEST_COLUMNS } from '../_lib/link-cap.js';
import { sendRichTelegram, telegramConfigured } from '../_lib/telegram.js';
import { linkCapMessage } from '../_lib/telegram-messages.js';

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

// Tell the owner on Telegram. Never throws: the review has already happened.
async function tellOwner(request, outcome, granted, note) {
  const chatId = request.page?.telegram_chat_id;
  if (!chatId || !telegramConfigured()) return;
  try {
    await sendRichTelegram(chatId, linkCapMessage({ slug: request.page.slug, outcome, requested: request.requested_cap, granted, note }));
  } catch (cause) {
    console.warn('[onelink] link limit message:', request.page.slug, cause?.message ?? cause);
  }
}

async function overview(isAdmin) {
  const [defaultCap, { data: pending, error }, { data: custom, error: customError }] = await Promise.all([
    defaultLinkCap(),
    db()
      .from(T.linkCapRequests)
      .select(`${REQUEST_COLUMNS}, page:${T.pages} ( id, slug, display_name, links_cap )`)
      .eq('status', 'pending')
      .order('created_at'),
    isAdmin
      ? db().from(T.pages).select('id, slug, display_name, links_cap').not('links_cap', 'is', null).order('slug').limit(CUSTOM_LIMIT)
      : { data: null, error: null },
  ]);
  if (error || customError) throw error || customError;
  const used = await usedByPage([...new Set([...(pending ?? []).map((r) => r.page_id), ...(custom ?? []).map((p) => p.id)])]);
  const answer = {
    defaultCap,
    maxCap: MAX_LINKS,
    pending: (pending ?? []).map((r) => adminCapRequestRow(r, { used: used.get(r.page_id), limit: r.page?.links_cap ?? defaultCap })),
  };
  if (isAdmin) answer.custom = (custom ?? []).map((p) => adminCapPageRow(p, used.get(p.id)));
  return answer;
}

export default route('admin/link-caps', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  // Any staff member reviews requests; the default and per-page limits are
  // for admins.
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const isAdmin = staff.user.is_admin === true;
  const answer = async () => ok(res, await overview(isAdmin));
  if (req.method === 'GET') return answer();

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'staffWrite', [`staff:${staff.user.id}`])) return;
  const actor = { actorType: 'staff', actorId: staff.user.id };
  if ((body.action === 'set-default' || body.action === 'set-page') && !isAdmin) return fail(res, 403, 'admin_only');

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
      .select(`id, page_id, requested_cap, status, page:${T.pages} ( slug, telegram_chat_id )`)
      .eq('id', body.id)
      .maybeSingle();
    if (error) throw error;
    if (!request) return fail(res, 404, 'cap_request_not_found');
    if (request.status !== 'pending') return fail(res, 409, 'cap_request_closed');
    const note = cleanText(body.note, LIMITS.reason, { multiline: true }) || null;
    const approving = body.action === 'approve';
    const noNumber = body.cap === undefined || body.cap === null || body.cap === '';
    // The range a number has to fall in: above the page's limit now, and up
    // to what was asked (editors) or the ceiling (admins) when approving,
    // below what was asked when declining with a compromise.
    const { limit } = await linkCapFor(request.page_id);
    const min = limit + 1;
    const max = approving ? (isAdmin ? MAX_LINKS : request.requested_cap) : request.requested_cap - 1;
    let granted = null;
    if (approving || !noNumber) {
      granted = approving && noNumber ? request.requested_cap : checkCap(body.cap);
      if (granted === null || granted < min || granted > max) return fail(res, 400, 'cap_grant_range', { min, max });
    }
    // Only a request still open changes, so two staff answering at once
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
    if (granted !== null) {
      const { error: pageError } = await db().from(T.pages).update({ links_cap: granted }).eq('id', request.page_id);
      if (pageError) throw pageError;
    }
    await audit(req, {
      action: approving ? 'mod.link_cap_approved' : 'mod.link_cap_declined',
      ...actor,
      pageId: request.page_id,
      details: { slug: request.page?.slug ?? null, requested: request.requested_cap, from: limit, granted },
    });
    await tellOwner(request, approving ? 'approved' : granted !== null ? 'compromise' : 'declined', granted, note);
    return answer();
  }

  fail(res, 400, 'bad_request');
});
