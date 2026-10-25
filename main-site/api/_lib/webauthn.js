// Passkeys as the second factor, for owners and for staff. Two credential
// tables, because a staff passkey must never satisfy an owner check.
//
// Passkeys are bound to the hostname in SITE_URL. On a Vercel preview URL the
// browser refuses them, which is expected; TOTP still works there.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db, T } from './supabase.js';
import { siteUrl } from './env.js';

const CHALLENGE_MINUTES = 5;

const REALMS = Object.freeze({
  owner: { table: T.passkeys, column: 'page_id', rpName: 'OneLink GFTV' },
  staff: { table: T.staffPasskeys, column: 'staff_user_id', rpName: 'OneLink GFTV staff' },
});

function relyingParty() {
  const url = new URL(siteUrl());
  return { id: url.hostname, origin: url.origin };
}

export async function listPasskeys(realm, subjectId) {
  const { table, column } = REALMS[realm];
  const { data, error } = await db()
    .from(table)
    .select('id, credential_id, transports, label, created_at, last_used_at')
    .eq(column, subjectId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function storeChallenge(realm, purpose, subjectId, challenge) {
  await db().from(T.webauthn).delete().eq('realm', realm).eq('purpose', purpose).eq('subject_id', subjectId);
  const { error } = await db().from(T.webauthn).insert({
    realm,
    purpose,
    subject_id: subjectId,
    challenge,
    expires_at: new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString(),
  });
  if (error) throw error;
}

// Single use: the row is deleted whether or not it is still valid.
async function takeChallenge(realm, purpose, subjectId) {
  const { data, error } = await db()
    .from(T.webauthn)
    .select('id, challenge, expires_at')
    .eq('realm', realm)
    .eq('purpose', purpose)
    .eq('subject_id', subjectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  await db().from(T.webauthn).delete().eq('id', data.id);
  return new Date(data.expires_at).getTime() > Date.now() ? data.challenge : null;
}

export async function registrationOptions(realm, { subjectId, userName, displayName }) {
  const rp = relyingParty();
  const existing = await listPasskeys(realm, subjectId);
  const options = await generateRegistrationOptions({
    rpName: REALMS[realm].rpName,
    rpID: rp.id,
    userID: new TextEncoder().encode(subjectId),
    userName,
    userDisplayName: displayName || userName,
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: row.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await storeChallenge(realm, 'register', subjectId, options.challenge);
  return options;
}

// { ok: true, passkey } or { ok: false, error }.
export async function finishRegistration(realm, { subjectId, response, label }) {
  const rp = relyingParty();
  const expectedChallenge = await takeChallenge(realm, 'register', subjectId);
  if (!expectedChallenge) return { ok: false, error: 'passkey_expired' };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
  } catch (cause) {
    console.warn('[onelink] passkey registration rejected:', cause?.message ?? cause);
    return { ok: false, error: 'passkey_failed' };
  }
  if (!verification.verified) return { ok: false, error: 'passkey_failed' };

  const { credential } = verification.registrationInfo;
  const { table, column } = REALMS[realm];
  const { data, error } = await db()
    .from(table)
    .insert({
      [column]: subjectId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter ?? 0,
      transports: credential.transports ?? response?.response?.transports ?? null,
      label: label || null,
    })
    .select('id, label, created_at, last_used_at')
    .single();
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'passkey_exists' };
    throw error;
  }
  return { ok: true, passkey: data };
}

// Options for signing in, or null when the subject has no passkeys.
export async function authenticationOptions(realm, subjectId) {
  const rp = relyingParty();
  const existing = await listPasskeys(realm, subjectId);
  if (existing.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: existing.map((row) => ({ id: row.credential_id, transports: row.transports ?? undefined })),
    userVerification: 'preferred',
  });
  await storeChallenge(realm, 'authenticate', subjectId, options.challenge);
  return options;
}

export async function finishAuthentication(realm, subjectId, response) {
  const rp = relyingParty();
  const expectedChallenge = await takeChallenge(realm, 'authenticate', subjectId);
  if (!expectedChallenge) return false;

  const credentialId = typeof response?.id === 'string' ? response.id : '';
  const { table, column } = REALMS[realm];
  const { data: row, error } = await db()
    .from(table)
    .select('id, credential_id, public_key, counter, transports')
    .eq(column, subjectId)
    .eq('credential_id', credentialId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return false;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: Number(row.counter) || 0,
        transports: row.transports ?? undefined,
      },
      requireUserVerification: false,
    });
  } catch (cause) {
    // Includes a counter that went backwards, the sign of a cloned key.
    console.warn('[onelink] passkey assertion rejected:', cause?.message ?? cause);
    return false;
  }
  if (!verification.verified) return false;

  await db()
    .from(table)
    .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq('id', row.id);
  return true;
}

export async function removePasskey(realm, subjectId, passkeyId) {
  const { table, column } = REALMS[realm];
  const { data, error } = await db().from(table).delete().eq(column, subjectId).eq('id', passkeyId).select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function countPasskeys(realm, subjectId) {
  const { table, column } = REALMS[realm];
  const { count, error } = await db().from(table).select('id', { count: 'exact', head: true }).eq(column, subjectId);
  if (error) throw error;
  return count ?? 0;
}
