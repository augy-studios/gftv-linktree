// The signed-in owner's links. Every answer is the full, ordered list.
//
// POST   { title, url, icon }               add a link at the end
// POST   { action: "reorder", ids: [...] }   save a new order
// PATCH  { id, title?, url?, icon?, isActive? }
// DELETE { id }
//
// A link staff have removed cannot be edited or deleted by its owner, so the
// moderation record survives. The owner sees that it was removed and why.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, checkIcon, isUuid, LIMITS, MAX_LINKS } from '../_lib/validate.js';
import { limited, checkLinkUrl, noteRefusedLink, refusedForAttempts, addressRefusedInText, refusedForBan } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { ownerLink } from '../_lib/serialize.js';

const LINK_COLUMNS = 'id, title, url, icon, order_index, is_active, click_count, removed_at, removed_reason';

async function allLinks(pageId) {
  const { data, error } = await db().from(T.links).select(LINK_COLUMNS).eq('page_id', pageId).order('order_index');
  if (error) throw error;
  return data ?? [];
}

export default route('me/links', async (req, res) => {
  if (guard(req, res, ['POST', 'PATCH', 'DELETE'])) return;
  const owner = await requireOwner(req, res);
  if (!owner) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'ownerWrite', [`page:${owner.page.id}`])) return;
  if (await refusedForBan(req, res, { pageId: owner.page.id })) return;
  const pageId = owner.page.id;
  // A refused address also counts towards quarantine (guards.js).
  const refuse = async (url, input) => {
    await noteRefusedLink(req, owner.page, url.error, input);
    return fail(res, 400, url.error);
  };
  if (body.url !== undefined && (await refusedForAttempts(req, res))) return;
  // A title is shown as the link's text, so an address in it is checked too.
  const titleRefused = async (title) => {
    const refused = await addressRefusedInText(title);
    if (!refused) return false;
    await noteRefusedLink(req, owner.page, refused.error, `https://${refused.host}/`);
    fail(res, 400, 'text_address', { host: refused.host });
    return true;
  };

  if (req.method === 'POST' && body.action === 'reorder') {
    const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid).slice(0, MAX_LINKS) : [];
    const { error } = await db().rpc('gftvonelink_reorder_links', { p_page_id: pageId, p_ids: ids });
    if (error) throw error;
  } else if (req.method === 'POST') {
    const existing = await allLinks(pageId);
    if (existing.length >= MAX_LINKS) return fail(res, 400, 'too_many_links');
    const title = cleanText(body.title, LIMITS.title);
    if (!title) return fail(res, 400, 'title_required');
    if (await titleRefused(title)) return;
    const url = await checkLinkUrl(body.url, { mail: true });
    if (!url.ok) return refuse(url, body.url);
    const nextIndex = existing.reduce((max, l) => Math.max(max, l.order_index), -1) + 1;
    const { error } = await db()
      .from(T.links)
      .insert({ page_id: pageId, title, url: url.url, icon: checkIcon(body.icon), order_index: nextIndex });
    if (error) throw error;
  } else {
    if (!isUuid(body.id)) return fail(res, 400, 'bad_request');
    const { data: link, error } = await db()
      .from(T.links)
      .select('id, removed_at')
      .eq('id', body.id)
      .eq('page_id', pageId)
      .maybeSingle();
    if (error) throw error;
    if (!link) return fail(res, 404, 'link_not_found');
    if (link.removed_at) return fail(res, 403, 'link_removed');

    if (req.method === 'DELETE') {
      const { error: deleteError } = await db().from(T.links).delete().eq('id', link.id).eq('page_id', pageId);
      if (deleteError) throw deleteError;
    } else {
      const fields = {};
      if (body.title !== undefined) {
        fields.title = cleanText(body.title, LIMITS.title);
        if (!fields.title) return fail(res, 400, 'title_required');
        if (await titleRefused(fields.title)) return;
      }
      if (body.url !== undefined) {
        const url = await checkLinkUrl(body.url, { mail: true });
        if (!url.ok) return refuse(url, body.url);
        fields.url = url.url;
      }
      if (body.icon !== undefined) fields.icon = checkIcon(body.icon);
      if (body.isActive !== undefined) fields.is_active = body.isActive === true;
      if (Object.keys(fields).length > 0) {
        const { error: updateError } = await db().from(T.links).update(fields).eq('id', link.id).eq('page_id', pageId);
        if (updateError) throw updateError;
      }
    }
  }

  ok(res, { links: (await allLinks(pageId)).map(ownerLink) });
});
