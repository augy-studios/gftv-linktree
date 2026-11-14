// Pages, for staff.
//
// GET ?q=&status=&offset=        a page of pages, newest first; status is
//                                active, pending, banned, dormant,
//                                review (waiting for approval) or
//                                quarantined, or team (verified GFTV
//                                team pages)
// GET ?id=                       one page with its links, reports and link
//                                limit
// Pages carry renamedFrom: { slug, at } when the owner changed the page's
// name, the latest old name (migration 016), so staff reviewing a renamed
// page see what it was.
// POST { action: "ban", id, reason }     admin only; signs the owner out
// POST { action: "unban", id }           admin only
// POST { action: "delete", id, reason, confirmSlug }   admin only; deletes the
//        page and everything hanging off it, which frees its name for anyone
//        to register again
// POST { action: "remove-avatar", id, reason }   any staff; a picture is
//                                                content, like a link
// POST { action: "approve", id }                 any staff; lets a page whose
//                                                name is on the review list go
//                                                live. Refusing one is a take
//                                                down or a delete.
// POST { action: "release", id }                 any staff; ends a quarantine
// POST { action: "verify", id, role? }           admin only; marks the page as
//                                                someone on the GFTV team, with
//                                                an optional role label. Sent
//                                                again, it changes the role.
//        Or { action: "verify", slug, role? }, from the Team tab: by page
//        name, refused with already_verified when the page has the mark,
//        so adding someone never overwrites a role by accident.
// POST { action: "unverify", id }                admin only

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, isUuid, normaliseSlug, LIMITS, DORMANT_AFTER_DAYS } from '../_lib/validate.js';
import { limited, audit, resetRefusedLinks } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { endAllOwnerSessions } from '../_lib/session.js';
import { adminPageRow, adminLinkRow, adminReportRow } from '../_lib/serialize.js';
import { deleteAvatarFile } from '../_lib/avatar.js';
import { PAGE_SIZE, offsetOf, searchTerm, pattern } from '../_lib/admin.js';
import { linkCapFor, linksUsed } from '../_lib/link-cap.js';
import { previousSlugs } from '../_lib/slug-changes.js';

const PAGE_COLUMNS = 'id, slug, display_name, bio, avatar_path, status, ban_reason, banned_at, created_at, activated_at, telegram_chat_id, redirect_url, last_sign_in_at, needs_review, reviewed_at, quarantined_at, quarantine_reason, team_verified_at, team_role';

// GET ?id=: one page with its links, its reports and its link limit. Ends
// the request: 400 bad_request, 404 page_not_found, or the page.
async function pageDetail(response, id) {
  if (!isUuid(id)) {
    return fail(response, 400, 'bad_request');
  }
  const [{ data: page, error }, { data: links, error: linkError }, { data: reports, error: reportError }, cap, renames] = await Promise.all([
    database().from(TABLES.pages).select(PAGE_COLUMNS).eq('id', id).maybeSingle(),
    database().from(TABLES.links).select('id, page_id, title, url, icon, is_active, click_count, removed_at, removed_reason, created_at, order_index').eq('page_id', id).order('order_index'),
    database().from(TABLES.reports).select('id, page_id, reason, details, status, resolution_note, resolved_at, created_at, link:gftvonelink_links ( id, title, url, removed_at )').eq('page_id', id).order('created_at', { ascending: false }).limit(50),
    linkCapFor(id),
    previousSlugs([id]),
  ]);
  if (error) {
    throw error;
  }
  if (linkError) {
    throw linkError;
  }
  if (reportError) {
    throw reportError;
  }
  if (!page) {
    return fail(response, 404, 'page_not_found');
  }
  let renamedFrom = null;
  const rename = renames.get(page.id);
  if (rename) {
    renamedFrom = rename;
  }
  let linkRows = [];
  if (links) {
    linkRows = links;
  }
  let reportRows = [];
  if (reports) {
    reportRows = reports;
  }
  return ok(response, {
    page: adminPageRow(page, { renamedFrom }),
    links: linkRows.map(adminLinkRow),
    reports: reportRows.map(adminReportRow),
    // custom: the page has a limit of its own (migration 013). Changed
    // through admin/link-caps, by admins.
    linkCap: { used: linksUsed(links), limit: cap.limit, custom: cap.override !== null, defaultCap: cap.defaultCap },
  });
}

// One row of the pages list, with its link and report counts (embedded as
// [{ count }]) and its latest old name.
function listRow(row, renames) {
  let linkCount = 0;
  if (row.links) {
    const linkTally = row.links[0];
    if (linkTally && linkTally.count !== null && linkTally.count !== undefined) {
      linkCount = linkTally.count;
    }
  }
  let reportCount = 0;
  if (row.reports) {
    const reportTally = row.reports[0];
    if (reportTally && reportTally.count !== null && reportTally.count !== undefined) {
      reportCount = reportTally.count;
    }
  }
  let renamedFrom = null;
  const rename = renames.get(row.id);
  if (rename) {
    renamedFrom = rename;
  }
  return adminPageRow(row, { linkCount, reportCount, renamedFrom });
}

// GET ?q=&status=&offset=: one page of pages, filtered by status and search.
async function pageList(request, response) {
  const offset = offsetOf(request);
  const term = searchTerm(request);
  const status = query(request, 'status');
  // The team list reads like a directory, by name; the rest newest first.
  let orderColumn;
  if (status === 'team') {
    orderColumn = 'slug';
  } else {
    orderColumn = 'created_at';
  }
  let listQuery = database()
    .from(TABLES.pages)
    .select(`${PAGE_COLUMNS}, links:gftvonelink_links ( count ), reports:gftvonelink_reports ( count )`, { count: 'exact' })
    .order(orderColumn, { ascending: status === 'team' })
    .range(offset, offset + PAGE_SIZE - 1);
  if (['active', 'pending', 'banned'].includes(status)) {
    listQuery = listQuery.eq('status', status);
  }
  if (status === 'review') {
    listQuery = listQuery.eq('needs_review', true).is('reviewed_at', null);
  }
  if (status === 'quarantined') {
    listQuery = listQuery.not('quarantined_at', 'is', null);
  }
  if (status === 'team') {
    listQuery = listQuery.not('team_verified_at', 'is', null);
  }
  // Live, but not shown: the owner has not signed in for a year.
  if (status === 'dormant') {
    listQuery = listQuery.eq('status', 'active').lt('last_sign_in_at', new Date(Date.now() - DORMANT_AFTER_DAYS * 86400_000).toISOString());
  }
  if (term) {
    listQuery = listQuery.or(`slug.ilike."${pattern(term)}",display_name.ilike."${pattern(term)}"`);
  }
  const { data, error, count } = await listQuery;
  if (error) {
    throw error;
  }
  let rows = [];
  if (data) {
    rows = data;
  }
  const renames = await previousSlugs(rows.map((row) => row.id));
  let total = 0;
  if (count !== null && count !== undefined) {
    total = count;
  }
  return ok(response, {
    total,
    offset,
    pageSize: PAGE_SIZE,
    pages: rows.map((row) => listRow(row, renames)),
  });
}

// The page a POST acts on: by id, or by name for verify from the Team tab.
// Returns the page, or null once it has answered 400 bad_request, 404
// page_not_found or 409 already_verified.
async function findTargetPage(response, body) {
  let bySlug = false;
  if (body.action === 'verify' && body.id === undefined && typeof body.slug === 'string') {
    bySlug = true;
  }
  if (!bySlug && !isUuid(body.id)) {
    fail(response, 400, 'bad_request');
    return null;
  }

  const columns = 'id, slug, status, activated_at, avatar_path, needs_review, reviewed_at, quarantined_at, team_verified_at, team_role';
  let lookup = database().from(TABLES.pages).select(columns);
  if (bySlug) {
    lookup = lookup.eq('slug', normaliseSlug(body.slug));
  } else {
    lookup = lookup.eq('id', body.id);
  }
  const { data: page, error } = await lookup.maybeSingle();
  if (error) {
    throw error;
  }
  if (!page) {
    fail(response, 404, 'page_not_found');
    return null;
  }
  if (bySlug && page.team_verified_at) {
    fail(response, 409, 'already_verified');
    return null;
  }
  return page;
}

// Every action that leaves the page in place answers with it as it is now.
async function answerWithPage(response, pageId) {
  const { data: fresh, error: freshError } = await database().from(TABLES.pages).select(PAGE_COLUMNS).eq('id', pageId).single();
  if (freshError) {
    throw freshError;
  }
  ok(response, { page: adminPageRow(fresh) });
}

// The actions. Each one ends the request: with an error, or with the page
// as it is now (delete answers { deleted, slug } instead).

// ban (admin): takes the page down and signs the owner out.
async function banPage({ request, response, body, staff, page }) {
  const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
  if (!reason) {
    return fail(response, 400, 'reason_required');
  }
  // The audit row goes in first, so the log never misses an action that ran.
  await audit(request, { action: 'mod.page_banned', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, reason } });
  const { error: updateError } = await database()
    .from(TABLES.pages)
    // A page taken down loses its team mark, so restoring it later does
    // not quietly vouch for whoever has it then.
    .update({ status: 'banned', ban_reason: reason, banned_at: new Date().toISOString(), banned_by: staff.user.id, team_verified_at: null, team_verified_by: null, team_role: null })
    .eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  await endAllOwnerSessions(page.id);
  return answerWithPage(response, page.id);
}

// unban (admin): back to live, or to pending if it was never set up.
async function unbanPage({ request, response, staff, page }) {
  if (page.status !== 'banned') {
    return fail(response, 409, 'not_banned');
  }
  await audit(request, { action: 'mod.page_unbanned', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug } });
  let status;
  if (page.activated_at) {
    status = 'active';
  } else {
    status = 'pending';
  }
  const { error: updateError } = await database()
    .from(TABLES.pages)
    .update({ status, ban_reason: null, banned_at: null, banned_by: null })
    .eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  return answerWithPage(response, page.id);
}

// delete (admin): the page and everything hanging off it, which frees its
// name. Answers { deleted, slug }.
async function deletePage({ request, response, body, staff, page }) {
  const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
  if (!reason) {
    return fail(response, 400, 'reason_required');
  }
  let confirmSlug = body.confirmSlug;
  if (confirmSlug === null || confirmSlug === undefined) {
    confirmSlug = '';
  }
  if (String(confirmSlug).trim().toLowerCase() !== page.slug) {
    return fail(response, 400, 'confirm_slug');
  }
  // Written before the delete, with the slug in the details, since the page
  // row is about to go. Its links, passkeys, sessions, codes and reports go
  // with it (on delete cascade).
  await audit(request, { action: 'mod.page_deleted', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, reason } });
  const { error: deleteError } = await database().from(TABLES.pages).delete().eq('id', page.id);
  if (deleteError) {
    throw deleteError;
  }
  await deleteAvatarFile(page.avatar_path);
  return ok(response, { deleted: true, slug: page.slug });
}

// approve (any staff): a name on the review list goes live.
async function approvePage({ request, response, staff, page }) {
  if (!page.needs_review || page.reviewed_at) {
    return fail(response, 409, 'not_in_review');
  }
  await audit(request, { action: 'mod.page_approved', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug } });
  const { error: updateError } = await database()
    .from(TABLES.pages)
    .update({ reviewed_at: new Date().toISOString(), reviewed_by: staff.user.id })
    .eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  return answerWithPage(response, page.id);
}

// release (any staff): ends a quarantine.
async function releasePage({ request, response, staff, page }) {
  if (!page.quarantined_at) {
    return fail(response, 409, 'not_quarantined');
  }
  await audit(request, { action: 'mod.page_released', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug } });
  const { error: updateError } = await database().from(TABLES.pages).update({ quarantined_at: null, quarantine_reason: null }).eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  await resetRefusedLinks(page.id);
  return answerWithPage(response, page.id);
}

// verify (admin): the GFTV team mark, with an optional role. Sent again, it
// changes the role.
async function verifyPage({ request, response, body, staff, page }) {
  if (page.status !== 'active') {
    return fail(response, 409, 'not_active');
  }
  let role = cleanText(body.role, LIMITS.teamRole);
  if (!role) {
    role = null;
  }
  let auditAction;
  if (page.team_verified_at) {
    auditAction = 'mod.team_role_changed';
  } else {
    auditAction = 'mod.team_verified';
  }
  await audit(request, { action: auditAction, actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, role } });
  // The first verification's date is kept when only the role changes.
  let verifiedAt = page.team_verified_at;
  if (!verifiedAt) {
    verifiedAt = new Date().toISOString();
  }
  const { error: updateError } = await database()
    .from(TABLES.pages)
    .update({ team_verified_at: verifiedAt, team_verified_by: staff.user.id, team_role: role })
    .eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  return answerWithPage(response, page.id);
}

// unverify (admin): takes the team mark and role away.
async function unverifyPage({ request, response, staff, page }) {
  if (!page.team_verified_at) {
    return fail(response, 409, 'not_verified');
  }
  let role = page.team_role;
  if (!role) {
    role = null;
  }
  await audit(request, { action: 'mod.team_unverified', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, role } });
  const { error: updateError } = await database().from(TABLES.pages).update({ team_verified_at: null, team_verified_by: null, team_role: null }).eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  return answerWithPage(response, page.id);
}

// remove-avatar (any staff): a picture is content, like a link.
async function removeAvatar({ request, response, body, staff, page }) {
  if (!page.avatar_path) {
    return fail(response, 409, 'no_avatar');
  }
  const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
  if (!reason) {
    return fail(response, 400, 'reason_required');
  }
  await audit(request, { action: 'mod.avatar_removed', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, reason } });
  const { error: updateError } = await database().from(TABLES.pages).update({ avatar_path: null }).eq('id', page.id);
  if (updateError) {
    throw updateError;
  }
  await deleteAvatarFile(page.avatar_path);
  return answerWithPage(response, page.id);
}

// GET lists pages or shows one. A POST checks the body, the staff member
// (admin unless the action is moderation any editor can do) and the staff
// write limit, finds the page, then runs the action's step, which ends the
// request.
export default route('admin/pages', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }

  if (request.method === 'GET') {
    const staff = await requireStaff(request, response);
    if (!staff) {
      return;
    }
    const id = query(request, 'id');
    if (id) {
      return pageDetail(response, id);
    }
    return pageList(request, response);
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  // Taking a page down is for admins; removing a picture, like removing a
  // link, and approving a name are moderation any editor can do.
  const staff = await requireStaff(request, response, { admin: !['remove-avatar', 'approve', 'release'].includes(body.action) });
  if (!staff) {
    return;
  }
  if (await limited(request, response, 'staffWrite', [`staff:${staff.user.id}`])) {
    return;
  }
  const page = await findTargetPage(response, body);
  if (!page) {
    return;
  }

  const context = { request, response, body, staff, page };
  switch (body.action) {
    case 'ban':
      return banPage(context);
    case 'unban':
      return unbanPage(context);
    case 'delete':
      return deletePage(context);
    case 'approve':
      return approvePage(context);
    case 'release':
      return releasePage(context);
    case 'verify':
      return verifyPage(context);
    case 'unverify':
      return unverifyPage(context);
    case 'remove-avatar':
      return removeAvatar(context);
    default:
      return fail(response, 400, 'bad_request');
  }
});
