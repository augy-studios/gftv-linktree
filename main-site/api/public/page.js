// GET /api/public/page?slug=name
// A page as visitors see it: name, bio, the links that are being served, and
// the address it redirects to when it is a redirect page.

import { route, guard, ok, fail, query } from '../_lib/http.js';
import { loadPublicPage } from '../_lib/public-page.js';

export default route('public/page', async (request, response) => {
  if (guard(request, response, ['GET'])) return;
  const result = await loadPublicPage(query(request, 'slug'));
  if (result.state === 'missing') return fail(response, 404, 'page_not_found');
  // Renamed: slug is the page's name now.
  if (result.state === 'moved') return fail(response, 404, 'page_moved', { slug: result.slug });
  if (result.state === 'banned') return fail(response, 410, 'page_unavailable');
  if (result.state === 'dormant') return fail(response, 410, 'page_dormant');
  if (result.state === 'review') return fail(response, 404, 'page_in_review');
  ok(response, { page: result.page });
});
