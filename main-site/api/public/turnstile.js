// GET /api/public/turnstile
// The Turnstile site key for the protected forms (js/turnstile.js), or null
// when the check is off (no TURNSTILE_SECRET outside production) and the
// forms show no widget. The site key is public by design; the secret never
// leaves the server.

import { route, guard, ok } from '../_lib/http.js';
import { turnstileSiteKey } from '../_lib/turnstile.js';

export default route('public/turnstile', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  ok(res, { siteKey: turnstileSiteKey() });
});
