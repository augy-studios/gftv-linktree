// POST /api/auth/verify { challenge, method, code?, response? }
//
// The second step of signing in. method is one of:
//
//   totp             { code }       the authenticator app
//   backup           { code }       a one-time backup code, spent on use
//   passkey-options  -> { options }
//   passkey          { response }
//   telegram-send                   DM a six digit code to the linked chat
//   telegram         { code }
//
// The challenge row is the authorisation to be here. Five wrong answers
// spend it, and the owner starts again from the password.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { sha256 } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { authenticationOptions, finishAuthentication } from '../_lib/webauthn.js';
import { telegramConfigured } from '../_lib/telegram.js';
import { ownerTotpOk, spendBackupCode, sendTelegramCode, telegramCodeOk, backupCodesLeft } from '../_lib/factors.js';
import { findChallenge, failChallengeAttempt, deleteChallenge, createOwnerSession } from '../_lib/session.js';

export default route('auth/verify', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const body = await readJson(request, response);
  if (!body) return;
  const subject = `challenge:${sha256(String(body.challenge ?? ''))}`;
  if (await limited(request, response, 'secondFactor', [subject])) return;

  const challenge = await findChallenge(body.challenge, 'owner', 'login');
  if (!challenge) return fail(response, 401, 'challenge_expired');

  const { data: page, error } = await database()
    .from(TABLES.pages)
    .select('id, slug, status, totp_secret, telegram_chat_id')
    .eq('id', challenge.subject_id)
    .maybeSingle();
  if (error) throw error;
  if (!page || page.status !== 'active') {
    await deleteChallenge(challenge);
    return fail(response, 401, 'challenge_expired');
  }

  let passed = false;
  switch (body.method) {
    case 'totp':
      passed = ownerTotpOk(page, body.code);
      break;

    case 'backup':
      passed = await spendBackupCode(page.id, body.code);
      break;

    case 'passkey-options': {
      const options = await authenticationOptions('owner', page.id);
      if (!options) return fail(response, 400, 'no_passkeys');
      return ok(response, { options });
    }

    case 'passkey':
      passed = await finishAuthentication('owner', page.id, body.response);
      break;

    case 'telegram-send':
      if (!page.telegram_chat_id || !telegramConfigured()) return fail(response, 400, 'telegram_not_linked');
      if (await limited(request, response, 'telegramSend', [`page:${page.id}`])) return;
      await sendTelegramCode(challenge, page, 'sign-in');
      return ok(response, { sent: true });

    case 'telegram':
      passed = await telegramCodeOk(challenge, body.code);
      break;

    default:
      return fail(response, 400, 'bad_request');
  }

  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(request, { action: 'login.failed', actorType: 'visitor', pageId: page.id, details: { step: body.method } });
    return fail(response, 401, 'code_wrong');
  }

  await deleteChallenge(challenge);
  await createOwnerSession(response, page.id);
  await audit(request, { action: 'login.ok', actorType: 'owner', actorId: page.id, pageId: page.id, details: { method: body.method } });
  ok(response, { slug: page.slug, backupCodesLeft: await backupCodesLeft(page.id) });
});
