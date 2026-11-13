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
//   rename              { slug }                      -> { review, nextRenameAt }
//   delete-page         { confirmSlug }
//
// rename changes the page name, which is also what the owner signs in with.
// The new name follows the sign-up rules, and a name on the staff review
// list puts the page back in review until staff approve it; the staff
// Telegram chat hears about it. The old name is held for the page for 30
// days and sends visitors on to the new one; one rename every 30 days
// (_lib/slug-changes.js).
//
// The page must always keep at least one real second factor: removing the
// last one is refused rather than leaving the page on a password alone.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { checkPassword, checkSlug, cleanText, isUuid, LIMITS, STALE_PENDING_MS } from '../_lib/validate.js';
import { encryptSecret, decryptSecret, hashPassword } from '../_lib/crypto.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../_lib/totp.js';
import { limited, audit, slugRefusal, nameNeedsReview } from '../_lib/guards.js';
import { registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { createLinkToken, telegramConfigured, notifyStaff } from '../_lib/telegram.js';
import { renameReviewMessage } from '../_lib/telegram-messages.js';
import { slugHeldBy, lastRename, nextRenameAt, recordRename } from '../_lib/slug-changes.js';
import { siteUrl } from '../_lib/env.js';
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

export default route('me/security', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const owner = await requireOwner(request, response);
  if (!owner) return;
  const body = await readJson(request, response);
  if (!body) return;
  const page = owner.page;
  const action = String(body.action ?? '');

  if (!NO_PASSWORD.has(action)) {
    if (await limited(request, response, 'login', [`reauth:${page.id}`])) return;
    if (!(await pagePasswordOk(page.id, body.password))) {
      await audit(request, { action: 'security.reauth_failed', actorType: 'owner', actorId: page.id, pageId: page.id, details: { action } });
      return fail(response, 401, 'password_wrong');
    }
  } else if (await limited(request, response, 'secondFactor', [`page:${page.id}`])) {
    return;
  }

  const record = (name, details = {}) =>
    audit(request, { action: `security.${name}`, actorType: 'owner', actorId: page.id, pageId: page.id, details });
  const done = async (extra = {}) => ok(response, { ...extra, page: await loadOwnerView(page.id) });

  switch (action) {
    case 'totp-start': {
      if (page.totp_secret) return fail(response, 409, 'totp_exists');
      const secret = generateTotpSecret();
      const challenge = await createChallenge({
        realm: 'owner',
        purpose: 'enrol',
        subjectId: page.id,
        fields: { pending_totp_secret: encryptSecret(secret) },
      });
      return ok(response, { secret, uri: otpauthUri({ account: `links.gftv.asia/${page.slug}`, secret }), challenge });
    }

    case 'totp-finish': {
      const challenge = await findChallenge(body.challenge, 'owner', 'enrol');
      if (!challenge || challenge.subject_id !== page.id) return fail(response, 401, 'challenge_expired');
      const secret = decryptSecret(challenge.pending_totp_secret);
      if (!secret) return fail(response, 400, 'totp_not_started');
      if (!verifyTotp(body.code, secret)) {
        await failChallengeAttempt(challenge);
        return fail(response, 401, 'code_wrong');
      }
      const { error } = await database().from(TABLES.pages).update({ totp_secret: challenge.pending_totp_secret }).eq('id', page.id);
      if (error) throw error;
      await deleteChallenge(challenge);
      await record('totp_added');
      return done();
    }

    case 'totp-remove': {
      if (!page.totp_secret) return done();
      if ((await secondFactorCount(page)) <= 1) return fail(response, 409, 'last_factor');
      const { error } = await database().from(TABLES.pages).update({ totp_secret: null }).eq('id', page.id);
      if (error) throw error;
      await record('totp_removed');
      return done();
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
      if (!result.ok) return fail(response, 400, result.error);
      await record('passkey_added');
      return done();
    }

    case 'passkey-remove': {
      if (!isUuid(body.id)) return fail(response, 400, 'bad_request');
      if ((await secondFactorCount(page)) <= 1) return fail(response, 409, 'last_factor');
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
      if (!telegramConfigured()) return fail(response, 400, 'telegram_unavailable');
      const link = await createLinkToken(page.id);
      await record('telegram_link_started');
      return ok(response, link);
    }

    case 'telegram-unlink': {
      const { error } = await database().from(TABLES.pages).update({ telegram_chat_id: null, telegram_username: null }).eq('id', page.id);
      if (error) throw error;
      await record('telegram_unlinked');
      return done();
    }

    case 'password-change': {
      const check = checkPassword(body.newPassword);
      if (!check.ok) return fail(response, 400, check.error);
      const { error } = await database()
        .from(TABLES.pages)
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

    case 'rename': {
      const check = checkSlug(body.slug);
      if (!check.ok) return fail(response, 400, check.error);
      const slug = check.slug;
      if (slug === page.slug) return fail(response, 400, 'slug_same');
      const refusal = await slugRefusal(slug);
      if (refusal) return fail(response, 400, refusal);

      let last;
      try {
        last = await lastRename(page.id);
      } catch (cause) {
        if (cause.code === 'rename_unavailable') return fail(response, 503, 'rename_unavailable');
        throw cause;
      }
      const wait = nextRenameAt(last);
      if (wait) return fail(response, 429, 'rename_too_soon', { nextRenameAt: wait });

      // Another page's old name is held for it; this page's own is free to
      // take back.
      const holder = await slugHeldBy(slug);
      if (holder && holder !== page.id) return fail(response, 409, 'slug_taken');

      // A sign-up abandoned on this name releases it, as at registration.
      await database()
        .from(TABLES.pages)
        .delete()
        .eq('slug', slug)
        .eq('status', 'pending')
        .lt('created_at', new Date(Date.now() - STALE_PENDING_MS).toISOString());

      const review = await nameNeedsReview(slug);
      const fields = { slug, needs_review: review };
      // A name on the review list waits for approval, however long ago the
      // last one was approved.
      if (review) Object.assign(fields, { reviewed_at: null, reviewed_by: null });
      const { error } = await database().from(TABLES.pages).update(fields).eq('id', page.id);
      if (error) {
        if (error.code === '23505') return fail(response, 409, 'slug_taken');
        throw error;
      }
      await recordRename({ pageId: page.id, oldSlug: page.slug, newSlug: slug, neededReview: review });
      // The home page credits a testimonial to the page by name.
      const { error: quoteError } = await database().from(TABLES.testimonials).update({ page_slug: slug }).eq('page_id', page.id);
      if (quoteError) throw quoteError;
      await record('slug_changed', { from: page.slug, to: slug, review });

      if (review) {
        const sent = await notifyStaff(renameReviewMessage({
          oldSlug: page.slug,
          newSlug: slug,
          displayName: page.display_name || null,
          adminUrl: `${siteUrl()}/admin`,
        }));
        if (sent) await audit(request, { action: 'mod.staff_alerted', pageId: page.id, details: { about: 'slug_review', slug, chats: sent } });
      }
      return done({ review, nextRenameAt: nextRenameAt({ at: new Date().toISOString() }) });
    }

    case 'delete-page': {
      if (String(body.confirmSlug ?? '').trim().toLowerCase() !== page.slug) return fail(response, 400, 'confirm_slug');
      // Written before the delete, with the slug in the details, since the
      // page row and everything hanging off it is about to go.
      await record('page_deleted', { slug: page.slug });
      const { error } = await database().from(TABLES.pages).delete().eq('id', page.id);
      if (error) throw error;
      await deleteAvatarFile(page.avatar_path);
      await endOwnerSession(request, response);
      return ok(response, { deleted: true });
    }

    default:
      return fail(response, 400, 'bad_request');
  }
});
