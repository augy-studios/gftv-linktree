// End to end through the real route handlers, against tests/fake-db.js.
import { browser, leaks, ORIGIN } from './harness.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { useTestClient } from '../api/_lib/supabase.js';
import { createFakeDb } from './fake-db.js';
import { totpAt, generateTotpSecret } from '../api/_lib/totp.js';
import { forgetBlockedDomains } from '../api/_lib/guards.js';

import slug from '../api/slug.js';
import register from '../api/auth/register.js';
import enrol from '../api/auth/enrol.js';
import login from '../api/auth/login.js';
import verify from '../api/auth/verify.js';
import recover from '../api/auth/recover.js';
import session from '../api/auth/session.js';
import mePage from '../api/me/page.js';
import meLinks from '../api/me/links.js';
import security from '../api/me/security.js';
import publicPage from '../api/public/page.js';
import click from '../api/public/click.js';
import report from '../api/public/report.js';
import render from '../api/render.js';
import adminAuth from '../api/admin/auth.js';
import adminOverview from '../api/admin/overview.js';
import adminPages from '../api/admin/pages.js';
import adminLinks from '../api/admin/links.js';
import adminReports from '../api/admin/reports.js';
import adminBlocklist from '../api/admin/blocklist.js';
import adminAudit from '../api/admin/audit.js';
import webhook from '../api/telegram/webhook.js';
import cleanup from '../api/cron/cleanup.js';

let fake;
beforeEach(() => {
  fake = createFakeDb();
  useTestClient(fake);
  forgetBlockedDomains();
});

// A page set up the way a person would: register, authenticator, codes.
async function makePage(b, name = 'augy', password = 'correct horse battery') {
  const reg = await b.call(register, { method: 'POST', body: { slug: name, password } });
  assert.equal(reg.status, 200, reg.body);
  const start = await b.call(enrol, { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-start' } });
  assert.equal(start.status, 200, start.body);
  assert.match(start.json.uri, /^otpauth:\/\/totp\//);
  const done = await b.call(enrol, { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-finish', code: totpAt(start.json.secret) } });
  assert.equal(done.status, 200, done.body);
  return { secret: start.json.secret, codes: done.json.backupCodes, password };
}

test('sign up: pending until a second factor, then live with ten codes', async () => {
  const b = browser();
  const reg = await b.call(register, { method: 'POST', body: { slug: 'augy', password: 'correct horse battery' } });
  assert.equal(reg.status, 200);
  assert.equal(b.jar.size, 0, 'no session before the second factor');
  assert.equal((await b.call(publicPage, { query: { slug: 'augy' } })).status, 404, 'pending page is not public');

  const taken = await b.call(slug, { query: { slug: 'augy' } });
  assert.equal(taken.json.available, false);

  const start = await b.call(enrol, { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-start' } });
  const wrong = await b.call(enrol, { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-finish', code: '000000' } });
  assert.equal(wrong.status, 401);
  const done = await b.call(enrol, { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-finish', code: totpAt(start.json.secret) } });
  assert.equal(done.status, 200);
  assert.equal(done.json.backupCodes.length, 10);
  assert.ok(b.jar.has('__Host-olg_session'));

  const page = fake.table('gftvonelink_pages')[0];
  assert.equal(page.status, 'active');
  assert.match(page.totp_secret, /^v1:/, 'TOTP secret is stored encrypted');
  assert.notEqual(page.totp_secret, start.json.secret);
  assert.ok(page.password_hash.startsWith('$2'), 'bcrypt');
  for (const s of fake.table('gftvonelink_sessions')) assert.match(s.token_hash, /^[0-9a-f]{64}$/, 'session stored hashed');
});

test('slug rules and reserved names at registration', async () => {
  // Sign-up is limited to five an hour per address, so each try gets its own.
  const b = browser();
  let n = 0;
  const attempt = (body) => b.call(register, { method: 'POST', body, ip: `198.51.100.${(n += 1)}` });
  for (const bad of ['a', 'admin', 'api', 'ab--c', '-ab']) {
    const r = await attempt({ slug: bad, password: 'correct horse battery' });
    assert.equal(r.status, 400, bad);
  }
  fake.table('gftvonelink_blocked_slugs').push({ slug: 'gftvhq', reason: 'x', created_at: new Date().toISOString() });
  assert.equal((await attempt({ slug: 'gftvhq', password: 'correct horse battery' })).json.error, 'slug_reserved');
  assert.equal((await attempt({ slug: 'okname', password: 'short' })).json.error, 'password_too_short');
});

test('an abandoned sign-up releases its slug after an hour', async () => {
  const b = browser();
  await b.call(register, { method: 'POST', body: { slug: 'squat', password: 'correct horse battery' } });
  assert.equal((await b.call(register, { method: 'POST', body: { slug: 'squat', password: 'correct horse battery' } })).status, 409);
  fake.table('gftvonelink_pages')[0].created_at = new Date(Date.now() - 2 * 3600_000).toISOString();
  assert.equal((await b.call(slug, { query: { slug: 'squat' } })).json.available, true);
  assert.equal((await b.call(register, { method: 'POST', body: { slug: 'squat', password: 'correct horse battery' } })).status, 200);
});

test('cross-site and non-JSON writes are refused', async () => {
  const b = browser();
  assert.equal((await b.call(register, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).json.error, 'bad_origin');
  assert.equal((await b.call(register, { method: 'POST', body: {}, headers: { origin: undefined } })).json.error, 'bad_origin');
  assert.equal((await b.call(register, { method: 'POST', body: {}, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json.error, 'bad_content_type');
});

test('links: only http(s), owner order, public view is minimal', async () => {
  const b = browser();
  await makePage(b);
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://gftv.asia@evil.example']) {
    const r = await b.call(meLinks, { method: 'POST', body: { title: 'x', url } });
    assert.equal(r.status, 400, url);
  }
  await b.call(meLinks, { method: 'POST', body: { title: 'First', url: 'example.com', icon: 'globe' } });
  await b.call(meLinks, { method: 'POST', body: { title: 'Second', url: 'https://example.org/b', icon: '<script>' } });
  let list = (await b.call(meLinks, { method: 'POST', body: { title: 'Hidden', url: 'https://example.net' } })).json.links;
  assert.equal(list[0].url, 'https://example.com/');
  assert.equal(list[1].icon, 'link', 'unknown icon names fall back');

  list = (await b.call(meLinks, { method: 'PATCH', body: { id: list[2].id, isActive: false } })).json.links;
  list = (await b.call(meLinks, { method: 'POST', body: { action: 'reorder', ids: [list[1].id, list[0].id, list[2].id] } })).json.links;
  assert.deepEqual(list.map((l) => l.title), ['Second', 'First', 'Hidden']);

  const pub = await b.call(publicPage, { query: { slug: 'augy' } });
  assert.deepEqual(pub.json.page.links.map((l) => l.title), ['Second', 'First']);
  assert.deepEqual(Object.keys(pub.json.page).sort(), ['avatarUrl', 'bio', 'displayName', 'links', 'slug']);
  assert.deepEqual(Object.keys(pub.json.page.links[0]).sort(), ['icon', 'id', 'title', 'url']);
  assert.deepEqual(leaks(pub.json), []);

  await b.call(click, { method: 'POST', body: { id: pub.json.page.links[0].id } });
  await b.call(click, { method: 'POST', body: { id: list[2].id } });
  const owner = await b.call(mePage);
  assert.equal(owner.json.page.links.find((l) => l.title === 'Second').clicks, 1);
  assert.equal(owner.json.page.links.find((l) => l.title === 'Hidden').clicks, 0, 'hidden links do not count clicks');
  assert.deepEqual(leaks(owner.json), [], 'owner view carries no secrets either');
});

test('another owner cannot touch my links', async () => {
  const me = browser();
  await makePage(me, 'mine');
  const { links } = (await me.call(meLinks, { method: 'POST', body: { title: 'Mine', url: 'https://example.com' } })).json;
  const them = browser();
  await makePage(them, 'theirs');
  assert.equal((await them.call(meLinks, { method: 'DELETE', body: { id: links[0].id } })).status, 404);
  assert.equal((await them.call(meLinks, { method: 'PATCH', body: { id: links[0].id, title: 'pwned' } })).status, 404);
  assert.equal(fake.table('gftvonelink_links').find((l) => l.id === links[0].id).title, 'Mine');
});

test('sign in: password then TOTP; backup codes work once', async () => {
  const setup = browser();
  const { secret, codes, password } = await makePage(setup);

  const b = browser();
  assert.equal((await b.call(login, { method: 'POST', body: { slug: 'augy', password: 'nope nope nope' } })).json.error, 'invalid_credentials');
  assert.equal((await b.call(login, { method: 'POST', body: { slug: 'nobody', password } })).json.error, 'invalid_credentials');

  let step = await b.call(login, { method: 'POST', body: { slug: 'AUGY', password } });
  assert.deepEqual(step.json.methods, { totp: true, passkey: false, backup: true, telegram: false });
  assert.equal(b.jar.size, 0, 'the password alone issues no session');
  assert.equal((await b.call(mePage)).status, 401);
  const ok = await b.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'totp', code: totpAt(secret) } });
  assert.equal(ok.status, 200);
  assert.equal((await b.call(mePage)).status, 200);

  const c = browser();
  step = await c.call(login, { method: 'POST', body: { slug: 'augy', password } });
  assert.equal((await c.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'backup', code: codes[0].toUpperCase() } })).status, 200);
  const d = browser();
  step = await d.call(login, { method: 'POST', body: { slug: 'augy', password } });
  assert.equal((await d.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'backup', code: codes[0] } })).status, 401, 'spent');
});

test('five wrong codes spend the challenge', async () => {
  const setup = browser();
  const { secret, password } = await makePage(setup);
  const b = browser();
  const step = await b.call(login, { method: 'POST', body: { slug: 'augy', password } });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await b.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'totp', code: '000000' } })).status, 401);
  }
  const late = await b.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'totp', code: totpAt(secret) } });
  assert.equal(late.json.error, 'challenge_expired');
});

test('security: re-auth required, last factor kept, password change signs others out', async () => {
  const a = browser();
  const { secret, password } = await makePage(a);
  assert.equal((await a.call(security, { method: 'POST', body: { action: 'totp-remove', password: 'wrong wrong wrong' } })).json.error, 'password_wrong');
  assert.equal((await a.call(security, { method: 'POST', body: { action: 'totp-remove', password } })).json.error, 'last_factor');

  const b = browser();
  const step = await b.call(login, { method: 'POST', body: { slug: 'augy', password } });
  await b.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'totp', code: totpAt(secret) } });
  assert.equal((await b.call(mePage)).status, 200);

  const changed = await a.call(security, { method: 'POST', body: { action: 'password-change', password, newPassword: 'a whole new phrase' } });
  assert.equal(changed.status, 200);
  assert.equal((await a.call(mePage)).status, 200, 'this device stays in');
  assert.equal((await b.call(mePage)).status, 401, 'the other device is out');

  const codes = await a.call(security, { method: 'POST', body: { action: 'backup-regenerate', password: 'a whole new phrase' } });
  assert.equal(codes.json.backupCodes.length, 10);
  assert.equal(codes.json.page.security.backupCodesLeft, 10);
  assert.deepEqual(leaks(codes.json.page), []);
});

test('recovery needs Telegram and the second factor, never one alone', async () => {
  const a = browser();
  const { secret, codes } = await makePage(a);
  const r = browser();
  assert.deepEqual((await r.call(recover, { method: 'POST', body: { action: 'start', slug: 'augy' } })).json, { ok: true, telegram: false });

  // Link Telegram through the bot, the way the deep link does.
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'onelink_test_bot';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret';
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ method: String(url).split('/').pop(), ...JSON.parse(init.body) });
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const link = await a.call(security, { method: 'POST', body: { action: 'telegram-link', password: 'correct horse battery' } });
    const token = new URL(link.json.url).searchParams.get('start');
    assert.equal((await r.call(webhook, { method: 'POST', body: { message: { chat: { id: 42, type: 'private' }, from: { username: 'augy' }, text: `/start ${token}` } }, headers: { 'x-telegram-bot-api-secret-token': 'wrong' } })).status, 401);
    await r.call(webhook, { method: 'POST', body: { message: { chat: { id: 42, type: 'private' }, from: { username: 'augy' }, text: `/start ${token}` } }, headers: { 'x-telegram-bot-api-secret-token': 'hook-secret' } });
    const view = (await a.call(mePage)).json.page;
    assert.deepEqual(view.security.telegram, { linked: true, username: 'augy' });
    assert.equal(JSON.stringify(view).includes('42'), false, 'the chat id never reaches the browser');

    const start = await r.call(recover, { method: 'POST', body: { action: 'start', slug: 'augy' } });
    assert.equal(start.json.telegram, true);
    await r.call(recover, { method: 'POST', body: { action: 'send', challenge: start.json.challenge } });
    const dm = sent.at(-1);
    assert.equal(dm.method, 'sendRichMessage', 'the code goes out as a rich message');
    assert.equal(dm.parse_mode, undefined);
    const code = dm.rich_message.markdown.match(/`(\d{6})`/)[1];

    const noFactor = await r.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, telegramCode: code, factor: 'totp', code: '000000', newPassword: 'brand new phrase here' } });
    assert.equal(noFactor.status, 401, 'Telegram alone is not enough');
    const noTelegram = await r.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, telegramCode: '000000', factor: 'backup', code: codes[0], newPassword: 'brand new phrase here' } });
    assert.equal(noTelegram.status, 401, 'the second factor alone is not enough');
    const page = fake.table('gftvonelink_pages')[0];
    assert.equal(fake.table('gftvonelink_recovery_codes').filter((c) => c.page_id === page.id && c.used).length, 0, 'a wrong Telegram code spends no backup code');

    const optionsNoTelegram = await r.call(recover, { method: 'POST', body: { action: 'passkey-options', challenge: start.json.challenge, telegramCode: '000000' } });
    assert.equal(optionsNoTelegram.status, 401, 'no passkey options without the Telegram code');
    assert.equal(optionsNoTelegram.json.options, undefined);
    const optionsNoKeys = await r.call(recover, { method: 'POST', body: { action: 'passkey-options', challenge: start.json.challenge, telegramCode: code } });
    assert.equal(optionsNoKeys.json.error, 'no_passkeys');
    const badPasskey = await r.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, telegramCode: code, factor: 'passkey', response: { id: 'nope' }, newPassword: 'brand new phrase here' } });
    assert.equal(badPasskey.status, 401, 'a passkey response with no challenge behind it fails');

    const done = await r.call(recover, { method: 'POST', body: { action: 'finish', challenge: start.json.challenge, telegramCode: code, factor: 'totp', code: totpAt(secret), newPassword: 'brand new phrase here' } });
    assert.equal(done.status, 200, done.body);
    assert.equal((await a.call(mePage)).status, 401, 'old sessions ended');
    assert.equal((await r.call(mePage)).status, 200);
    assert.equal((await r.call(login, { method: 'POST', body: { slug: 'augy', password: 'brand new phrase here' } })).status, 200);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  }
});

test('reports, and the server-rendered page', async () => {
  const owner = browser();
  await makePage(owner);
  await owner.call(mePage, { method: 'PATCH', body: { displayName: 'Augy <b>', bio: 'Hi </script><script>alert(1)</script>' } });
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Shop', url: 'https://shop.example' } })).json;

  const v = browser();
  assert.equal((await v.call(report, { method: 'POST', body: { slug: 'augy', reason: 'nonsense' } })).status, 400);
  assert.equal((await v.call(report, { method: 'POST', body: { slug: 'augy', linkId: links[0].id, reason: 'scam', details: 'fake shop' } })).status, 200);

  const html = await v.call(render, { query: { slug: 'augy' } });
  assert.equal(html.status, 200);
  assert.match(html.body, /<title>Augy &lt;b&gt; \| OneLink GFTV<\/title>/);
  assert.equal(html.body.includes('</script><script>alert(1)'), false, 'owner text cannot break out of the inlined data');
  assert.equal((await v.call(render, { query: { slug: 'nobody' } })).status, 404);
  const upper = await v.call(render, { query: { slug: 'Augy' } });
  assert.equal(upper.status, 308);
  assert.equal(upper.headers.location, '/augy');
});

// A staff account on the shared gftvhello_users table.
async function makeStaff({ username = 'mod', role = 'admin', approved = true, totp = true } = {}) {
  const secret = generateTotpSecret();
  const user = {
    id: crypto.randomUUID(),
    username,
    display_name: username.toUpperCase(),
    email: `${username}@gftv.asia`,
    password_hash: await bcrypt.hash('staff password 1', 10),
    is_admin: role === 'admin',
    is_editor: role === 'editor',
    is_approved: approved,
    totp_secret: totp ? secret : null,
  };
  fake.table('gftvhello_users').push(user);
  return { user, secret };
}

async function staffSignIn(b, identifier, secret) {
  const step = await b.call(adminAuth, { method: 'POST', body: { action: 'login', identifier, password: 'staff password 1' } });
  assert.equal(step.status, 200, step.body);
  return b.call(adminAuth, { method: 'POST', body: { action: 'verify', challenge: step.json.challenge, method: 'totp', code: totpAt(secret) } });
}

test('staff: who gets in, and the session lives in this app only', async () => {
  const { secret } = await makeStaff();
  const b = browser();
  const ok = await staffSignIn(b, 'MOD@gftv.asia', secret);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json.staff).sort(), ['displayName', 'id', 'role', 'username']);
  assert.equal(fake.table('gftvonelink_staff_sessions').length, 1);
  assert.equal(fake.table('gftvhello_sessions').length, 0, 'nothing written to the shared session table');

  await makeStaff({ username: 'pending', approved: false });
  assert.equal((await browser().call(adminAuth, { method: 'POST', body: { action: 'login', identifier: 'pending', password: 'staff password 1' } })).json.error, 'no_access');
  fake.table('gftvhello_users').push({ id: crypto.randomUUID(), username: 'viewer', email: 'v@x', password_hash: await bcrypt.hash('staff password 1', 10), is_admin: false, is_editor: false, is_approved: true, totp_secret: 'X' });
  assert.equal((await browser().call(adminAuth, { method: 'POST', body: { action: 'login', identifier: 'viewer', password: 'staff password 1' } })).json.error, 'no_access');
  await makeStaff({ username: 'notwofa', totp: false });
  assert.equal((await browser().call(adminAuth, { method: 'POST', body: { action: 'login', identifier: 'notwofa', password: 'staff password 1' } })).json.error, 'staff_needs_2fa');

  // Losing the role on gftv.asia ends access on the next request.
  fake.table('gftvhello_users')[0].is_admin = false;
  assert.equal((await b.call(adminOverview)).status, 401);
});

test('staff backup codes from both sister-site formats', async () => {
  const { user } = await makeStaff();
  const legacy = 'ABCDE-12345';
  fake.table('gftvhello_backup_codes').push(
    { id: crypto.randomUUID(), user_id: user.id, code_hash: createHash('sha256').update(legacy.replace('-', '')).digest('hex') },
    { id: crypto.randomUUID(), user_id: user.id, code_hash: await bcrypt.hash('k7m29xqp', 10) },
  );
  for (const code of ['abcde-12345', 'k7m2-9xqp']) {
    const b = browser();
    const step = await b.call(adminAuth, { method: 'POST', body: { action: 'login', identifier: 'mod', password: 'staff password 1' } });
    assert.equal((await b.call(adminAuth, { method: 'POST', body: { action: 'verify', challenge: step.json.challenge, method: 'backup', code } })).status, 200, code);
  }
  assert.equal(fake.table('gftvhello_backup_codes').length, 0, 'both spent');
});

test('moderation: remove a link, ban a page, roles, and the audit log', async () => {
  const owner = browser();
  await makePage(owner);
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Bad', url: 'https://phish.example/login' } })).json;
  await browser().call(report, { method: 'POST', body: { slug: 'augy', linkId: links[0].id, reason: 'scam' } });

  const { secret: adminSecret } = await makeStaff({ username: 'boss', role: 'admin' });
  const { secret: editorSecret } = await makeStaff({ username: 'ed', role: 'editor' });
  const admin = browser();
  await staffSignIn(admin, 'boss', adminSecret);
  const editor = browser();
  await staffSignIn(editor, 'ed', editorSecret);

  const overview = await editor.call(adminOverview);
  assert.equal(overview.json.counts.openReports, 1);
  const reports = await editor.call(adminReports, { query: { status: 'open' } });
  assert.deepEqual(leaks(reports.json), []);
  const resolved = await editor.call(adminReports, { method: 'POST', body: { action: 'resolve', id: reports.json.reports[0].id, note: 'phishing', removeLink: true } });
  assert.equal(resolved.json.report.status, 'resolved');
  assert.equal((await browser().call(publicPage, { query: { slug: 'augy' } })).json.page.links.length, 0, 'removed link is not served');
  const ownerView = (await owner.call(mePage)).json.page.links[0];
  assert.equal(ownerView.removed, true);
  assert.equal((await owner.call(meLinks, { method: 'PATCH', body: { id: links[0].id, title: 'sneaky' } })).json.error, 'link_removed');

  const pages = await editor.call(adminPages, { query: { q: 'aug' } });
  assert.equal(pages.json.pages.length, 1);
  assert.deepEqual(leaks(pages.json), []);
  const pageId = pages.json.pages[0].id;
  assert.equal((await editor.call(adminPages, { method: 'POST', body: { action: 'ban', id: pageId, reason: 'scam' } })).json.error, 'admin_only');
  assert.equal((await editor.call(adminAudit)).json.error, 'admin_only');

  assert.equal((await admin.call(adminPages, { method: 'POST', body: { action: 'ban', id: pageId, reason: 'scam' } })).status, 200);
  assert.equal((await browser().call(publicPage, { query: { slug: 'augy' } })).status, 410);
  assert.equal((await browser().call(render, { query: { slug: 'augy' } })).status, 410);
  assert.equal((await owner.call(mePage)).status, 401, 'owner signed out by the ban');

  await admin.call(adminBlocklist, { method: 'POST', body: { action: 'add-domain', value: 'https://www.phish.example/x', reason: 'phishing' } });
  assert.equal((await admin.call(adminBlocklist)).json.domains[0].value, 'phish.example');
  await admin.call(adminPages, { method: 'POST', body: { action: 'unban', id: pageId } });
  const searched = await admin.call(adminLinks, { query: { q: 'phish', state: 'removed' } });
  assert.equal(searched.json.links.length, 1);

  const log = await admin.call(adminAudit, { query: { action: 'mod.' } });
  const actions = log.json.entries.map((e) => e.action);
  for (const a of ['mod.link_removed', 'mod.report_resolved', 'mod.page_banned', 'mod.domain_blocked', 'mod.page_unbanned']) assert.ok(actions.includes(a), a);
  assert.equal(log.json.entries.find((e) => e.action === 'mod.page_banned').actorName, 'boss');
  assert.deepEqual(leaks(log.json), []);
});

test('blocked domains refuse new links and hide old ones', async () => {
  const owner = browser();
  await makePage(owner);
  await owner.call(meLinks, { method: 'POST', body: { title: 'Old', url: 'https://cdn.badsite.example/a' } });
  fake.table('gftvonelink_blocked_domains').push({ domain: 'badsite.example', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'New', url: 'https://badsite.example' } })).json.error, 'url_blocked');
  assert.equal((await browser().call(publicPage, { query: { slug: 'augy' } })).json.page.links.length, 0);
});

test('delete page removes everything that hangs off it', async () => {
  const owner = browser();
  const { password } = await makePage(owner);
  await owner.call(meLinks, { method: 'POST', body: { title: 'x', url: 'https://example.com' } });
  assert.equal((await owner.call(security, { method: 'POST', body: { action: 'delete-page', password, confirmSlug: 'nope' } })).json.error, 'confirm_slug');
  assert.equal((await owner.call(security, { method: 'POST', body: { action: 'delete-page', password, confirmSlug: 'augy' } })).status, 200);
  for (const t of ['gftvonelink_pages', 'gftvonelink_links', 'gftvonelink_sessions', 'gftvonelink_recovery_codes']) assert.equal(fake.table(t).length, 0, t);
  assert.equal((await owner.call(session)).json.signedIn, false);
});

test('rate limits answer 429', async () => {
  const b = browser();
  let last;
  for (let i = 0; i < 11; i += 1) last = await b.call(login, { method: 'POST', body: { slug: 'nobody', password: 'whatever whatever' } });
  assert.equal(last.status, 429);
});

test('cron cleanup needs its secret', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  try {
    assert.equal((await browser().call(cleanup)).status, 401);
    fake.table('gftvonelink_sessions').push({ id: 'old', page_id: null, token_hash: 'x', expires_at: new Date(0).toISOString() });
    const ran = await browser().call(cleanup, { headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(ran.status, 200);
    assert.equal(ran.json.removed.sessions, 1);
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('origin used by the harness is the production one', () => {
  assert.equal(ORIGIN, 'https://links.gftv.asia');
});

test('profile pictures: re-encoded to 512px WebP, metadata gone, old file removed', async () => {
  const sharp = (await import('sharp')).default;
  const avatar = (await import('../api/me/avatar.js')).default;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  try {
    const owner = browser();
    await makePage(owner);
    // A 900 by 600 JPEG carrying EXIF, as a phone would send it.
    const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#3366cc' } })
      .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret-location-marker' } } }).toBuffer();
    const sent = await owner.call(avatar, { method: 'POST', body: { image: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
    assert.equal(sent.status, 200, sent.body);
    assert.match(sent.json.page.avatarUrl, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/gftvonelink_avatars\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+\.webp$/);

    assert.equal(fake.objects.size, 1);
    const [[key, stored]] = [...fake.objects];
    assert.equal(stored.contentType, 'image/webp');
    const meta = await sharp(stored.body).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512]);
    assert.equal(meta.exif, undefined, 'EXIF stripped');
    assert.equal(stored.body.includes('secret-location-marker'), false);

    const pub = await browser().call(publicPage, { query: { slug: 'augy' } });
    assert.equal(pub.json.page.avatarUrl, sent.json.page.avatarUrl);
    assert.deepEqual(leaks(pub.json), []);
    assert.equal(JSON.stringify(pub.json).includes('avatar_path'), false);

    // Replacing removes the old file; removing clears both.
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff0000' } }).png().toBuffer();
    await owner.call(avatar, { method: 'POST', body: { image: png.toString('base64') } });
    assert.equal(fake.objects.size, 1);
    assert.equal(fake.objects.has(key), false);
    assert.equal((await owner.call(avatar, { method: 'DELETE', body: {} })).json.page.avatarUrl, null);
    assert.equal(fake.objects.size, 0);

    for (const bad of ['', 'not base64 at all', Buffer.from('<svg onload=alert(1)>').toString('base64'), Buffer.from('GIF89a....').toString('base64')]) {
      assert.equal((await owner.call(avatar, { method: 'POST', body: { image: bad } })).json.error, 'avatar_invalid', bad.slice(0, 20));
    }
    const huge = Buffer.alloc(3 * 1024 * 1024 + 10, 0xff);
    assert.equal((await owner.call(avatar, { method: 'POST', body: { image: huge.toString('base64') } })).json.error, 'avatar_too_large');
  } finally {
    delete process.env.SUPABASE_URL;
  }
});

test('staff can remove a picture; deleting a page removes it too', async () => {
  const sharp = (await import('sharp')).default;
  const avatar = (await import('../api/me/avatar.js')).default;
  const owner = browser();
  const { password } = await makePage(owner);
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00aa00' } }).png().toBuffer();
  await owner.call(avatar, { method: 'POST', body: { image: png.toString('base64') } });
  assert.equal(fake.objects.size, 1);

  const { secret } = await makeStaff({ username: 'ed', role: 'editor' });
  const editor = browser();
  await staffSignIn(editor, 'ed', secret);
  const pageId = fake.table('gftvonelink_pages')[0].id;
  assert.equal((await editor.call(adminPages, { method: 'POST', body: { action: 'remove-avatar', id: pageId } })).json.error, 'reason_required');
  assert.equal((await editor.call(adminPages, { method: 'POST', body: { action: 'remove-avatar', id: pageId, reason: 'offensive' } })).status, 200);
  assert.equal(fake.objects.size, 0);
  assert.equal(fake.table('gftvonelink_audit_logs').some((r) => r.action === 'mod.avatar_removed'), true);

  await owner.call(avatar, { method: 'POST', body: { image: png.toString('base64') } });
  await owner.call(security, { method: 'POST', body: { action: 'delete-page', password, confirmSlug: 'augy' } });
  assert.equal(fake.objects.size, 0, 'the picture goes with the page');
});

test('an admin can delete a page, which frees its name', async () => {
  const sharp = (await import('sharp')).default;
  const avatar = (await import('../api/me/avatar.js')).default;
  const owner = browser();
  await makePage(owner);
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00aa00' } }).png().toBuffer();
  await owner.call(avatar, { method: 'POST', body: { image: png.toString('base64') } });
  await owner.call(meLinks, { method: 'POST', body: { title: 'Site', url: 'https://example.com' } });
  const pageId = fake.table('gftvonelink_pages')[0].id;

  const { secret: adminSecret } = await makeStaff({ username: 'boss', role: 'admin' });
  const { secret: editorSecret } = await makeStaff({ username: 'ed', role: 'editor' });
  const admin = browser();
  await staffSignIn(admin, 'boss', adminSecret);
  const editor = browser();
  await staffSignIn(editor, 'ed', editorSecret);

  const del = (b, body) => b.call(adminPages, { method: 'POST', body: { action: 'delete', id: pageId, ...body } });
  assert.equal((await del(editor, { reason: 'spam', confirmSlug: 'augy' })).json.error, 'admin_only');
  assert.equal((await del(admin, { confirmSlug: 'augy' })).json.error, 'reason_required');
  assert.equal((await del(admin, { reason: 'spam', confirmSlug: 'aug' })).json.error, 'confirm_slug');
  assert.equal(fake.table('gftvonelink_pages').length, 1, 'nothing deleted yet');

  const done = await del(admin, { reason: 'spam', confirmSlug: 'AUGY' });
  assert.equal(done.status, 200, done.body);
  assert.equal(done.json.slug, 'augy');
  for (const table of ['gftvonelink_pages', 'gftvonelink_links', 'gftvonelink_sessions', 'gftvonelink_recovery_codes']) {
    assert.equal(fake.table(table).length, 0, table);
  }
  assert.equal(fake.objects.size, 0, 'the picture is deleted');
  assert.equal((await owner.call(mePage)).status, 401, 'the owner is signed out');
  const logged = fake.table('gftvonelink_audit_logs').find((r) => r.action === 'mod.page_deleted');
  assert.deepEqual(logged.details, { slug: 'augy', reason: 'spam' });

  assert.equal((await browser().call(slug, { query: { slug: 'augy' } })).json.available, true, 'the name is free');
  await makePage(browser());
  assert.equal(fake.table('gftvonelink_pages').length, 1, 'and can be registered again');
});
