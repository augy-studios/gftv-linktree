// The signed-in owner's links. Every answer is the full, ordered list.
//
// POST   { title, url, icon }               add a link at the end
// POST   { action: "reorder", ids: [...] }   save a new order
// PATCH  { id, title?, url?, icon?, isActive? }
// DELETE { id }
//
// A link staff have removed cannot be edited or deleted by its owner, so the
// moderation record survives. The owner sees that it was removed and why.
//
// Adding one is refused with too_many_links (and the limit) once the page is
// at its link limit (link-cap.js). Removed links do not count towards it.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, checkIcon, isUuid, LIMITS, MAX_LINKS } from '../_lib/validate.js';
import { limited, checkLinkUrl, noteRefusedLink, refusedForAttempts, addressRefusedInText, refusedForBan } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { ownerLink, ownerLinkCap } from '../_lib/serialize.js';
import { linkCapFor, linksUsed, isCapRefusal } from '../_lib/link-cap.js';

const LINK_COLUMNS = 'id, title, url, icon, order_index, is_active, click_count, removed_at, removed_reason';

async function allLinks(pageId) {
  const { data, error } = await database().from(TABLES.links).select(LINK_COLUMNS).eq('page_id', pageId).order('order_index');
  if (error) throw error;
  return data ?? [];
}

export default route('me/links', async (request, response) => {
  if (guard(request, response, ['POST', 'PATCH', 'DELETE'])) return;
  const owner = await requireOwner(request, response);
  if (!owner) return;
  const body = await readJson(request, response);
  if (!body) return;
  if (await limited(request, response, 'ownerWrite', [`page:${owner.page.id}`])) return;
  if (await refusedForBan(request, response, { pageId: owner.page.id })) return;
  const pageId = owner.page.id;
  // A refused address also counts towards quarantine (guards.js).
  const refuse = async (url, input) => {
    await noteRefusedLink(request, owner.page, url.error, input);
    return fail(response, 400, url.error);
  };
  if (body.url !== undefined && (await refusedForAttempts(request, response))) return;
  // A title is shown as the link's text, so an address in it is checked too.
  const titleRefused = async (title) => {
    const refused = await addressRefusedInText(title);
    if (!refused) return false;
    await noteRefusedLink(request, owner.page, refused.error, `https://${refused.host}/`);
    fail(response, 400, 'text_address', { host: refused.host });
    return true;
  };

  if (request.method === 'POST' && body.action === 'reorder') {
    const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid).slice(0, MAX_LINKS) : [];
    const { error } = await database().rpc('gftvonelink_reorder_links', { p_page_id: pageId, p_ids: ids });
    if (error) throw error;
  } else if (request.method === 'POST') {
    const [existing, cap] = await Promise.all([allLinks(pageId), linkCapFor(pageId)]);
    if (linksUsed(existing) >= cap.limit) return fail(response, 400, 'too_many_links', { limit: cap.limit });
    const title = cleanText(body.title, LIMITS.title);
    if (!title) return fail(response, 400, 'title_required');
    if (await titleRefused(title)) return;
    const url = await checkLinkUrl(body.url, { mail: true });
    if (!url.ok) return refuse(url, body.url);
    const nextIndex = existing.reduce((max, l) => Math.max(max, l.order_index), -1) + 1;
    const { error } = await database()
      .from(TABLES.links)
      .insert({ page_id: pageId, title, url: url.url, icon: checkIcon(body.icon), order_index: nextIndex });
    // Another add got in first and filled the last place (the trigger in 013).
    if (isCapRefusal(error)) return fail(response, 400, 'too_many_links', { limit: cap.limit });
    if (error) throw error;
  } else {
    if (!isUuid(body.id)) return fail(response, 400, 'bad_request');
    const { data: link, error } = await database()
      .from(TABLES.links)
      .select('id, removed_at')
      .eq('id', body.id)
      .eq('page_id', pageId)
      .maybeSingle();
    if (error) throw error;
    if (!link) return fail(response, 404, 'link_not_found');
    if (link.removed_at) return fail(response, 403, 'link_removed');

    if (request.method === 'DELETE') {
      const { error: deleteError } = await database().from(TABLES.links).delete().eq('id', link.id).eq('page_id', pageId);
      if (deleteError) throw deleteError;
    } else {
      const fields = {};
      if (body.title !== undefined) {
        fields.title = cleanText(body.title, LIMITS.title);
        if (!fields.title) return fail(response, 400, 'title_required');
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
        const { error: updateError } = await database().from(TABLES.links).update(fields).eq('id', link.id).eq('page_id', pageId);
        if (updateError) throw updateError;
      }
    }
  }

  const [links, cap] = await Promise.all([allLinks(pageId), linkCapFor(pageId)]);
  ok(response, { links: links.map(ownerLink), linkCap: ownerLinkCap(cap, linksUsed(links)) });
});
