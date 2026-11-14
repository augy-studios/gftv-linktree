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

// Checks the name's shape and the block lists, then whether a page has it
// (or held it after a rename), then whether a free name needs review.
export default route('slug', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  if (await limited(request, response, 'slugCheck')) {
    return;
  }

  const check = checkSlug(query(request, 'slug'));
  if (!check.ok) {
    return ok(response, { available: false, reason: check.error });
  }
  const refusal = await slugRefusal(check.slug);
  if (refusal) {
    return ok(response, { available: false, reason: refusal });
  }

  const { data, error } = await database()
    .from(TABLES.pages)
    .select('status, created_at')
    .eq('slug', check.slug)
    .maybeSingle();
  if (error) {
    throw error;
  }

  let available = true;
  if (data) {
    // A page abandoned during setup releases its slug after an hour.
    let abandoned = false;
    if (data.status === 'pending' && Date.now() - new Date(data.created_at).getTime() > STALE_PENDING_MS) {
      abandoned = true;
    }
    available = abandoned;
  }
  if (available) {
    const holder = await slugHeldBy(check.slug);
    if (holder) {
      // Held after a rename: free only to the page that holds it.
      const owner = await currentOwner(request);
      let ownerPageId;
      if (owner) {
        ownerPageId = owner.page.id;
      }
      available = ownerPageId === holder;
    }
  }
  // review: free, but the page waits for staff approval before going live.
  let review = false;
  if (available) {
    review = await nameNeedsReview(check.slug);
  }
  let reason = null;
  if (!available) {
    reason = 'slug_taken';
  }
  ok(response, { available, slug: check.slug, reason, review });
});
