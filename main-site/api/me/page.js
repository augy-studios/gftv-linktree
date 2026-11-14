// GET   /api/me/page   the signed-in owner's page, links and security summary
// PATCH /api/me/page   { displayName?, bio?, redirectUrl? }
//
// redirectUrl turns the page into a redirect: visitors are sent on to that one
// address instead of seeing the links, which are kept for when it is turned
// off again with redirectUrl: "".

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, LIMITS } from '../_lib/validate.js';
import { limited, checkLinkUrl, noteRefusedLink, refusedForAttempts, addressRefusedInText, refusedForBan } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { loadOwnerView } from '../_lib/owner-view.js';

// Signs the owner in. A PATCH then applies the write rate limit and the ban
// check, checks each field it carries and saves them. Both methods answer
// the editor view.
export default route('me/page', async (request, response) => {
  if (guard(request, response, ['GET', 'PATCH'])) {
    return;
  }
  const owner = await requireOwner(request, response);
  if (!owner) {
    return;
  }

  if (request.method === 'PATCH') {
    const body = await readJson(request, response);
    if (!body) {
      return;
    }
    if (await limited(request, response, 'ownerWrite', [`page:${owner.page.id}`])) {
      return;
    }
    if (await refusedForBan(request, response, { pageId: owner.page.id })) {
      return;
    }
    const fields = {};
    if (body.displayName !== undefined) {
      fields.display_name = cleanText(body.displayName, LIMITS.displayName);
    }
    if (body.bio !== undefined) {
      fields.bio = cleanText(body.bio, LIMITS.bio, { multiline: true });
    }
    // An address typed into the name or bio follows the rules for links.
    if (fields.display_name !== undefined || fields.bio !== undefined) {
      const refused = await addressRefusedInText(fields.display_name, fields.bio);
      if (refused) {
        await noteRefusedLink(request, owner.page, refused.error, `https://${refused.host}/`);
        return fail(response, 400, 'text_address', { host: refused.host });
      }
    }
    if (body.redirectUrl !== undefined) {
      if (body.redirectUrl === null || String(body.redirectUrl).trim() === '') {
        fields.redirect_url = null;
      } else {
        if (await refusedForAttempts(request, response)) {
          return;
        }
        const urlCheck = await checkLinkUrl(body.redirectUrl);
        if (!urlCheck.ok) {
          await noteRefusedLink(request, owner.page, urlCheck.error, body.redirectUrl);
          return fail(response, 400, urlCheck.error);
        }
        fields.redirect_url = urlCheck.url;
      }
    }
    if (Object.keys(fields).length > 0) {
      const { error } = await database().from(TABLES.pages).update(fields).eq('id', owner.page.id);
      if (error) {
        throw error;
      }
    }
  }

  ok(response, { page: await loadOwnerView(owner.page.id) });
});
