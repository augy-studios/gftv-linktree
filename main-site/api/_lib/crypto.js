// Tokens, hashes and the TOTP secret envelope.
//
//   Passwords and backup codes  bcrypt. Low entropy, so a slow hash.
//   Session, challenge and      SHA-256. 32 random bytes each, so a fast hash
//   Telegram link tokens        is enough and lookups stay a single index hit.
//   TOTP secrets                AES-256-GCM with TOTP_ENCRYPTION_KEY, because
//                               the server has to read them back.
//   Addresses                   salted SHA-256, for rate limits and reports.

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

export function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hashPassword(plain) {
  return bcrypt.hash(String(plain), PASSWORD_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  const real = typeof hash === 'string' && hash.startsWith('$2');
  const matched = await bcrypt.compare(String(plain ?? ''), real ? hash : DUMMY_HASH);
  return real && matched;
}

export function hashCode(plain) {
  return bcrypt.hash(normaliseCode(plain), CODE_ROUNDS);
}

// Codes are matched in a normalised form, so spaces, capitals and a missing
// hyphen still match what was issued.
export function normaliseCode(input) {
  return String(input ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// No 0, o, 1, l or i, so a code read off paper is not mistyped.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let n = 0; n < count; n += 1) {
    const bytes = randomBytes(10);
    let code = '';
    for (let i = 0; i < 10; i += 1) {
      if (i === 5) code += '-';
      code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
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
  if (normalised.length < 6) return null;
  let matched = null;
  for (const row of rows) {
    const isMatch = await bcrypt.compare(normalised, row.code_hash);
    if (isMatch && matched === null) matched = row;
  }
  return matched;
}

// TOTP_ENCRYPTION_KEY is 32 random bytes, written either as base64 (44
// characters, from `openssl rand -base64 32`) or as hex (64 characters, from
// `openssl rand -hex 32`). Anything that does not come to exactly 32 bytes is
// refused rather than stretched, and the error says what it got.
export function parseEncryptionKey(raw) {
  const value = String(raw ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
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

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
}

export function decryptSecret(envelope) {
  if (typeof envelope !== 'string' || !envelope.startsWith('v1:')) return null;
  try {
    const [, iv, tag, data] = envelope.split(':');
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch (cause) {
    console.error('[onelink] could not decrypt a TOTP secret:', cause?.message ?? cause);
    return null;
  }
}

export function hashIp(ip) {
  return sha256(`${optionalEnv('IP_HASH_SALT', 'onelink')}:${ip}`);
}
