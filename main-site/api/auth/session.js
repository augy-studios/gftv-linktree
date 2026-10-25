// GET  /api/auth/session   whether this browser is signed in to a page
// POST /api/auth/session   { action: "logout" }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { currentOwner, endOwnerSession } from '../_lib/session.js';

export default route('auth/session', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;

  if (req.method === 'GET') {
    const owner = await currentOwner(req);
    if (!owner || owner.page.status !== 'active') return ok(res, { signedIn: false });
    return ok(res, { signedIn: true, slug: owner.page.slug });
  }

  const body = await readJson(req, res);
  if (!body) return;
  if (body.action !== 'logout') return fail(res, 400, 'bad_request');
  await endOwnerSession(req, res);
  ok(res, { signedIn: false });
});
