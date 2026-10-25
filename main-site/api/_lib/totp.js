// RFC 6238 TOTP, SHA-1, six digits, 30 second steps: what Google
// Authenticator and every other app expects. One step either side is
// accepted for clock drift. No dependency, the same as careers-gftv.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const STEP_SECONDS = 30;
const WINDOW = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(secret) {
  const cleaned = String(secret ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (cleaned === '') return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of cleaned) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length > 0 ? Buffer.from(out) : null;
}

export function generateTotpSecret() {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function hotp(key, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function verifyTotp(code, secret, at = Date.now()) {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (digits.length !== DIGITS) return false;
  const key = decodeBase32(secret);
  if (!key) return false;
  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  let matched = false;
  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    const candidate = Buffer.from(hotp(key, counter + offset));
    if (timingSafeEqual(candidate, Buffer.from(digits))) matched = true;
  }
  return matched;
}

// Exposed for the tests, which need a code for a known secret and time.
export function totpAt(secret, at = Date.now()) {
  return hotp(decodeBase32(secret), Math.floor(at / 1000 / STEP_SECONDS));
}

export function otpauthUri({ account, secret }) {
  const issuer = 'OneLink GFTV';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
