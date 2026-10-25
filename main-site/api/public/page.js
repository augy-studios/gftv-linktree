// GET /api/public/page?slug=name
// A page as visitors see it: name, bio, and the links that are being served.

import { route, guard, ok, fail, query } from '../_lib/http.js';
import { loadPublicPage } from '../_lib/public-page.js';

export default route('public/page', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  const result = await loadPublicPage(query(req, 'slug'));
  if (result.state === 'missing') return fail(res, 404, 'page_not_found');
  if (result.state === 'banned') return fail(res, 410, 'page_unavailable');
  ok(res, { page: result.page });
});
