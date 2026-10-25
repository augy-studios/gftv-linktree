// Owner sessions, and the challenge rows both realms use between the password
// and the second factor.
//
// A session is an HttpOnly cookie holding 32 random bytes; the table holds
// only their SHA-256, so a leaked table is not a set of working cookies.

import { db, T } from './supabase.js';
import { randomToken, sha256 } from './crypto.js';
import { readCookie, setCookie, clearCookie, fail } from './http.js';

export const OWNER_COOKIE = '__Host-olg_session';
const OWNER_SESSION_DAYS = 7;

// Columns an owner route may need. password_hash is fetched only by the
// routes that verify a password, by name, never through this list.
const OWNER_PAGE_COLUMNS =
  'id, slug, display_name, bio, status, totp_secret, telegram_chat_id, telegram_username, avatar_path, created_at, activated_at';

export async function createOwnerSession(res, pageId) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + OWNER_SESSION_DAYS * 86400_000);
  const { error } = await db().from(T.sessions).insert({
    page_id: pageId,
    token_hash: sha256(token),
    expires_at: expires.toISOString(),
  });
  if (error) throw error;
  setCookie(res, OWNER_COOKIE, token, OWNER_SESSION_DAYS * 86400);
}

// { session, page } for a live session on an active page, or null.
export async function currentOwner(req) {
  const token = readCookie(req, OWNER_COOKIE);
  if (!token) return null;

  const { data, error } = await db()
    .from(T.sessions)
    .select(`id, expires_at, last_seen_at, page:${T.pages} ( ${OWNER_PAGE_COLUMNS} )`)
    .eq('token_hash', sha256(token))
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.page) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await db().from(T.sessions).delete().eq('id', data.id);
    return null;
  }
  // Touch at most every ten minutes, to keep writes off the hot path.
  if (Date.now() - new Date(data.last_seen_at).getTime() > 600_000) {
    await db().from(T.sessions).update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
  }
  return { sessionId: data.id, page: data.page };
}

// The signed-in owner's page, or null after answering. A banned page cannot
// be edited; the owner is told so rather than shown a sign-in form.
export async function requireOwner(req, res) {
  const owner = await currentOwner(req);
  if (!owner) {
    fail(res, 401, 'signed_out');
    return null;
  }
  if (owner.page.status === 'banned') {
    fail(res, 403, 'page_banned');
    return null;
  }
  if (owner.page.status !== 'active') {
    fail(res, 401, 'signed_out');
    return null;
  }
  return owner;
}

export async function endOwnerSession(req, res) {
  const token = readCookie(req, OWNER_COOKIE);
  if (token) await db().from(T.sessions).delete().eq('token_hash', sha256(token));
  clearCookie(res, OWNER_COOKIE);
}

export async function endAllOwnerSessions(pageId, exceptSessionId = null) {
  let q = db().from(T.sessions).delete().eq('page_id', pageId);
  if (exceptSessionId) q = q.neq('id', exceptSessionId);
  const { error } = await q;
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

const CHALLENGE_MINUTES = { login: 10, enrol: 30, recover: 15 };
export const CHALLENGE_ATTEMPTS = 5;

export async function createChallenge({ realm, purpose, subjectId, fields = {} }) {
  // One open challenge per subject and purpose: starting again replaces it.
  await db().from(T.challenges).delete().eq('realm', realm).eq('purpose', purpose).eq('subject_id', subjectId);

  const token = randomToken(32);
  const { error } = await db().from(T.challenges).insert({
    ...fields,
    realm,
    purpose,
    subject_id: subjectId,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + CHALLENGE_MINUTES[purpose] * 60_000).toISOString(),
  });
  if (error) throw error;
  return token;
}

// The live challenge row for a token, or null. Expired rows and rows out of
// attempts are deleted on sight.
export async function findChallenge(token, realm, purpose) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const { data, error } = await db()
    .from(T.challenges)
    .select('id, subject_id, attempts, pending_totp_secret, telegram_code_hash, telegram_code_expires_at, expires_at')
    .eq('token_hash', sha256(token))
    .eq('realm', realm)
    .eq('purpose', purpose)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now() || data.attempts >= CHALLENGE_ATTEMPTS) {
    await db().from(T.challenges).delete().eq('id', data.id);
    return null;
  }
  return data;
}

export async function failChallengeAttempt(challenge) {
  await db().from(T.challenges).update({ attempts: challenge.attempts + 1 }).eq('id', challenge.id);
}

export async function updateChallenge(challenge, fields) {
  const { error } = await db().from(T.challenges).update(fields).eq('id', challenge.id);
  if (error) throw error;
}

export async function deleteChallenge(challenge) {
  await db().from(T.challenges).delete().eq('id', challenge.id);
}
