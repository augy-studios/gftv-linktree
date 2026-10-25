// POST /api/auth/register { slug, password, turnstile }
//
// Creates the page in `pending` and returns an enrolment challenge. Nothing is
// public and nothing can be edited until a second factor is set up through
// /api/auth/enrol, which is what turns the page `active` and signs the owner in.
//
// Refused from a banned connection, and from a device banned with one
// (guards.js refusedForBan), which is flagged for staff. turnstile is the
// Cloudflare Turnstile token, checked when TURNSTILE_SECRET_KEY is set.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { checkSlug, checkPassword, STALE_PENDING_MS } from '../_lib/validate.js';
import { hashPassword } from '../_lib/crypto.js';
import { limited, slugRefusal, nameNeedsReview, audit, refusedForBan } from '../_lib/guards.js';
import { createChallenge } from '../_lib/session.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';

export default route('auth/register', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'register')) return;
  if (await refusedForTurnstile(req, res, body.turnstile, 'register')) return;
  if (await refusedForBan(req, res, { newPage: true })) return;

  const slugCheck = checkSlug(body.slug);
  if (!slugCheck.ok) return fail(res, 400, slugCheck.error);
  const passwordCheck = checkPassword(body.password);
  if (!passwordCheck.ok) return fail(res, 400, passwordCheck.error);
  const refusal = await slugRefusal(slugCheck.slug);
  if (refusal) return fail(res, 400, refusal);

  // Release this slug if somebody started on it and never finished.
  await db()
    .from(T.pages)
    .delete()
    .eq('slug', slugCheck.slug)
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - STALE_PENDING_MS).toISOString());

  const { data: page, error } = await db()
    .from(T.pages)
    .insert({
      slug: slugCheck.slug,
      password_hash: await hashPassword(body.password),
      status: 'pending',
      needs_review: await nameNeedsReview(slugCheck.slug),
    })
    .select('id, slug, needs_review')
    .single();
  if (error) {
    if (error.code === '23505') return fail(res, 409, 'slug_taken');
    throw error;
  }

  const challenge = await createChallenge({ realm: 'owner', purpose: 'enrol', subjectId: page.id });
  await audit(req, { action: 'page.register', actorType: 'owner', actorId: page.id, pageId: page.id, details: { slug: page.slug } });
  ok(res, { slug: page.slug, challenge, review: Boolean(page.needs_review) });
});
