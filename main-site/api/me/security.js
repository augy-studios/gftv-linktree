// POST /api/me/security { action, password, ... }
//
// Every change to how the page is locked asks for the current password again,
// so a session left open on a shared computer cannot be turned into a
// permanent takeover. Answers carry the refreshed editor view.
//
//   totp-start          -> { secret, uri, challenge }
//   totp-finish         { challenge, code }           (no password: totp-start had it)
//   totp-remove
//   passkey-options     -> { options }
//   passkey-finish      { response, label }           (no password: passkey-options had it)
//   passkey-remove      { id }
//   backup-regenerate   -> { backupCodes }
//   telegram-link       -> { url, expiresInMinutes }
//   telegram-unlink
//   password-change     { newPassword }               signs out every other device
//   sessions-end-others
//   delete-page         { confirmSlug }
//
// The page must always keep at least one real second factor: removing the
// last one is refused rather than leaving the page on a password alone.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { checkPassword, cleanText, isUuid, LIMITS } from '../_lib/validate.js';
import { encryptSecret, decryptSecret, hashPassword } from '../_lib/crypto.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../_lib/totp.js';
import { limited, audit } from '../_lib/guards.js';
import { registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { createLinkToken, telegramConfigured } from '../_lib/telegram.js';
import { issueBackupCodes, secondFactorCount, pagePasswordOk } from '../_lib/factors.js';
import { loadOwnerView } from '../_lib/owner-view.js';
import { deleteAvatarFile } from '../_lib/avatar.js';
import {
  requireOwner,
  endAllOwnerSessions,
  endOwnerSession,
  createChallenge,
  findChallenge,
  failChallengeAttempt,
  deleteChallenge,
} from '../_lib/session.js';

const NO_PASSWORD = new Set(['totp-finish', 'passkey-finish']);

export default route('me/security', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const owner = await requireOwner(req, res);
  if (!owner) return;
  const body = await readJson(req, res);
  if (!body) return;
  const page = owner.page;
  const action = String(body.action ?? '');

  if (!NO_PASSWORD.has(action)) {
    if (await limited(req, res, 'login', [`reauth:${page.id}`])) return;
    if (!(await pagePasswordOk(page.id, body.password))) {
      await audit(req, { action: 'security.reauth_failed', actorType: 'owner', actorId: page.id, pageId: page.id, details: { action } });
      return fail(res, 401, 'password_wrong');
    }
  } else if (await limited(req, res, 'secondFactor', [`page:${page.id}`])) {
    return;
  }

  const record = (name, details = {}) =>
    audit(req, { action: `security.${name}`, actorType: 'owner', actorId: page.id, pageId: page.id, details });
  const done = async (extra = {}) => ok(res, { ...extra, page: await loadOwnerView(page.id) });

  switch (action) {
    case 'totp-start': {
      if (page.totp_secret) return fail(res, 409, 'totp_exists');
      const secret = generateTotpSecret();
      const challenge = await createChallenge({
        realm: 'owner',
        purpose: 'enrol',
        subjectId: page.id,
        fields: { pending_totp_secret: encryptSecret(secret) },
      });
      return ok(res, { secret, uri: otpauthUri({ account: `links.gftv.asia/${page.slug}`, secret }), challenge });
    }

    case 'totp-finish': {
      const challenge = await findChallenge(body.challenge, 'owner', 'enrol');
      if (!challenge || challenge.subject_id !== page.id) return fail(res, 401, 'challenge_expired');
      const secret = decryptSecret(challenge.pending_totp_secret);
      if (!secret) return fail(res, 400, 'totp_not_started');
      if (!verifyTotp(body.code, secret)) {
        await failChallengeAttempt(challenge);
        return fail(res, 401, 'code_wrong');
      }
      const { error } = await db().from(T.pages).update({ totp_secret: challenge.pending_totp_secret }).eq('id', page.id);
      if (error) throw error;
      await deleteChallenge(challenge);
      await record('totp_added');
      return done();
    }

    case 'totp-remove': {
      if (!page.totp_secret) return done();
      if ((await secondFactorCount(page)) <= 1) return fail(res, 409, 'last_factor');
      const { error } = await db().from(T.pages).update({ totp_secret: null }).eq('id', page.id);
      if (error) throw error;
      await record('totp_removed');
      return done();
    }

    case 'passkey-options': {
      const options = await registrationOptions('owner', { subjectId: page.id, userName: page.slug });
      return ok(res, { options });
    }

    case 'passkey-finish': {
      const result = await finishRegistration('owner', {
        subjectId: page.id,
        response: body.response,
        label: cleanText(body.label, LIMITS.label),
      });
      if (!result.ok) return fail(res, 400, result.error);
      await record('passkey_added');
      return done();
    }

    case 'passkey-remove': {
      if (!isUuid(body.id)) return fail(res, 400, 'bad_request');
      if ((await secondFactorCount(page)) <= 1) return fail(res, 409, 'last_factor');
      await removePasskey('owner', page.id, body.id);
      await record('passkey_removed');
      return done();
    }

    case 'backup-regenerate': {
      const backupCodes = await issueBackupCodes(page.id);
      await record('backup_codes_regenerated');
      return done({ backupCodes });
    }

    case 'telegram-link': {
      if (!telegramConfigured()) return fail(res, 400, 'telegram_unavailable');
      const link = await createLinkToken(page.id);
      await record('telegram_link_started');
      return ok(res, link);
    }

    case 'telegram-unlink': {
      const { error } = await db().from(T.pages).update({ telegram_chat_id: null, telegram_username: null }).eq('id', page.id);
      if (error) throw error;
      await record('telegram_unlinked');
      return done();
    }

    case 'password-change': {
      const check = checkPassword(body.newPassword);
      if (!check.ok) return fail(res, 400, check.error);
      const { error } = await db()
        .from(T.pages)
        .update({ password_hash: await hashPassword(body.newPassword), password_changed_at: new Date().toISOString() })
        .eq('id', page.id);
      if (error) throw error;
      await endAllOwnerSessions(page.id, owner.sessionId);
      await record('password_changed');
      return done();
    }

    case 'sessions-end-others': {
      await endAllOwnerSessions(page.id, owner.sessionId);
      await record('sessions_ended');
      return done();
    }

    case 'delete-page': {
      if (String(body.confirmSlug ?? '').trim().toLowerCase() !== page.slug) return fail(res, 400, 'confirm_slug');
      // Written before the delete, with the slug in the details, since the
      // page row and everything hanging off it is about to go.
      await record('page_deleted', { slug: page.slug });
      const { error } = await db().from(T.pages).delete().eq('id', page.id);
      if (error) throw error;
      await deleteAvatarFile(page.avatar_path);
      await endOwnerSession(req, res);
      return ok(res, { deleted: true });
    }

    default:
      return fail(res, 400, 'bad_request');
  }
});
