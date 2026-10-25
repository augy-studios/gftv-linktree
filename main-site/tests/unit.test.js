import './harness.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlug, sanitizeUrl, hostIsBlocked, normaliseDomain, cleanText, checkPassword, linkHost, lookupUrl, addressBlocked } from '../api/_lib/validate.js';
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

test('email links: one plain address, and only where asked for', () => {
  assert.equal(sanitizeUrl('mailto:Hello@Example.COM', { mail: true }).url, 'mailto:Hello@example.com');
  assert.equal(sanitizeUrl('hello@example.com', { mail: true }).url, 'mailto:hello@example.com');
  assert.equal(sanitizeUrl('MAILTO:a+b@mail.example.co', { mail: true }).host, 'mail.example.co');
  assert.equal(sanitizeUrl('https://example.com', { mail: true }).ok, true);
  assert.equal(sanitizeUrl('example.com/@name', { mail: true }).url, 'https://example.com/@name');
  for (const bad of [
    'mailto:a@b.co?subject=x', 'mailto:a@b.co?bcc=c@d.co', 'mailto:a@b.co,c@d.co', 'mailto:', 'mailto:a', 'mailto:a@localhost',
    'mailto:%61@b.co', 'mailto:"a"@b.co', 'mailto:a@b.co%0Abcc:c@d.co', 'mailto:<a@b.co>', 'mailto:a@-b.co', 'mailto:a@b.c',
  ]) {
    assert.equal(sanitizeUrl(bad, { mail: true }).error, 'mail_invalid', bad);
  }
  assert.equal(sanitizeUrl('mailto:a@b.co').error, 'url_scheme', 'a redirect is never an email address');
  assert.equal(sanitizeUrl('javascript:alert(1)', { mail: true }).error, 'url_scheme_link');
  assert.equal(sanitizeUrl('java\tscript:alert(1)', { mail: true }).ok, false);
  assert.equal(linkHost('mailto:a@Evil.Example'), 'evil.example');
  assert.equal(linkHost('https://www.example.com/x'), 'www.example.com');
  assert.equal(lookupUrl('mailto:a@b.co'), 'https://b.co/');
  assert.equal(lookupUrl('https://b.co/x'), 'https://b.co/x');
  assert.equal(addressBlocked('mailto:a@x.evil.example', { domains: ['evil.example'] }), true);
  assert.equal(addressBlocked('mailto:a@fine.example', { domains: ['evil.example'] }), false);
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

test('link icons: the browser and the server agree, and every one draws', async () => {
  const { LINK_ICONS: server } = await import('../api/_lib/validate.js');
  const icons = await import('../js/icons.js');
  assert.deepEqual([...server].sort(), [...icons.LINK_ICONS].sort());
  for (const name of icons.LINK_ICONS) {
    assert.ok(icons.icon(name).startsWith('<svg'), name);
    assert.match(name, /^[a-z0-9-]{1,24}$/, `${name} fits the database check`);
  }
});

test('platform links build and read back their addresses', async () => {
  const p = await import('../js/platforms.js');
  const icons = await import('../js/icons.js');
  for (const platform of p.PLATFORMS) {
    assert.ok(icons.LINK_ICONS.includes(platform.icon), platform.id);
    for (const format of platform.formats) {
      const url = p.buildUrl(format, format.example);
      assert.ok(p.usernameOk(format, format.example), `${platform.id}/${format.id} example passes its own pattern`);
      assert.match(url, /^(https:\/\/|mailto:)/);
      if (format.prefix !== 'https://' || format.suffix) {
        const back = p.matchPlatform(url);
        assert.equal(back?.platform.id, platform.id, url);
        assert.equal(back?.username, format.example, url);
      }
    }
  }
  const yt = p.platformById('youtube');
  assert.deepEqual(yt.formats.map((x) => x.id), ['handle', 'channel', 'custom', 'user']);
  assert.equal(p.cleanUsername(yt.formats[0], 'https://youtube.com/@augy/'), 'augy');
  assert.equal(p.cleanUsername(yt.formats[0], '@augy'), 'augy');
  assert.equal(p.usernameOk(yt.formats[1], 'UC123'), false, 'channel IDs are 24 characters starting UC');
  assert.equal(p.matchPlatform('https://example.com/augy'), null);
  assert.equal(p.matchPlatform('https://youtube.com.evil.example/@augy'), null);

  const { EMAIL_PATTERN } = await import('../api/_lib/validate.js');
  assert.equal(p.EMAIL, EMAIL_PATTERN, 'the browser and the server agree on email addresses');
  const email = p.platformById('email').formats[0];
  assert.equal(p.cleanUsername(email, ' mailto:you@example.com '), 'you@example.com');
  assert.equal(p.matchPlatform('mailto:you@example.com')?.platform.id, 'email');
  assert.equal(p.usernameOk(email, 'you@example.com?subject=hi'), false);
});

test('addresses hidden in text are found however they are written', async () => {
  const { addressesInText } = await import('../api/_lib/validate.js');
  const hidden = [
    'evil.com', 'evil [.] com', 'evil (.) com', "evil'.'com", 'evil"."com', 'evil*.*com', 'evil<dot>com', 'evil (dot) com',
    'evil [dot] com', 'evil dot com', 'EVIL DOT COM', 'evil d0t com', 'evil·com', 'evil • com', 'evil・com', 'evil。com',
    'ｅｖｉｌ．ｃｏｍ', 'evil . com', 'evil .com', 'evil. com', 'e v i l . c o m', 'еvil.com', 'evil{.}com', 'evil_._com',
    'evil-.-com', 'evil|.|com', 'evil~.~com', 'hxxps://evil[.]com/x', 'evil.c0m', '3vil d0t c0m', 'DM me: evil(.)com/shop',
  ];
  for (const text of hidden) {
    assert.ok(addressesInText(text).some((a) => a.host === 'evil.com'), text);
  }
  for (const text of ['just a normal bio', 'I am 1.5 metres tall, v2.0 out now', 'Price: 3.50', 'anecdote about dotted lines']) {
    assert.ok(!addressesInText(text).some((a) => /evil|\.com$/.test(a.host)), text);
  }
});
