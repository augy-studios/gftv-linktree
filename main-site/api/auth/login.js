// POST /api/auth/login { slug, password, cf-turnstile-response }
//
// The password step. Issues nothing the browser can edit with: only a
// challenge token and the list of second factors this page can use, which
// /api/auth/verify then accepts. cf-turnstile-response is the Cloudflare
// Turnstile token for action "login" (_lib/turnstile.js), checked before the
// password so guessing passwords needs a passed check each time.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { normaliseSlug } from '../_lib/validate.js';
import { verifyPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit, noteBannedVisitor } from '../_lib/guards.js';
import { createChallenge } from '../_lib/session.js';
import { countPasskeys } from '../_lib/webauthn.js';
import { telegramConfigured } from '../_lib/telegram.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';

export default route('auth/login', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const body = await readJson(request, response);
  if (!body) return;

  const slug = normaliseSlug(body.slug).slice(0, 40);
  if (await limited(request, response, 'login', [`slug:${sha256(slug)}`])) return;
  if (await refusedForTurnstile(request, response, body, 'login')) return;

  const { data: page, error } = await database()
    .from(TABLES.pages)
    .select('id, slug, status, password_hash, totp_secret, telegram_chat_id')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;

  // Always one bcrypt compare, so an unknown slug answers in the same time.
  const passwordOk = await verifyPassword(body.password, page?.password_hash);
  if (!page || !passwordOk || page.status === 'pending') {
    if (page) {
      await audit(request, { action: 'login.failed', actorType: 'visitor', pageId: page.id, details: { step: 'password' } });
    }
    return fail(response, 401, 'invalid_credentials');
  }
  if (page.status === 'banned') return fail(response, 403, 'page_banned');
  // A device from a banned connection still signs in; staff are told.
  await noteBannedVisitor(request, page.id);

  const methods = {
    totp: Boolean(page.totp_secret),
    passkey: (await countPasskeys('owner', page.id)) > 0,
    backup: true,
    telegram: Boolean(page.telegram_chat_id) && telegramConfigured(),
  };
  const challenge = await createChallenge({ realm: 'owner', purpose: 'login', subjectId: page.id });
  ok(response, { challenge, methods });
});
