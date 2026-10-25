// GET /api/slug?slug=name
// Live availability for the claim field on the home and sign-up pages, and
// whether a free name would need staff approval before the page goes live.

import { route, guard, ok, query } from './_lib/http.js';
import { db, T } from './_lib/supabase.js';
import { checkSlug, STALE_PENDING_MS } from './_lib/validate.js';
import { limited, slugRefusal, nameNeedsReview } from './_lib/guards.js';

export default route('slug', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  if (await limited(req, res, 'slugCheck')) return;

  const check = checkSlug(query(req, 'slug'));
  if (!check.ok) return ok(res, { available: false, reason: check.error });
  const refusal = await slugRefusal(check.slug);
  if (refusal) return ok(res, { available: false, reason: refusal });

  const { data, error } = await db()
    .from(T.pages)
    .select('status, created_at')
    .eq('slug', check.slug)
    .maybeSingle();
  if (error) throw error;

  // A page abandoned during setup releases its slug after an hour.
  const abandoned =
    data && data.status === 'pending' && Date.now() - new Date(data.created_at).getTime() > STALE_PENDING_MS;
  const available = !data || abandoned;
  // review: free, but the page waits for staff approval before going live.
  const review = available ? await nameNeedsReview(check.slug) : false;
  ok(res, { available, slug: check.slug, reason: available ? null : 'slug_taken', review });
});
