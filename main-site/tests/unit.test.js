import './harness.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlug, sanitizeUrl, hostIsBlocked, normaliseDomain, cleanText, checkPassword } from '../api/_lib/validate.js';
import { generateBackupCodes, hashCode, findMatchingCode, encryptSecret, decryptSecret, verifyPassword, hashPassword, parseEncryptionKey } from '../api/_lib/crypto.js';
import { generateTotpSecret, verifyTotp, totpAt } from '../api/_lib/totp.js';
import { inlineJson } from '../api/render.js';

test('slug rules', () => {
  for (const ok of ['ab', 'a-b', 'abc123', 'x'.repeat(32), 'my-page-2']) assert.equal(checkSlug(ok).ok, true, ok);
  for (const bad of ['a', '-ab', 'ab-', 'a--b', 'A B', 'x'.repeat(33), 'ab_c', 'ab.c', '']) assert.equal(checkSlug(bad).ok, false, bad);
  assert.equal(checkSlug('AbC').slug, 'abc');
  for (const reserved of ['admin', 'api', 'login', 'register', 'webhook', 'status', 'edit', '404', 'shell']) {
    assert.equal(checkSlug(reserved).error, 'slug_reserved', reserved);
  }
});

test('URLs: only http and https, nothing smuggled', () => {
  assert.equal(sanitizeUrl('https://example.com/a?b=c').url, 'https://example.com/a?b=c');
  assert.equal(sanitizeUrl('example.com').url, 'https://example.com/');
  assert.equal(sanitizeUrl('http://example.com').ok, true);
  for (const bad of [
    'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd',
    'vbscript:x', 'mailto:a@b.c', 'java\tscript:alert(1)', ' javascript:alert(1)', 'intent://x',
  ]) {
    assert.equal(sanitizeUrl(bad).ok, false, bad);
  }
  assert.equal(sanitizeUrl('https://gftv.asia@evil.example').error, 'url_credentials');
  assert.equal(sanitizeUrl('https://localhost').ok, false);
  assert.equal(sanitizeUrl('https://nodot').ok, false);
});

test('blocked domains match subdomains only', () => {
  assert.equal(hostIsBlocked('evil.example', ['evil.example']), true);
  assert.equal(hostIsBlocked('a.b.evil.example', ['evil.example']), true);
  assert.equal(hostIsBlocked('notevil.example', ['evil.example']), false);
  assert.equal(normaliseDomain('https://www.Evil.Example/path'), 'evil.example');
  assert.equal(normaliseDomain('nonsense'), null);
});

test('text is cleaned of control and direction characters', () => {
  assert.equal(cleanText('  hi‮there\u0000  ', 60), 'hi there');
  assert.equal(cleanText('a\n\n\n\nb', 60, { multiline: true }), 'a\n\nb');
  assert.equal([...cleanText('x'.repeat(100), 60)].length, 60);
});

test('password rule', () => {
  assert.equal(checkPassword('short').error, 'password_too_short');
  assert.equal(checkPassword('long enough pass').ok, true);
  assert.equal(checkPassword('é'.repeat(40)).error, 'password_too_long');
});

test('passwords verify, and an unknown account still costs a compare', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('anything', null), false);
});

test('backup codes: ten, unambiguous, matched loosely', async () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, 10);
  for (const c of codes) assert.match(c, /^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/);
  const rows = await Promise.all(codes.slice(0, 3).map(async (c, i) => ({ id: i, code_hash: await hashCode(c) })));
  assert.equal((await findMatchingCode(codes[1].toUpperCase().replace('-', ' '), rows)).id, 1);
  assert.equal(await findMatchingCode('zzzzz-zzzzz', rows), null);
});

test('TOTP secrets round-trip through encryption', () => {
  const secret = generateTotpSecret();
  const sealed = encryptSecret(secret);
  assert.notEqual(sealed, secret);
  assert.equal(decryptSecret(sealed), secret);
  assert.equal(decryptSecret(sealed.slice(0, -2) + 'AA'), null);
});

test('encryption key: 44-char base64 or 64-char hex, nothing shorter', () => {
  const bytes = Buffer.alloc(32, 7);
  assert.equal(parseEncryptionKey(bytes.toString('base64')).length, 32);
  assert.equal(parseEncryptionKey(bytes.toString('hex')).length, 32);
  assert.equal(parseEncryptionKey(`"${bytes.toString('base64')}"`).length, 32, 'pasted with quotes');
  assert.throws(() => parseEncryptionKey(Buffer.alloc(24).toString('base64')), /32 characters \(24 bytes\)/);
  assert.throws(() => parseEncryptionKey(Buffer.alloc(16).toString('hex')), /32 characters/);
});

test('TOTP accepts one step either side and nothing further', () => {
  const secret = generateTotpSecret();
  const t0 = Date.now();
  assert.equal(verifyTotp(totpAt(secret, t0), secret, t0), true);
  assert.equal(verifyTotp(totpAt(secret, t0 - 30_000), secret, t0), true);
  assert.equal(verifyTotp(totpAt(secret, t0 - 120_000), secret, t0), false);
  assert.equal(verifyTotp('12345', secret, t0), false);
});

test('RFC 6238 test vector', () => {
  // Secret "12345678901234567890" in base32, at 59 seconds: 287082 (6 digits).
  assert.equal(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
});

test('inlined page data cannot close its script element', () => {
  const ls = String.fromCharCode(0x2028);
  const out = inlineJson({ bio: `</script><script>alert(1)</script><!-- & ${ls}` });
  assert.equal(out.includes('</script'), false);
  assert.equal(out.includes('<!--'), false);
  assert.equal(out.includes(ls), false);
  assert.equal(JSON.parse(out).bio, `</script><script>alert(1)</script><!-- & ${ls}`);
});
