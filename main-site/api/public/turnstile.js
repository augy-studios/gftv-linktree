// GET /api/public/turnstile
// The Turnstile site key for the sign-up and report forms (js/turnstile.js),
// or null when TURNSTILE_SITE_KEY is not set and the forms show no widget.
// The site key is public by design; the secret key never leaves the server.

import { route, guard, ok } from '../_lib/http.js';
import { turnstileSiteKey } from '../_lib/turnstile.js';

export default route('public/turnstile', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  ok(res, { siteKey: turnstileSiteKey() });
});
