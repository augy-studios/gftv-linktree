// POST /api/auth/enrol { challenge, action, ... }
//
// The first second factor for a new page. Either one completes setup:
//
//   totp-start      -> { secret, uri }    a new authenticator secret, held on
//                                         the challenge until it is confirmed
//   totp-finish     { code }
//   passkey-options -> { options }
//   passkey-finish  { response, label }
//
// Finishing activates the page, issues ten backup codes (shown once), and
// signs the owner in.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { encryptSecret, decryptSecret } from '../_lib/crypto.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../_lib/totp.js';
import { registrationOptions, finishRegistration } from '../_lib/webauthn.js';
import { cleanText, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { issueBackupCodes } from '../_lib/factors.js';
import { notifyStaff } from '../_lib/telegram.js';
import { newPageReviewMessage } from '../_lib/telegram-messages.js';
import { siteUrl } from '../_lib/env.js';
import {
  findChallenge,
  failChallengeAttempt,
  updateChallenge,
  deleteChallenge,
  createOwnerSession,
} from '../_lib/session.js';

export default route('auth/enrol', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const body = await readJson(request, response);
  if (!body) return;
  if (await limited(request, response, 'secondFactor')) return;

  const challenge = await findChallenge(body.challenge, 'owner', 'enrol');
  if (!challenge) return fail(response, 401, 'challenge_expired');

  const { data: page, error } = await database()
    .from(TABLES.pages)
    .select('id, slug, status, needs_review')
    .eq('id', challenge.subject_id)
    .maybeSingle();
  if (error) throw error;
  if (!page || page.status !== 'pending') {
    await deleteChallenge(challenge);
    return fail(response, 401, 'challenge_expired');
  }

  switch (body.action) {
    case 'totp-start': {
      const secret = generateTotpSecret();
      await updateChallenge(challenge, { pending_totp_secret: encryptSecret(secret) });
      return ok(response, { secret, uri: otpauthUri({ account: `links.gftv.asia/${page.slug}`, secret }) });
    }

    case 'totp-finish': {
      const secret = decryptSecret(challenge.pending_totp_secret);
      if (!secret) return fail(response, 400, 'totp_not_started');
      if (!verifyTotp(body.code, secret)) {
        await failChallengeAttempt(challenge);
        return fail(response, 401, 'code_wrong');
      }
      return activate(request, response, page, challenge, { totp_secret: challenge.pending_totp_secret }, 'totp');
    }

    case 'passkey-options': {
      const options = await registrationOptions('owner', { subjectId: page.id, userName: page.slug });
      return ok(response, { options });
    }

    case 'passkey-finish': {
      const result = await finishRegistration('owner', {
        subjectId: page.id,
        response: body.response,
        label: cleanText(body.label, LIMITS.label),
      });
      if (!result.ok) {
        await failChallengeAttempt(challenge);
        return fail(response, 400, result.error);
      }
      return activate(request, response, page, challenge, {}, 'passkey');
    }

    default:
      return fail(response, 400, 'bad_request');
  }
});

async function activate(request, response, page, challenge, fields, method) {
  const now = new Date().toISOString();
  const { data, error } = await database()
    .from(TABLES.pages)
    .update({ ...fields, status: 'active', activated_at: now })
    .eq('id', page.id)
    .eq('status', 'pending')
    .select('id');
  if (error) throw error;
  if ((data ?? []).length !== 1) return fail(response, 409, 'challenge_expired');

  const backupCodes = await issueBackupCodes(page.id);
  await deleteChallenge(challenge);
  await createOwnerSession(response, page.id);
  await audit(request, { action: 'page.activate', actorType: 'owner', actorId: page.id, pageId: page.id, details: { method } });
  // A name on the review list: the page is set up but hidden, so staff hear
  // about it now rather than at registration, which may never be finished.
  if (page.needs_review) {
    const sent = await notifyStaff(newPageReviewMessage({ slug: page.slug, adminUrl: `${siteUrl()}/admin` }));
    if (sent) await audit(request, { action: 'mod.staff_alerted', pageId: page.id, details: { about: 'new_page_review', slug: page.slug, chats: sent } });
  }
  ok(response, { slug: page.slug, backupCodes });
}
