// GET   /api/me/page   the signed-in owner's page, links and security summary
// PATCH /api/me/page   { displayName?, bio? }

import { route, guard, readJson, ok } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, LIMITS } from '../_lib/validate.js';
import { limited } from '../_lib/guards.js';
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
    if (Object.keys(fields).length > 0) {
      const { error } = await db().from(T.pages).update(fields).eq('id', owner.page.id);
      if (error) throw error;
    }
  }

  ok(res, { page: await loadOwnerView(owner.page.id) });
});
