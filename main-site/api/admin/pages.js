// Pages, for staff.
//
// GET ?q=&status=&offset=        a page of pages, newest first; status is
//                                active, pending, banned, dormant,
//                                review (waiting for approval) or
//                                quarantined
// GET ?id=                       one page with its links and reports
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

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, isUuid, LIMITS, DORMANT_AFTER_DAYS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { endAllOwnerSessions } from '../_lib/session.js';
import { adminPageRow, adminLinkRow, adminReportRow } from '../_lib/serialize.js';
import { deleteAvatarFile } from '../_lib/avatar.js';
import { PAGE_SIZE, offsetOf, searchTerm, pattern } from '../_lib/admin.js';

const PAGE_COLUMNS = 'id, slug, display_name, bio, avatar_path, status, ban_reason, banned_at, created_at, activated_at, telegram_chat_id, redirect_url, last_sign_in_at, needs_review, reviewed_at, quarantined_at, quarantine_reason';

export default route('admin/pages', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;

  if (req.method === 'GET') {
    const staff = await requireStaff(req, res);
    if (!staff) return;

    const id = query(req, 'id');
    if (id) {
      if (!isUuid(id)) return fail(res, 400, 'bad_request');
      const [{ data: page, error }, { data: links, error: linkError }, { data: reports, error: reportError }] = await Promise.all([
        db().from(T.pages).select(PAGE_COLUMNS).eq('id', id).maybeSingle(),
        db().from(T.links).select('id, page_id, title, url, icon, is_active, click_count, removed_at, removed_reason, created_at, order_index').eq('page_id', id).order('order_index'),
        db().from(T.reports).select('id, page_id, reason, details, status, resolution_note, resolved_at, created_at, link:gftvonelink_links ( id, title, url, removed_at )').eq('page_id', id).order('created_at', { ascending: false }).limit(50),
      ]);
      if (error || linkError || reportError) throw error || linkError || reportError;
      if (!page) return fail(res, 404, 'page_not_found');
      return ok(res, {
        page: adminPageRow(page),
        links: (links ?? []).map(adminLinkRow),
        reports: (reports ?? []).map(adminReportRow),
      });
    }

    const offset = offsetOf(req);
    const term = searchTerm(req);
    const status = query(req, 'status');
    let q = db()
      .from(T.pages)
      .select(`${PAGE_COLUMNS}, links:gftvonelink_links ( count ), reports:gftvonelink_reports ( count )`, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (['active', 'pending', 'banned'].includes(status)) q = q.eq('status', status);
    // Live, but not shown: the owner has not signed in for a year.
    if (status === 'review') q = q.eq('needs_review', true).is('reviewed_at', null);
    if (status === 'quarantined') q = q.not('quarantined_at', 'is', null);
    if (status === 'dormant') {
      q = q.eq('status', 'active').lt('last_sign_in_at', new Date(Date.now() - DORMANT_AFTER_DAYS * 86400_000).toISOString());
    }
    if (term) q = q.or(`slug.ilike."${pattern(term)}",display_name.ilike."${pattern(term)}"`);
    const { data, error, count } = await q;
    if (error) throw error;
    return ok(res, {
      total: count ?? 0,
      offset,
      pageSize: PAGE_SIZE,
      pages: (data ?? []).map((p) =>
        adminPageRow(p, { linkCount: p.links?.[0]?.count ?? 0, reportCount: p.reports?.[0]?.count ?? 0 })
      ),
    });
  }

  const body = await readJson(req, res);
  if (!body) return;
  // Taking a page down is for admins; removing a picture, like removing a
  // link, and approving a name are moderation any editor can do.
  const staff = await requireStaff(req, res, { admin: !['remove-avatar', 'approve', 'release'].includes(body.action) });
  if (!staff) return;
  if (await limited(req, res, 'staffWrite', [`staff:${staff.user.id}`])) return;
  if (!isUuid(body.id)) return fail(res, 400, 'bad_request');

  const { data: page, error } = await db().from(T.pages).select('id, slug, status, activated_at, avatar_path, needs_review, reviewed_at, quarantined_at').eq('id', body.id).maybeSingle();
  if (error) throw error;
  if (!page) return fail(res, 404, 'page_not_found');

  if (body.action === 'ban') {
    const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
    if (!reason) return fail(res, 400, 'reason_required');
    // The audit row goes in first, so the log never misses an action that ran.
    await audit(req, { action: 'mod.page_banned', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, reason } });
    const { error: updateError } = await db()
      .from(T.pages)
      .update({ status: 'banned', ban_reason: reason, banned_at: new Date().toISOString(), banned_by: staff.user.id })
      .eq('id', page.id);
    if (updateError) throw updateError;
    await endAllOwnerSessions(page.id);
  } else if (body.action === 'unban') {
    if (page.status !== 'banned') return fail(res, 409, 'not_banned');
    await audit(req, { action: 'mod.page_unbanned', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug } });
    const { error: updateError } = await db()
      .from(T.pages)
      .update({ status: page.activated_at ? 'active' : 'pending', ban_reason: null, banned_at: null, banned_by: null })
      .eq('id', page.id);
    if (updateError) throw updateError;
  } else if (body.action === 'delete') {
    const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
    if (!reason) return fail(res, 400, 'reason_required');
    if (String(body.confirmSlug ?? '').trim().toLowerCase() !== page.slug) return fail(res, 400, 'confirm_slug');
    // Written before the delete, with the slug in the details, since the page
    // row is about to go. Its links, passkeys, sessions, codes and reports go
    // with it (on delete cascade).
    await audit(req, { action: 'mod.page_deleted', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, reason } });
    const { error: deleteError } = await db().from(T.pages).delete().eq('id', page.id);
    if (deleteError) throw deleteError;
    await deleteAvatarFile(page.avatar_path);
    return ok(res, { deleted: true, slug: page.slug });
  } else if (body.action === 'approve') {
    if (!page.needs_review || page.reviewed_at) return fail(res, 409, 'not_in_review');
    await audit(req, { action: 'mod.page_approved', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug } });
    const { error: updateError } = await db()
      .from(T.pages)
      .update({ reviewed_at: new Date().toISOString(), reviewed_by: staff.user.id })
      .eq('id', page.id);
    if (updateError) throw updateError;
  } else if (body.action === 'release') {
    if (!page.quarantined_at) return fail(res, 409, 'not_quarantined');
    await audit(req, { action: 'mod.page_released', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug } });
    const { error: updateError } = await db().from(T.pages).update({ quarantined_at: null, quarantine_reason: null }).eq('id', page.id);
    if (updateError) throw updateError;
  } else if (body.action === 'remove-avatar') {
    if (!page.avatar_path) return fail(res, 409, 'no_avatar');
    const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
    if (!reason) return fail(res, 400, 'reason_required');
    await audit(req, { action: 'mod.avatar_removed', actorType: 'staff', actorId: staff.user.id, pageId: page.id, details: { slug: page.slug, reason } });
    const { error: updateError } = await db().from(T.pages).update({ avatar_path: null }).eq('id', page.id);
    if (updateError) throw updateError;
    await deleteAvatarFile(page.avatar_path);
  } else {
    return fail(res, 400, 'bad_request');
  }

  const { data: fresh, error: freshError } = await db().from(T.pages).select(PAGE_COLUMNS).eq('id', page.id).single();
  if (freshError) throw freshError;
  ok(res, { page: adminPageRow(fresh) });
});
