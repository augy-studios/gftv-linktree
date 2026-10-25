// POST /api/auth/register { slug, password }
//
// Creates the page in `pending` and returns an enrolment challenge. Nothing is
// public and nothing can be edited until a second factor is set up through
// /api/auth/enrol, which is what turns the page `active` and signs the owner in.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { checkSlug, checkPassword, STALE_PENDING_MS } from '../_lib/validate.js';
import { hashPassword } from '../_lib/crypto.js';
import { limited, slugIsBlocked, audit } from '../_lib/guards.js';
import { createChallenge } from '../_lib/session.js';

export default route('auth/register', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'register')) return;

  const slugCheck = checkSlug(body.slug);
  if (!slugCheck.ok) return fail(res, 400, slugCheck.error);
  const passwordCheck = checkPassword(body.password);
  if (!passwordCheck.ok) return fail(res, 400, passwordCheck.error);
  if (await slugIsBlocked(slugCheck.slug)) return fail(res, 400, 'slug_reserved');

  // Release this slug if somebody started on it and never finished.
  await db()
    .from(T.pages)
    .delete()
    .eq('slug', slugCheck.slug)
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - STALE_PENDING_MS).toISOString());

  const { data: page, error } = await db()
    .from(T.pages)
    .insert({ slug: slugCheck.slug, password_hash: await hashPassword(body.password), status: 'pending' })
    .select('id, slug')
    .single();
  if (error) {
    if (error.code === '23505') return fail(res, 409, 'slug_taken');
    throw error;
  }

  const challenge = await createChallenge({ realm: 'owner', purpose: 'enrol', subjectId: page.id });
  await audit(req, { action: 'page.register', actorType: 'owner', actorId: page.id, pageId: page.id, details: { slug: page.slug } });
  ok(res, { slug: page.slug, challenge });
});
