// GET  /api/auth/session   whether this browser is signed in to a page
// POST /api/auth/session   { action: "logout" }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { currentOwner, endOwnerSession } from '../_lib/session.js';

export default route('auth/session', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) return;

  if (request.method === 'GET') {
    const owner = await currentOwner(request);
    if (!owner || owner.page.status !== 'active') return ok(response, { signedIn: false });
    return ok(response, { signedIn: true, slug: owner.page.slug });
  }

  const body = await readJson(request, response);
  if (!body) return;
  if (body.action !== 'logout') return fail(response, 400, 'bad_request');
  await endOwnerSession(request, response);
  ok(response, { signedIn: false });
});
