// GET   /api/me/page   the signed-in owner's page, links and security summary
// PATCH /api/me/page   { displayName?, bio?, redirectUrl? }
//
// redirectUrl turns the page into a redirect: visitors are sent on to that one
// address instead of seeing the links, which are kept for when it is turned
// off again with redirectUrl: "".

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, LIMITS } from '../_lib/validate.js';
import { limited, checkLinkUrl, noteRefusedLink, refusedForAttempts, addressRefusedInText } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { loadOwnerView } from '../_lib/owner-view.js';

export default route('me/page', async (req, res) => {
  if (guard(req, res, ['GET', 'PATCH'])) return;
  const owner = await requireOwner(req, res);
  if (!owner) return;

  if (req.method === 'PATCH') {
    const body = await readJson(req, res);
    if (!body) return;
    if (await limited(req, res, 'ownerWrite', [`page:${owner.page.id}`])) return;
    const fields = {};
    if (body.displayName !== undefined) fields.display_name = cleanText(body.displayName, LIMITS.displayName);
    if (body.bio !== undefined) fields.bio = cleanText(body.bio, LIMITS.bio, { multiline: true });
    // An address typed into the name or bio follows the rules for links.
    if (fields.display_name !== undefined || fields.bio !== undefined) {
      const refused = await addressRefusedInText(fields.display_name, fields.bio);
      if (refused) {
        await noteRefusedLink(req, owner.page, refused.error, `https://${refused.host}/`);
        return fail(res, 400, 'text_address', { host: refused.host });
      }
    }
    if (body.redirectUrl !== undefined) {
      if (body.redirectUrl === null || String(body.redirectUrl).trim() === '') {
        fields.redirect_url = null;
      } else {
        if (await refusedForAttempts(req, res)) return;
        const url = await checkLinkUrl(body.redirectUrl);
        if (!url.ok) {
          await noteRefusedLink(req, owner.page, url.error, body.redirectUrl);
          return fail(res, 400, url.error);
        }
        fields.redirect_url = url.url;
      }
    }
    if (Object.keys(fields).length > 0) {
      const { error } = await db().from(T.pages).update(fields).eq('id', owner.page.id);
      if (error) throw error;
    }
  }

  ok(res, { page: await loadOwnerView(owner.page.id) });
});
