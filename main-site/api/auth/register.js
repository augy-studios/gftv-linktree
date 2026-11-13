// POST /api/auth/register { slug, password, cf-turnstile-response }
//
// Creates the page in `pending` and returns an enrolment challenge. Nothing is
// public and nothing can be edited until a second factor is set up through
// /api/auth/enrol, which is what turns the page `active` and signs the owner in.
//
// Refused from a banned connection, and from a device banned with one
// (guards.js refusedForBan), which is flagged for staff. cf-turnstile-response
// is the Cloudflare Turnstile token for action "register" (_lib/turnstile.js).

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { checkSlug, checkPassword, STALE_PENDING_MS } from '../_lib/validate.js';
import { hashPassword } from '../_lib/crypto.js';
import { limited, slugRefusal, nameNeedsReview, audit, refusedForBan } from '../_lib/guards.js';
import { createChallenge } from '../_lib/session.js';
import { slugHeldBy } from '../_lib/slug-changes.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';

export default route('auth/register', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const body = await readJson(request, response);
  if (!body) return;
  if (await limited(request, response, 'register')) return;
  if (await refusedForTurnstile(request, response, body, 'register')) return;
  if (await refusedForBan(request, response, { newPage: true })) return;

  const slugCheck = checkSlug(body.slug);
  if (!slugCheck.ok) return fail(response, 400, slugCheck.error);
  const passwordCheck = checkPassword(body.password);
  if (!passwordCheck.ok) return fail(response, 400, passwordCheck.error);
  const refusal = await slugRefusal(slugCheck.slug);
  if (refusal) return fail(response, 400, refusal);
  // A name a page was renamed away from is held for that page for a while.
  if (await slugHeldBy(slugCheck.slug)) return fail(response, 409, 'slug_taken');

  // Release this slug if somebody started on it and never finished.
  await database()
    .from(TABLES.pages)
    .delete()
    .eq('slug', slugCheck.slug)
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - STALE_PENDING_MS).toISOString());

  const { data: page, error } = await database()
    .from(TABLES.pages)
    .insert({
      slug: slugCheck.slug,
      password_hash: await hashPassword(body.password),
      status: 'pending',
      needs_review: await nameNeedsReview(slugCheck.slug),
    })
    .select('id, slug, needs_review')
    .single();
  if (error) {
    if (error.code === '23505') return fail(response, 409, 'slug_taken');
    throw error;
  }

  const challenge = await createChallenge({ realm: 'owner', purpose: 'enrol', subjectId: page.id });
  await audit(request, { action: 'page.register', actorType: 'owner', actorId: page.id, pageId: page.id, details: { slug: page.slug } });
  ok(response, { slug: page.slug, challenge, review: Boolean(page.needs_review) });
});
