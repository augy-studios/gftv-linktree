// GET /api/slug?slug=name
// Live availability for the claim field on the home and sign-up pages, and
// whether a free name would need staff approval before the page goes live.
// Also used by the editor's rename form: a name another page renamed away
// from in the last 30 days is held for it (_lib/slug-changes.js), and reads
// as taken to everyone but that page's signed-in owner.

import { route, guard, ok, query } from './_lib/http.js';
import { database, TABLES } from './_lib/supabase.js';
import { checkSlug, STALE_PENDING_MS } from './_lib/validate.js';
import { limited, slugRefusal, nameNeedsReview } from './_lib/guards.js';
import { slugHeldBy } from './_lib/slug-changes.js';
import { currentOwner } from './_lib/session.js';

export default route('slug', async (request, response) => {
  if (guard(request, response, ['GET'])) return;
  if (await limited(request, response, 'slugCheck')) return;

  const check = checkSlug(query(request, 'slug'));
  if (!check.ok) return ok(response, { available: false, reason: check.error });
  const refusal = await slugRefusal(check.slug);
  if (refusal) return ok(response, { available: false, reason: refusal });

  const { data, error } = await database()
    .from(TABLES.pages)
    .select('status, created_at')
    .eq('slug', check.slug)
    .maybeSingle();
  if (error) throw error;

  // A page abandoned during setup releases its slug after an hour.
  const abandoned =
    data && data.status === 'pending' && Date.now() - new Date(data.created_at).getTime() > STALE_PENDING_MS;
  let available = !data || abandoned;
  if (available) {
    const holder = await slugHeldBy(check.slug);
    if (holder) available = (await currentOwner(request))?.page.id === holder;
  }
  // review: free, but the page waits for staff approval before going live.
  const review = available ? await nameNeedsReview(check.slug) : false;
  ok(response, { available, slug: check.slug, reason: available ? null : 'slug_taken', review });
});
