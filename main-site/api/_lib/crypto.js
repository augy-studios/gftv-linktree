// Tokens, hashes and the TOTP secret envelope.
//
//   Passwords and backup codes  bcrypt. Low entropy, so a slow hash.
//   Session, challenge and      SHA-256. 32 random bytes each, so a fast hash
//   Telegram link tokens        is enough and lookups stay a single index hit.
//   TOTP secrets                AES-256-GCM with TOTP_ENCRYPTION_KEY, because
//                               the server has to read them back.
//   Addresses and device        salted SHA-256, for rate limits, reports and
//   fingerprints                bans.

import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { requiredEnv, optionalEnv } from './env.js';

const PASSWORD_ROUNDS = 12;
// Ten codes are compared one by one at sign in, so a lower cost keeps that
// under a second. Each code still carries about 50 bits of entropy.
const CODE_ROUNDS = 10;

// A real bcrypt hash of a discarded value. Comparing against it on the
// unknown-account branch makes that branch cost what a wrong password costs.
const DUMMY_HASH = '$2a$12$9S.9kxE/etBNq4UBisxl7ORP75tDZWrG9w7T9znqxqiW15PvNmdI6';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Constant-time comparison of two strings. Values of different lengths are
// unequal at once; timingSafeEqual needs the lengths to match.
export function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left), 'utf8');
  const rightBytes = Buffer.from(String(right), 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function hashPassword(plain) {
  return bcrypt.hash(String(plain), PASSWORD_ROUNDS);
}

// A password against its bcrypt hash. With no real hash, the password is
// still compared, against DUMMY_HASH, so the answer takes as long either way.
export async function verifyPassword(plain, hash) {
  let real = false;
  if (typeof hash === 'string' && hash.startsWith('$2')) {
    real = true;
  }
  let typed = '';
  if (plain !== null && plain !== undefined) {
    typed = plain;
  }
  let compareWith = DUMMY_HASH;
  if (real) {
    compareWith = hash;
  }
  const matched = await bcrypt.compare(String(typed), compareWith);
  if (!real) {
    return false;
  }
  return matched;
}

export function hashCode(plain) {
  return bcrypt.hash(normaliseCode(plain), CODE_ROUNDS);
}

// Codes are matched in a normalised form, so spaces, capitals and a missing
// hyphen still match what was issued.
export function normaliseCode(input) {
  let typed = '';
  if (input !== null && input !== undefined) {
    typed = input;
  }
  return String(typed).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// No 0, o, 1, l or i, so a code read off paper is not mistyped.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let codeNumber = 0; codeNumber < count; codeNumber += 1) {
    const bytes = randomBytes(10);
    let code = '';
    // Ten characters, with a hyphen after the fifth: abcde-fghij.
    for (let position = 0; position < 10; position += 1) {
      if (position === 5) {
        code += '-';
      }
      code += CODE_ALPHABET[bytes[position] % CODE_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

// Six digits, uniform, for Telegram codes.
export function randomDigits() {
  let value;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= 4294000000);
  return String(value % 1000000).padStart(6, '0');
}

// Compare a typed code against every stored hash, without stopping at the
// first match, so timing does not reveal which code it was.
export async function findMatchingCode(typed, rows) {
  const normalised = normaliseCode(typed);
  if (normalised.length < 6) {
    return null;
  }
  let matched = null;
  for (const row of rows) {
    const isMatch = await bcrypt.compare(normalised, row.code_hash);
    if (isMatch && matched === null) {
      matched = row;
    }
  }
  return matched;
}

// TOTP_ENCRYPTION_KEY is 32 random bytes, written either as base64 (44
// characters, from `openssl rand -base64 32`) or as hex (64 characters, from
// `openssl rand -hex 32`). Anything that does not come to exactly 32 bytes is
// refused rather than stretched, and the error says what it got.
export function parseEncryptionKey(raw) {
  let given = '';
  if (raw !== null && raw !== undefined) {
    given = raw;
  }
  // Without the quotes a value pasted as "..." or '...' would carry.
  const value = String(given).trim().replace(/^(['"])(.*)\1$/, '$2');
  let key;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    key = Buffer.from(value, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(
      `TOTP_ENCRYPTION_KEY must be 32 bytes: 44 characters of base64 or 64 of hex. ` +
        `The value set is ${value.length} characters (${key.length} bytes). Make one with: openssl rand -base64 32`
    );
  }
  return key;
}

function secretKey() {
  return parseEncryptionKey(requiredEnv('TOTP_ENCRYPTION_KEY'));
}

// The envelope is "v1:<initialisation vector>:<auth tag>:<ciphertext>", each
// part in base64url.
export function encryptSecret(plain) {
  const initialisationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), initialisationVector);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${initialisationVector.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
}

// The secret inside an envelope from encryptSecret, or null when it is not
// one or does not decrypt (a changed key, or a tampered envelope).
export function decryptSecret(envelope) {
  if (typeof envelope !== 'string' || !envelope.startsWith('v1:')) {
    return null;
  }
  try {
    const [, initialisationVector, tag, data] = envelope.split(':');
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(initialisationVector, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch (cause) {
    let detail = cause;
    if (cause !== null && cause !== undefined && cause.message !== null && cause.message !== undefined) {
      detail = cause.message;
    }
    console.error('[onelink] could not decrypt a TOTP secret:', detail);
    return null;
  }
}

export function hashIp(ip) {
  return sha256(`${optionalEnv('IP_HASH_SALT', 'onelink')}:${ip}`);
}

// A device fingerprint (http.js clientVisitor), salted the same way.
export function hashVisitor(visitor) {
  return sha256(`${optionalEnv('IP_HASH_SALT', 'onelink')}:${visitor}`);
}
