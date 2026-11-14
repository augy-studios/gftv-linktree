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

// The password again, except for totp-finish and passkey-finish (their
// first step asked for it), with the attempt counted against a rate limit
// either way. Returns true when the request has been answered: 429, or 401
// password_wrong after the failure is audited.
async function reauthRefused(request, response, page, action, body) {
  if (!NO_PASSWORD.has(action)) {
    if (await limited(request, response, 'login', [`reauth:${page.id}`])) {
      return true;
    }
    if (!(await pagePasswordOk(page.id, body.password))) {
      await audit(request, { action: 'security.reauth_failed', actorType: 'owner', actorId: page.id, pageId: page.id, details: { action } });
      fail(response, 401, 'password_wrong');
      return true;
    }
  } else if (await limited(request, response, 'secondFactor', [`page:${page.id}`])) {
    return true;
  }
  return false;
}

// The actions. Each one ends the request: with an error, or with its answer
// (most answer with the refreshed editor view through done()).

// totp-start: a new authenticator secret, held in a challenge until
// totp-finish shows the app has it.
async function totpStart({ response, page }) {
  if (page.totp_secret) {
    return fail(response, 409, 'totp_exists');
  }
  const secret = generateTotpSecret();
  const challenge = await createChallenge({
    realm: 'owner',
    purpose: 'enrol',
    subjectId: page.id,
    fields: { pending_totp_secret: encryptSecret(secret) },
  });
  return ok(response, { secret, uri: otpauthUri({ account: `links.gftv.asia/${page.slug}`, secret }), challenge });
}

// totp-finish: a code from the app proves it has the secret, which then
// becomes the page's.
async function totpFinish({ response, body, page, record, done }) {
  const challenge = await findChallenge(body.challenge, 'owner', 'enrol');
  if (!challenge || challenge.subject_id !== page.id) {
    return fail(response, 401, 'challenge_expired');
  }
  const secret = decryptSecret(challenge.pending_totp_secret);
  if (!secret) {
    return fail(response, 400, 'totp_not_started');
  }
  if (!verifyTotp(body.code, secret)) {
    await failChallengeAttempt(challenge);
    return fail(response, 401, 'code_wrong');
  }
  const { error } = await database().from(TABLES.pages).update({ totp_secret: challenge.pending_totp_secret }).eq('id', page.id);
  if (error) {
    throw error;
  }
  await deleteChallenge(challenge);
  await record('totp_added');
  return done();
}

// totp-remove: refused when it is the page's last second factor.
async function totpRemove({ response, page, record, done }) {
  if (!page.totp_secret) {
    return done();
  }
  if ((await secondFactorCount(page)) <= 1) {
    return fail(response, 409, 'last_factor');
  }
  const { error } = await database().from(TABLES.pages).update({ totp_secret: null }).eq('id', page.id);
  if (error) {
    throw error;
  }
  await record('totp_removed');
  return done();
}

// passkey-options: the browser's options for creating a passkey.
async function passkeyOptions({ response, page }) {
  const options = await registrationOptions('owner', { subjectId: page.id, userName: page.slug });
  return ok(response, { options });
}

// passkey-finish: the passkey the browser created.
async function passkeyFinish({ response, body, page, record, done }) {
  const result = await finishRegistration('owner', {
    subjectId: page.id,
    response: body.response,
    label: cleanText(body.label, LIMITS.label),
  });
  if (!result.ok) {
    return fail(response, 400, result.error);
  }
  await record('passkey_added');
  return done();
}

// passkey-remove: refused when it is the page's last second factor.
async function passkeyRemove({ response, body, page, record, done }) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  if ((await secondFactorCount(page)) <= 1) {
    return fail(response, 409, 'last_factor');
  }
  await removePasskey('owner', page.id, body.id);
  await record('passkey_removed');
  return done();
}

// backup-regenerate: ten new backup codes, shown once; the old ones stop
// working.
async function backupRegenerate({ page, record, done }) {
  const backupCodes = await issueBackupCodes(page.id);
  await record('backup_codes_regenerated');
  return done({ backupCodes });
}

// telegram-link: a link that opens the bot with a one-time token.
async function telegramLink({ response, page, record }) {
  if (!telegramConfigured()) {
    return fail(response, 400, 'telegram_unavailable');
  }
  const link = await createLinkToken(page.id);
  await record('telegram_link_started');
  return ok(response, link);
}

// telegram-unlink
async function telegramUnlink({ page, record, done }) {
  const { error } = await database().from(TABLES.pages).update({ telegram_chat_id: null, telegram_username: null }).eq('id', page.id);
  if (error) {
    throw error;
  }
  await record('telegram_unlinked');
  return done();
}

// password-change: signs out every other device.
async function passwordChange({ response, body, owner, page, record, done }) {
  const check = checkPassword(body.newPassword);
  if (!check.ok) {
    return fail(response, 400, check.error);
  }
  const { error } = await database()
    .from(TABLES.pages)
    .update({ password_hash: await hashPassword(body.newPassword), password_changed_at: new Date().toISOString() })
    .eq('id', page.id);
  if (error) {
    throw error;
  }
  await endAllOwnerSessions(page.id, owner.sessionId);
  await record('password_changed');
  return done();
}

// sessions-end-others: signs out every device but this one.
async function sessionsEndOthers({ owner, page, record, done }) {
  await endAllOwnerSessions(page.id, owner.sessionId);
  await record('sessions_ended');
  return done();
}

// rename, first half: the new name follows the sign-up rules, differs from
// the current one, waits out 30 days since the last rename, and is not
// another page's held old name. Returns the new name, or null once it has
// answered with the refusal.
async function checkRename({ response, body, page }) {
  const check = checkSlug(body.slug);
  if (!check.ok) {
    fail(response, 400, check.error);
    return null;
  }
  const slug = check.slug;
  if (slug === page.slug) {
    fail(response, 400, 'slug_same');
    return null;
  }
  const refusal = await slugRefusal(slug);
  if (refusal) {
    fail(response, 400, refusal);
    return null;
  }

  let last;
  try {
    last = await lastRename(page.id);
  } catch (cause) {
    if (cause.code === 'rename_unavailable') {
      fail(response, 503, 'rename_unavailable');
      return null;
    }
    throw cause;
  }
  const wait = nextRenameAt(last);
  if (wait) {
    fail(response, 429, 'rename_too_soon', { nextRenameAt: wait });
    return null;
  }

  // Another page's old name is held for it; this page's own is free to
  // take back.
  const holder = await slugHeldBy(slug);
  if (holder && holder !== page.id) {
    fail(response, 409, 'slug_taken');
    return null;
  }
  return slug;
}

// rename, second half: moves the page to the new name, holds the old one,
// moves its testimonials' credit, and alerts the staff chat when the name
// needs review. Ends the request: 409 slug_taken if the name went in the
// meantime, or the editor view with { review, nextRenameAt }.
async function applyRename({ request, response, page, record, done }, slug) {
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
  if (review) {
    Object.assign(fields, { reviewed_at: null, reviewed_by: null });
  }
  const { error } = await database().from(TABLES.pages).update(fields).eq('id', page.id);
  if (error) {
    if (error.code === '23505') {
      return fail(response, 409, 'slug_taken');
    }
    throw error;
  }
  await recordRename({ pageId: page.id, oldSlug: page.slug, newSlug: slug, neededReview: review });
  // The home page credits a testimonial to the page by name.
  const { error: quoteError } = await database().from(TABLES.testimonials).update({ page_slug: slug }).eq('page_id', page.id);
  if (quoteError) {
    throw quoteError;
  }
  await record('slug_changed', { from: page.slug, to: slug, review });

  if (review) {
    let displayName = page.display_name;
    if (!displayName) {
      displayName = null;
    }
    const sent = await notifyStaff(renameReviewMessage({
      oldSlug: page.slug,
      newSlug: slug,
      displayName,
      adminUrl: `${siteUrl()}/admin`,
    }));
    if (sent) {
      await audit(request, { action: 'mod.staff_alerted', pageId: page.id, details: { about: 'slug_review', slug, chats: sent } });
    }
  }
  return done({ review, nextRenameAt: nextRenameAt({ at: new Date().toISOString() }) });
}

// rename: the page name, which is also what the owner signs in with.
async function renamePage(context) {
  const slug = await checkRename(context);
  if (!slug) {
    // Refused, and already answered.
    return;
  }
  return applyRename(context, slug);
}

// delete-page: the owner types the page name to confirm. Signs them out.
async function deletePage({ request, response, body, page, record }) {
  let confirmSlug = body.confirmSlug;
  if (confirmSlug === null || confirmSlug === undefined) {
    confirmSlug = '';
  }
  if (String(confirmSlug).trim().toLowerCase() !== page.slug) {
    return fail(response, 400, 'confirm_slug');
  }
  // Written before the delete, with the slug in the details, since the
  // page row and everything hanging off it is about to go.
  await record('page_deleted', { slug: page.slug });
  const { error } = await database().from(TABLES.pages).delete().eq('id', page.id);
  if (error) {
    throw error;
  }
  await deleteAvatarFile(page.avatar_path);
  await endOwnerSession(request, response);
  return ok(response, { deleted: true });
}

// Checks the method and the owner's session, reads the body, asks for the
// password again (or counts a second step against its limit), then runs the
// action's step, which ends the request.
export default route('me/security', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const owner = await requireOwner(request, response);
  if (!owner) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  const page = owner.page;
  let rawAction = body.action;
  if (rawAction === null || rawAction === undefined) {
    rawAction = '';
  }
  const action = String(rawAction);

  if (await reauthRefused(request, response, page, action, body)) {
    return;
  }

  // An audit row for this page, as security.<name>.
  const record = (name, details = {}) =>
    audit(request, { action: `security.${name}`, actorType: 'owner', actorId: page.id, pageId: page.id, details });
  // The answer most actions give: the refreshed editor view, plus any extra
  // fields.
  const done = async (extra = {}) => ok(response, { ...extra, page: await loadOwnerView(page.id) });
  const context = { request, response, body, owner, page, record, done };

  switch (action) {
    case 'totp-start':
      return totpStart(context);
    case 'totp-finish':
      return totpFinish(context);
    case 'totp-remove':
      return totpRemove(context);
    case 'passkey-options':
      return passkeyOptions(context);
    case 'passkey-finish':
      return passkeyFinish(context);
    case 'passkey-remove':
      return passkeyRemove(context);
    case 'backup-regenerate':
      return backupRegenerate(context);
    case 'telegram-link':
      return telegramLink(context);
    case 'telegram-unlink':
      return telegramUnlink(context);
    case 'password-change':
      return passwordChange(context);
    case 'sessions-end-others':
      return sessionsEndOthers(context);
    case 'rename':
      return renamePage(context);
    case 'delete-page':
      return deletePage(context);
    default:
      return fail(response, 400, 'bad_request');
  }
});
