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
import { database, TABLES } from '../_lib/supabase.js';
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
  if (pageIds.length === 0) {
    return used;
  }
  const { data, error } = await database().from(TABLES.links).select('page_id, removed_at').in('page_id', pageIds);
  if (error) {
    throw error;
  }
  let links = [];
  if (data) {
    links = data;
  }
  for (const link of links) {
    if (!link.removed_at) {
      let count = used.get(link.page_id);
      if (count === null || count === undefined) {
        count = 0;
      }
      used.set(link.page_id, count + 1);
    }
  }
  return used;
}

// Tell the owner on Telegram. Never throws: the review has already happened.
async function tellOwner(capRequest, outcome, granted, note) {
  let chatId;
  if (capRequest.page) {
    chatId = capRequest.page.telegram_chat_id;
  }
  if (!chatId || !telegramConfigured()) {
    return;
  }
  try {
    await sendRichTelegram(chatId, linkCapMessage({ slug: capRequest.page.slug, outcome, requested: capRequest.requested_cap, granted, note }));
  } catch (cause) {
    let detail = cause;
    if (cause !== null && cause !== undefined && cause.message !== null && cause.message !== undefined) {
      detail = cause.message;
    }
    console.warn('[onelink] link limit message:', capRequest.page.slug, detail);
  }
}

// The pages with a limit of their own, for admins; editors get an empty
// answer without a query.
function customPagesQuery(isAdmin) {
  if (isAdmin) {
    return database().from(TABLES.pages).select('id, slug, display_name, links_cap').not('links_cap', 'is', null).order('slug').limit(CUSTOM_LIMIT);
  }
  return { data: null, error: null };
}

// The whole picture every answer carries: the default and the ceiling, every
// open request with the page's links in use and its limit now, and (admins
// only) the pages with a limit of their own.
async function overview(isAdmin) {
  const [defaultCap, { data: pending, error }, { data: custom, error: customError }] = await Promise.all([
    defaultLinkCap(),
    database()
      .from(TABLES.linkCapRequests)
      .select(`${REQUEST_COLUMNS}, page:${TABLES.pages} ( id, slug, display_name, links_cap )`)
      .eq('status', 'pending')
      .order('created_at'),
    customPagesQuery(isAdmin),
  ]);
  if (error) {
    throw error;
  }
  if (customError) {
    throw customError;
  }
  let pendingRows = [];
  if (pending) {
    pendingRows = pending;
  }
  let customRows = [];
  if (custom) {
    customRows = custom;
  }
  const used = await usedByPage([...new Set([...pendingRows.map((row) => row.page_id), ...customRows.map((page) => page.id)])]);
  const reply = {
    defaultCap,
    maxCap: MAX_LINKS,
    pending: pendingRows.map((row) => {
      let limit = defaultCap;
      if (row.page && row.page.links_cap !== null && row.page.links_cap !== undefined) {
        limit = row.page.links_cap;
      }
      return adminCapRequestRow(row, { used: used.get(row.page_id), limit });
    }),
  };
  if (isAdmin) {
    reply.custom = customRows.map((page) => adminCapPageRow(page, used.get(page.id)));
  }
  return reply;
}

// set-default (admins): the limit for every page without one of its own.
// Ends the request: 400 cap_invalid, or the whole picture again.
async function setDefaultCap({ request, response, body, staff, actor, answer }) {
  const cap = checkCap(body.cap);
  if (cap === null) {
    return fail(response, 400, 'cap_invalid', { max: MAX_LINKS });
  }
  const from = await defaultLinkCap();
  await setDefaultLinkCap(cap, staff.user.id);
  await audit(request, { action: 'mod.link_cap_default', ...actor, details: { from, to: cap } });
  return answer();
}

// set-page (admins): a page's own limit; cap null or '' puts the page back
// on the default. Ends the request: 400 cap_invalid, 404 page_not_found, or
// the whole picture again.
async function setPageCap({ request, response, body, actor, answer }) {
  let clearing = false;
  if (body.cap === null || body.cap === '') {
    clearing = true;
  }
  let cap;
  if (clearing) {
    cap = null;
  } else {
    cap = checkCap(body.cap);
  }
  if (!clearing && cap === null) {
    return fail(response, 400, 'cap_invalid', { max: MAX_LINKS });
  }
  const { data: page, error } = await database().from(TABLES.pages).select('id, slug, links_cap').eq('id', body.id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!page) {
    return fail(response, 404, 'page_not_found');
  }
  const { error: updateError } = await database().from(TABLES.pages).update({ links_cap: cap }).eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  let previousCap = null;
  if (page.links_cap !== null && page.links_cap !== undefined) {
    previousCap = page.links_cap;
  }
  await audit(request, { action: 'mod.link_cap_page', ...actor, pageId: page.id, details: { slug: page.slug, from: previousCap, to: cap } });
  return answer();
}

// approve or decline (any staff): closes an open request, sets the page's
// limit when a number is granted, and tells the owner. Ends the request:
// 404 cap_request_not_found, 409 cap_request_closed, 400 cap_grant_range,
// 409 cap_request_closed again if someone else answered first, or the whole
// picture again.
async function answerCapRequest({ request, response, body, staff, isAdmin, actor, answer }) {
  const { data: capRequest, error } = await database()
    .from(TABLES.linkCapRequests)
    .select(`id, page_id, requested_cap, status, page:${TABLES.pages} ( slug, telegram_chat_id )`)
    .eq('id', body.id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!capRequest) {
    return fail(response, 404, 'cap_request_not_found');
  }
  if (capRequest.status !== 'pending') {
    return fail(response, 409, 'cap_request_closed');
  }
  let note = cleanText(body.note, LIMITS.reason, { multiline: true });
  if (!note) {
    note = null;
  }
  const approving = body.action === 'approve';
  let noNumber = false;
  if (body.cap === undefined || body.cap === null || body.cap === '') {
    noNumber = true;
  }
  // The range a number has to fall in: above the page's limit now, and up
  // to what was asked (editors) or the ceiling (admins) when approving,
  // below what was asked when declining with a compromise.
  const { limit } = await linkCapFor(capRequest.page_id);
  const min = limit + 1;
  let max;
  if (approving) {
    if (isAdmin) {
      max = MAX_LINKS;
    } else {
      max = capRequest.requested_cap;
    }
  } else {
    max = capRequest.requested_cap - 1;
  }
  // Approving with no number grants what was asked; declining with no
  // number grants nothing.
  let granted = null;
  if (approving || !noNumber) {
    if (approving && noNumber) {
      granted = capRequest.requested_cap;
    } else {
      granted = checkCap(body.cap);
    }
    if (granted === null || granted < min || granted > max) {
      return fail(response, 400, 'cap_grant_range', { min, max });
    }
  }
  // Only a request still open changes, so two staff answering at once
  // cannot both act on it.
  let closedStatus;
  if (approving) {
    closedStatus = 'approved';
  } else {
    closedStatus = 'declined';
  }
  const { data: closed, error: closeError } = await database()
    .from(TABLES.linkCapRequests)
    .update({
      status: closedStatus,
      granted_cap: granted,
      review_note: note,
      reviewed_by: staff.user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', capRequest.id)
    .eq('status', 'pending')
    .select('id');
  if (closeError) {
    throw closeError;
  }
  if (!closed || closed.length === 0) {
    return fail(response, 409, 'cap_request_closed');
  }
  if (granted !== null) {
    const { error: pageError } = await database().from(TABLES.pages).update({ links_cap: granted }).eq('id', capRequest.page_id);
    if (pageError) {
      throw pageError;
    }
  }
  let auditAction;
  if (approving) {
    auditAction = 'mod.link_cap_approved';
  } else {
    auditAction = 'mod.link_cap_declined';
  }
  let pageSlug = null;
  if (capRequest.page && capRequest.page.slug !== null && capRequest.page.slug !== undefined) {
    pageSlug = capRequest.page.slug;
  }
  await audit(request, {
    action: auditAction,
    ...actor,
    pageId: capRequest.page_id,
    details: { slug: pageSlug, requested: capRequest.requested_cap, from: limit, granted },
  });
  // A decline that still granted a number is a compromise.
  let outcome;
  if (approving) {
    outcome = 'approved';
  } else if (granted !== null) {
    outcome = 'compromise';
  } else {
    outcome = 'declined';
  }
  await tellOwner(capRequest, outcome, granted, note);
  return answer();
}

// GET answers with the whole picture. A POST is checked (body, staff write
// limit, admin-only actions) and handed to its action's step, which ends the
// request with an error or the whole picture again.
export default route('admin/link-caps', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  // Any staff member reviews requests; the default and per-page limits are
  // for admins.
  const staff = await requireStaff(request, response);
  if (!staff) {
    return;
  }
  const isAdmin = staff.user.is_admin === true;
  const answer = async () => ok(response, await overview(isAdmin));
  if (request.method === 'GET') {
    return answer();
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'staffWrite', [`staff:${staff.user.id}`])) {
    return;
  }
  const actor = { actorType: 'staff', actorId: staff.user.id };
  if ((body.action === 'set-default' || body.action === 'set-page') && !isAdmin) {
    return fail(response, 403, 'admin_only');
  }
  const context = { request, response, body, staff, isAdmin, actor, answer };

  if (body.action === 'set-default') {
    return setDefaultCap(context);
  }

  // Every other action names a page or a request by its id.
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }

  if (body.action === 'set-page') {
    return setPageCap(context);
  }

  if (body.action === 'approve' || body.action === 'decline') {
    return answerCapRequest(context);
  }

  fail(response, 400, 'bad_request');
});
