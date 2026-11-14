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
import { database, TABLES } from './supabase.js';
import { siteUrl } from './env.js';

const CHALLENGE_MINUTES = 5;

const REALMS = Object.freeze({
  owner: { table: TABLES.passkeys, column: 'page_id', rpName: 'OneLink GFTV' },
  staff: { table: TABLES.staffPasskeys, column: 'staff_user_id', rpName: 'OneLink GFTV staff' },
});

function relyingParty() {
  const url = new URL(siteUrl());
  return { id: url.hostname, origin: url.origin };
}

export async function listPasskeys(realm, subjectId) {
  const { table, column } = REALMS[realm];
  const { data, error } = await database()
    .from(table)
    .select('id, credential_id, transports, label, created_at, last_used_at')
    .eq(column, subjectId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  if (data === null || data === undefined) {
    return [];
  }
  return data;
}

async function storeChallenge(realm, purpose, subjectId, challenge) {
  await database().from(TABLES.webauthn).delete().eq('realm', realm).eq('purpose', purpose).eq('subject_id', subjectId);
  const { error } = await database().from(TABLES.webauthn).insert({
    realm,
    purpose,
    subject_id: subjectId,
    challenge,
    expires_at: new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString(),
  });
  if (error) {
    throw error;
  }
}

// Single use: the row is deleted whether or not it is still valid.
async function takeChallenge(realm, purpose, subjectId) {
  const { data, error } = await database()
    .from(TABLES.webauthn)
    .select('id, challenge, expires_at')
    .eq('realm', realm)
    .eq('purpose', purpose)
    .eq('subject_id', subjectId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  await database().from(TABLES.webauthn).delete().eq('id', data.id);
  if (new Date(data.expires_at).getTime() > Date.now()) {
    return data.challenge;
  }
  return null;
}

// Options for adding a passkey, with the subject's existing ones excluded so
// the same authenticator is not registered twice. The challenge is stored for
// finishRegistration.
export async function registrationOptions(realm, { subjectId, userName, displayName }) {
  const party = relyingParty();
  const existing = await listPasskeys(realm, subjectId);
  let userDisplayName = userName;
  if (displayName) {
    userDisplayName = displayName;
  }
  const options = await generateRegistrationOptions({
    rpName: REALMS[realm].rpName,
    rpID: party.id,
    userID: new TextEncoder().encode(subjectId),
    userName,
    userDisplayName,
    attestationType: 'none',
    excludeCredentials: existing.map((row) => {
      // A stored null is passed as undefined: no transports known.
      let transports = row.transports;
      if (transports === null) {
        transports = undefined;
      }
      return { id: row.credential_id, transports };
    }),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await storeChallenge(realm, 'register', subjectId, options.challenge);
  return options;
}

// { ok: true, passkey } or { ok: false, error }.
// Checks the browser's answer against the stored challenge, then saves the
// new passkey for the subject.
export async function finishRegistration(realm, { subjectId, response, label }) {
  const party = relyingParty();
  const expectedChallenge = await takeChallenge(realm, 'register', subjectId);
  if (!expectedChallenge) {
    return { ok: false, error: 'passkey_expired' };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: party.origin,
      expectedRPID: party.id,
      requireUserVerification: false,
    });
  } catch (cause) {
    let detail = cause;
    if (cause !== null && cause !== undefined && cause.message !== null && cause.message !== undefined) {
      detail = cause.message;
    }
    console.warn('[onelink] passkey registration rejected:', detail);
    return { ok: false, error: 'passkey_failed' };
  }
  if (!verification.verified) {
    return { ok: false, error: 'passkey_failed' };
  }

  const { credential } = verification.registrationInfo;
  const { table, column } = REALMS[realm];
  let counter = credential.counter;
  if (counter === null || counter === undefined) {
    counter = 0;
  }
  // The transports the credential reports, else the ones the browser sent.
  let transports = credential.transports;
  if (transports === null || transports === undefined) {
    transports = null;
    if (response !== null && response !== undefined && response.response !== null && response.response !== undefined) {
      const sentTransports = response.response.transports;
      if (sentTransports !== null && sentTransports !== undefined) {
        transports = sentTransports;
      }
    }
  }
  let storedLabel = null;
  if (label) {
    storedLabel = label;
  }
  const { data, error } = await database()
    .from(table)
    .insert({
      [column]: subjectId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter,
      transports,
      label: storedLabel,
    })
    .select('id, label, created_at, last_used_at')
    .single();
  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: 'passkey_exists' };
    }
    throw error;
  }
  return { ok: true, passkey: data };
}

// Options for signing in, or null when the subject has no passkeys.
export async function authenticationOptions(realm, subjectId) {
  const party = relyingParty();
  const existing = await listPasskeys(realm, subjectId);
  if (existing.length === 0) {
    return null;
  }
  const options = await generateAuthenticationOptions({
    rpID: party.id,
    allowCredentials: existing.map((row) => {
      // A stored null is passed as undefined: no transports known.
      let transports = row.transports;
      if (transports === null) {
        transports = undefined;
      }
      return { id: row.credential_id, transports };
    }),
    userVerification: 'preferred',
  });
  await storeChallenge(realm, 'authenticate', subjectId, options.challenge);
  return options;
}

// True when the browser's answer is signed by one of the subject's passkeys
// for the stored challenge. Saves the passkey's new counter and when it was
// used.
export async function finishAuthentication(realm, subjectId, response) {
  const party = relyingParty();
  const expectedChallenge = await takeChallenge(realm, 'authenticate', subjectId);
  if (!expectedChallenge) {
    return false;
  }

  let credentialId = '';
  if (response !== null && response !== undefined && typeof response.id === 'string') {
    credentialId = response.id;
  }
  const { table, column } = REALMS[realm];
  const { data: row, error } = await database()
    .from(table)
    .select('id, credential_id, public_key, counter, transports')
    .eq(column, subjectId)
    .eq('credential_id', credentialId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!row) {
    return false;
  }

  let verification;
  try {
    let counter = Number(row.counter);
    if (!counter) {
      counter = 0;
    }
    // A stored null is passed as undefined: no transports known.
    let transports = row.transports;
    if (transports === null) {
      transports = undefined;
    }
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: party.origin,
      expectedRPID: party.id,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter,
        transports,
      },
      requireUserVerification: false,
    });
  } catch (cause) {
    // Includes a counter that went backwards, the sign of a cloned key.
    let detail = cause;
    if (cause !== null && cause !== undefined && cause.message !== null && cause.message !== undefined) {
      detail = cause.message;
    }
    console.warn('[onelink] passkey assertion rejected:', detail);
    return false;
  }
  if (!verification.verified) {
    return false;
  }

  await database()
    .from(table)
    .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq('id', row.id);
  return true;
}

export async function removePasskey(realm, subjectId, passkeyId) {
  const { table, column } = REALMS[realm];
  const { data, error } = await database().from(table).delete().eq(column, subjectId).eq('id', passkeyId).select('id');
  if (error) {
    throw error;
  }
  let removed = [];
  if (data !== null && data !== undefined) {
    removed = data;
  }
  return removed.length > 0;
}

export async function countPasskeys(realm, subjectId) {
  const { table, column } = REALMS[realm];
  const { count, error } = await database().from(table).select('id', { count: 'exact', head: true }).eq(column, subjectId);
  if (error) {
    throw error;
  }
  if (count === null || count === undefined) {
    return 0;
  }
  return count;
}
