// POST /api/auth/recover { action, ... }
//
// A forgotten password. There is no email, so recovery asks for two of the
// three things an owner can have, and the password is the one missing:
//
//   1. a Telegram code, sent to the chat linked in settings, and
//   2. the second factor: an authenticator code or a backup code.
//
// Without a linked Telegram account a forgotten password cannot be reset,
// and the page says so rather than offering a path that does not exist.
// A lost second factor is not this route: sign in with the password and a
// backup code instead.
//
//   start   { slug }  -> { telegram, challenge? }
//   send    { challenge }
//   finish  { challenge, telegramCode, factor: "totp" | "backup", code, newPassword }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { normaliseSlug, checkPassword } from '../_lib/validate.js';
import { hashPassword, sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { telegramConfigured, sendTelegram } from '../_lib/telegram.js';
import { ownerTotpOk, spendBackupCode, sendTelegramCode, telegramCodeOk } from '../_lib/factors.js';
import {
  createChallenge,
  findChallenge,
  failChallengeAttempt,
  deleteChallenge,
  createOwnerSession,
  endAllOwnerSessions,
} from '../_lib/session.js';

export default route('auth/recover', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;

  if (body.action === 'start') {
    const slug = normaliseSlug(body.slug).slice(0, 40);
    if (await limited(req, res, 'recover', [`slug:${sha256(slug)}`])) return;
    const { data: page, error } = await db()
      .from(T.pages)
      .select('id, status, telegram_chat_id')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    if (!page || page.status !== 'active') return fail(res, 404, 'page_not_found');
    if (!page.telegram_chat_id || !telegramConfigured()) return ok(res, { telegram: false });
    const challenge = await createChallenge({ realm: 'owner', purpose: 'recover', subjectId: page.id });
    return ok(res, { telegram: true, challenge });
  }

  const challenge = await findChallenge(body.challenge, 'owner', 'recover');
  if (!challenge) return fail(res, 401, 'challenge_expired');
  const { data: page, error } = await db()
    .from(T.pages)
    .select('id, slug, status, totp_secret, telegram_chat_id')
    .eq('id', challenge.subject_id)
    .maybeSingle();
  if (error) throw error;
  if (!page || page.status !== 'active' || !page.telegram_chat_id) {
    await deleteChallenge(challenge);
    return fail(res, 401, 'challenge_expired');
  }

  if (body.action === 'send') {
    if (await limited(req, res, 'telegramSend', [`page:${page.id}`])) return;
    await sendTelegramCode(challenge, page, 'reset');
    return ok(res, { sent: true });
  }

  if (body.action !== 'finish') return fail(res, 400, 'bad_request');
  if (await limited(req, res, 'secondFactor', [`challenge:${challenge.id}`])) return;

  const passwordCheck = checkPassword(body.newPassword);
  if (!passwordCheck.ok) return fail(res, 400, passwordCheck.error);

  // Telegram first, so a wrong Telegram code never spends a backup code.
  let passed = await telegramCodeOk(challenge, body.telegramCode);
  if (passed) {
    if (body.factor === 'totp') passed = ownerTotpOk(page, body.code);
    else if (body.factor === 'backup') passed = await spendBackupCode(page.id, body.code);
    else passed = false;
  }
  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(req, { action: 'recover.failed', actorType: 'visitor', pageId: page.id });
    return fail(res, 401, 'code_wrong');
  }

  const { error: updateError } = await db()
    .from(T.pages)
    .update({ password_hash: await hashPassword(body.newPassword), password_changed_at: new Date().toISOString() })
    .eq('id', page.id);
  if (updateError) throw updateError;

  await deleteChallenge(challenge);
  await endAllOwnerSessions(page.id);
  await createOwnerSession(res, page.id);
  await audit(req, { action: 'recover.password_reset', actorType: 'owner', actorId: page.id, pageId: page.id, details: { factor: body.factor } });
  sendTelegram(page.telegram_chat_id, `The password for links.gftv.asia/${page.slug} was just reset, and every other device was signed out.`).catch(
    (cause) => console.warn('[onelink] reset notice not sent:', cause?.message ?? cause)
  );
  ok(res, { slug: page.slug });
});
