// POST /api/auth/login { slug, password }
//
// The password step. Issues nothing the browser can edit with: only a
// challenge token and the list of second factors this page can use, which
// /api/auth/verify then accepts.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { normaliseSlug } from '../_lib/validate.js';
import { verifyPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit, noteBannedVisitor } from '../_lib/guards.js';
import { createChallenge } from '../_lib/session.js';
import { countPasskeys } from '../_lib/webauthn.js';
import { telegramConfigured } from '../_lib/telegram.js';

export default route('auth/login', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;

  const slug = normaliseSlug(body.slug).slice(0, 40);
  if (await limited(req, res, 'login', [`slug:${sha256(slug)}`])) return;

  const { data: page, error } = await db()
    .from(T.pages)
    .select('id, slug, status, password_hash, totp_secret, telegram_chat_id')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;

  // Always one bcrypt compare, so an unknown slug answers in the same time.
  const passwordOk = await verifyPassword(body.password, page?.password_hash);
  if (!page || !passwordOk || page.status === 'pending') {
    if (page) {
      await audit(req, { action: 'login.failed', actorType: 'visitor', pageId: page.id, details: { step: 'password' } });
    }
    return fail(res, 401, 'invalid_credentials');
  }
  if (page.status === 'banned') return fail(res, 403, 'page_banned');
  // A device from a banned connection still signs in; staff are told.
  await noteBannedVisitor(req, page.id);

  const methods = {
    totp: Boolean(page.totp_secret),
    passkey: (await countPasskeys('owner', page.id)) > 0,
    backup: true,
    telegram: Boolean(page.telegram_chat_id) && telegramConfigured(),
  };
  const challenge = await createChallenge({ realm: 'owner', purpose: 'login', subjectId: page.id });
  ok(res, { challenge, methods });
});
