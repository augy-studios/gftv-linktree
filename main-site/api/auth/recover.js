// POST /api/auth/recover { action, ... }
//
// A forgotten password. There is no email, so recovery asks for two of the
// three things an owner can have, and the password is the one missing:
//
//   1. a Telegram code, sent to the chat linked in settings, and
//   2. the second factor: an authenticator code, a passkey or a backup code.
//
// Without a linked Telegram account a forgotten password cannot be reset,
// and the page says so rather than offering a path that does not exist.
// A lost second factor is not this route: sign in with the password and a
// backup code instead.
//
//   start            { slug, cf-turnstile-response }  -> { telegram, challenge? }
//   send             { challenge }
//   passkey-options  { challenge, telegramCode }  -> { options }
//   finish           { challenge, telegramCode, factor: "totp" | "backup", code, newPassword }
//                    { challenge, telegramCode, factor: "passkey", response, newPassword }
//
// passkey-options wants the Telegram code too, so the page's credential ids
// are never handed to somebody who knows only its name. start wants a
// Cloudflare Turnstile token for action "recover" (_lib/turnstile.js); the
// later steps need its challenge, so the whole reset sits behind that check.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { normaliseSlug, checkPassword } from '../_lib/validate.js';
import { hashPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { telegramConfigured, sendTelegram } from '../_lib/telegram.js';
import { authenticationOptions, finishAuthentication } from '../_lib/webauthn.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';
import { ownerTotpOk, spendBackupCode, sendTelegramCode, telegramCodeOk } from '../_lib/factors.js';
import {
  createChallenge,
  findChallenge,
  failChallengeAttempt,
  deleteChallenge,
  createOwnerSession,
  endAllOwnerSessions,
} from '../_lib/session.js';

// start checks the name and Turnstile and opens a recover challenge; every
// later step needs that challenge and a live page with Telegram linked, then
// runs send, passkey-options or finish. finish checks the Telegram code before
// the second factor, sets the new password and signs every other device out.
export default route('auth/recover', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }

  if (body.action === 'start') {
    const slug = normaliseSlug(body.slug).slice(0, 40);
    if (await limited(request, response, 'recover', [`slug:${sha256(slug)}`])) {
      return;
    }
    if (await refusedForTurnstile(request, response, body, 'recover')) {
      return;
    }
    const { data: page, error } = await database()
      .from(TABLES.pages)
      .select('id, status, telegram_chat_id')
      .eq('slug', slug)
      .maybeSingle();
    if (error) {
      throw error;
    }
    if (!page || page.status !== 'active') {
      return fail(response, 404, 'page_not_found');
    }
    if (!page.telegram_chat_id || !telegramConfigured()) {
      return ok(response, { telegram: false });
    }
    const challenge = await createChallenge({ realm: 'owner', purpose: 'recover', subjectId: page.id });
    return ok(response, { telegram: true, challenge });
  }

  // Every later step: the challenge from start, for a page still live and
  // still linked to Telegram.
  const challenge = await findChallenge(body.challenge, 'owner', 'recover');
  if (!challenge) {
    return fail(response, 401, 'challenge_expired');
  }
  const { data: page, error } = await database()
    .from(TABLES.pages)
    .select('id, slug, status, totp_secret, telegram_chat_id')
    .eq('id', challenge.subject_id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!page || page.status !== 'active' || !page.telegram_chat_id) {
    await deleteChallenge(challenge);
    return fail(response, 401, 'challenge_expired');
  }

  if (body.action === 'send') {
    if (await limited(request, response, 'telegramSend', [`page:${page.id}`])) {
      return;
    }
    await sendTelegramCode(challenge, page, 'reset');
    return ok(response, { sent: true });
  }

  if (body.action === 'passkey-options') {
    if (await limited(request, response, 'secondFactor', [`challenge:${challenge.id}`])) {
      return;
    }
    if (!(await telegramCodeOk(challenge, body.telegramCode))) {
      await failChallengeAttempt(challenge);
      await audit(request, { action: 'recover.failed', actorType: 'visitor', pageId: page.id });
      return fail(response, 401, 'code_wrong');
    }
    const options = await authenticationOptions('owner', page.id);
    if (!options) {
      return fail(response, 400, 'no_passkeys');
    }
    return ok(response, { options });
  }

  if (body.action !== 'finish') {
    return fail(response, 400, 'bad_request');
  }
  if (await limited(request, response, 'secondFactor', [`challenge:${challenge.id}`])) {
    return;
  }

  const passwordCheck = checkPassword(body.newPassword);
  if (!passwordCheck.ok) {
    return fail(response, 400, passwordCheck.error);
  }

  // Telegram first, so a wrong Telegram code never spends a backup code or a
  // passkey challenge.
  let passed = await telegramCodeOk(challenge, body.telegramCode);
  if (passed) {
    if (body.factor === 'totp') {
      passed = ownerTotpOk(page, body.code);
    } else if (body.factor === 'backup') {
      passed = await spendBackupCode(page.id, body.code);
    } else if (body.factor === 'passkey') {
      passed = await finishAuthentication('owner', page.id, body.response);
    } else {
      passed = false;
    }
  }
  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(request, { action: 'recover.failed', actorType: 'visitor', pageId: page.id });
    return fail(response, 401, 'code_wrong');
  }

  const { error: updateError } = await database()
    .from(TABLES.pages)
    .update({ password_hash: await hashPassword(body.newPassword), password_changed_at: new Date().toISOString() })
    .eq('id', page.id);
  if (updateError) {
    throw updateError;
  }

  await deleteChallenge(challenge);
  await endAllOwnerSessions(page.id);
  await createOwnerSession(response, page.id);
  await audit(request, { action: 'recover.password_reset', actorType: 'owner', actorId: page.id, pageId: page.id, details: { factor: body.factor } });
  // Not awaited: the reset has happened whether or not the notice gets through.
  sendTelegram(page.telegram_chat_id, `The password for links.gftv.asia/${page.slug} was just reset, and every other device was signed out.`).catch(
    (cause) => {
      let detail = cause;
      if (cause !== null && cause !== undefined && cause.message !== null && cause.message !== undefined) {
        detail = cause.message;
      }
      console.warn('[onelink] reset notice not sent:', detail);
    }
  );
  ok(response, { slug: page.slug });
});
