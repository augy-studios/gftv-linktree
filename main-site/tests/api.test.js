// End to end through the real route handlers, against tests/fake-db.js.
import { browser, leaks, ORIGIN } from './harness.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { useTestClient } from '../api/_lib/supabase.js';
import { createFakeDb } from './fake-db.js';
import { totpAt, generateTotpSecret } from '../api/_lib/totp.js';
import { forgetDomainBlocklist } from '../api/_lib/domain-blocklist.js';
import { forgetBlockedDomains, forgetBlockedPatterns, forgetReviewPatterns } from '../api/_lib/guards.js';

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
import visit from '../api/public/visit.js';
import meStats from '../api/me/stats.js';
import publicTestimonials from '../api/public/testimonials.js';
import adminTestimonials from '../api/admin/testimonials.js';
import publicInsights from '../api/public/insights.js';
import meTestimonial from '../api/me/testimonial.js';

let fake;
beforeEach(() => {
  fake = createFakeDb();
  useTestClient(fake);
  forgetBlockedDomains();
  forgetBlockedPatterns();
  forgetReviewPatterns();
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
  fake.table('gftvonelink_blocked_slugs').push({ slug: 'squatter', reason: 'x', created_at: new Date().toISOString() });
  assert.equal((await attempt({ slug: 'squatter', password: 'correct horse battery' })).json.error, 'slug_reserved');
  for (const posing of ['gftvhq', 'gftvofficial', 'cpf-refund', 'g-f-t-v']) {
    assert.equal((await attempt({ slug: posing, password: 'correct horse battery' })).json.error, 'slug_not_allowed', posing);
  }
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
  // Four attempts like these quarantine a page (tested on its own below).
  fake.table('gftvonelink_pages')[0].quarantined_at = null;
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
  assert.deepEqual(Object.keys(pub.json.page).sort(), ['avatarUrl', 'bio', 'displayName', 'links', 'redirectUrl', 'slug']);
  assert.equal(pub.json.page.redirectUrl, null);
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
    assert.equal((await r.call(webhook, { method: 'POST', body: { message: { chat: { id: 987654321, type: 'private' }, from: { username: 'augy' }, text: `/start ${token}` } }, headers: { 'x-telegram-bot-api-secret-token': 'wrong' } })).status, 401);
    await r.call(webhook, { method: 'POST', body: { message: { chat: { id: 987654321, type: 'private' }, from: { username: 'augy' }, text: `/start ${token}` } }, headers: { 'x-telegram-bot-api-secret-token': 'hook-secret' } });
    const view = (await a.call(mePage)).json.page;
    assert.deepEqual(view.security.telegram, { linked: true, username: 'augy' });
    assert.equal(JSON.stringify(view).includes('987654321'), false, 'the chat id never reaches the browser');

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
  forgetBlockedPatterns();
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

test('a page can redirect instead of listing links', async () => {
  const owner = browser();
  await makePage(owner);
  await owner.call(meLinks, { method: 'POST', body: { title: 'Kept', url: 'https://example.com' } });

  for (const bad of ['javascript:alert(1)', 'https://gftv.asia@evil.example']) {
    assert.equal((await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: bad } })).status, 400, bad);
  }
  const set = await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: 'example.org/shop' } });
  assert.equal(set.json.page.redirectUrl, 'https://example.org/shop');
  let pub = (await browser().call(publicPage, { query: { slug: 'augy' } })).json.page;
  assert.equal(pub.redirectUrl, 'https://example.org/shop');
  assert.equal(pub.links.length, 1, 'the links are kept for when the redirect is turned off');

  // A redirect the block lists catch later is not served; the links are.
  fake.table('gftvonelink_blocked_domains').push({ domain: 'example.org', reason: 'x', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  pub = (await browser().call(publicPage, { query: { slug: 'augy' } })).json.page;
  assert.equal(pub.redirectUrl, null);
  assert.equal((await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: 'https://shop.example.org' } })).json.error, 'url_blocked');

  const off = await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: '' } });
  assert.equal(off.json.page.redirectUrl, null);
});

test('a link can be an email address, but a redirect cannot', async () => {
  const owner = browser();
  await makePage(owner);
  const saved = await owner.call(meLinks, { method: 'POST', body: { title: 'Mail me', url: 'Me@Example.COM', icon: 'mail' } });
  assert.equal(saved.json.links[0].url, 'mailto:Me@example.com');
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'x', url: 'mailto:me@example.com?bcc=them@example.net' } })).json.error, 'mail_invalid');
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'x', url: 'javascript:alert(1)' } })).json.error, 'url_scheme_link');
  assert.equal((await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: 'mailto:me@example.com' } })).json.error, 'url_scheme');

  let pub = (await browser().call(publicPage, { query: { slug: 'augy' } })).json.page;
  assert.equal(pub.links[0].url, 'mailto:Me@example.com');

  // The block lists reach an email address through its domain.
  fake.table('gftvonelink_blocked_domains').push({ domain: 'example.com', reason: 'x', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  pub = (await browser().call(publicPage, { query: { slug: 'augy' } })).json.page;
  assert.equal(pub.links.length, 0);
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'x', url: 'mailto:other@mail.example.com' } })).json.error, 'url_blocked');
});

test('a page goes dormant after a year without a sign-in, and a sign-in brings it back', async () => {
  const owner = browser();
  const { secret, password } = await makePage(owner);
  const page = fake.table('gftvonelink_pages')[0];
  assert.ok(page.last_sign_in_at, 'setup counts as a sign-in');

  page.last_sign_in_at = new Date(Date.now() - 340 * 86400_000).toISOString();
  assert.equal((await browser().call(publicPage, { query: { slug: 'augy' } })).status, 200, 'still live inside the year');

  // The reminder goes out once, a month before.
  process.env.CRON_SECRET = 'cron-secret';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'onelink_test_bot';
  page.telegram_chat_id = 42;
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ method: String(url).split('/').pop(), ...JSON.parse(init.body) });
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const run = () => browser().call(cleanup, { headers: { authorization: 'Bearer cron-secret' } });
    assert.equal((await run()).json.reminded, 1);
    assert.equal((await run()).json.reminded, 0, 'only once');
    assert.equal(sent.length, 1);
    assert.match(sent[0].rich_message.markdown, /links\.gftv\.asia\/augy/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CRON_SECRET;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_USERNAME;
  }

  page.last_sign_in_at = new Date(Date.now() - 366 * 86400_000).toISOString();
  const gone = await browser().call(publicPage, { query: { slug: 'augy' } });
  assert.equal(gone.status, 410);
  assert.equal(gone.json.error, 'page_dormant');
  assert.equal((await browser().call(render, { query: { slug: 'augy' } })).status, 410);
  assert.equal((await browser().call(slug, { query: { slug: 'augy' } })).json.available, false, 'the name stays held');

  const back = browser();
  const step = await back.call(login, { method: 'POST', body: { slug: 'augy', password } });
  assert.equal((await back.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'totp', code: totpAt(secret) } })).status, 200);
  assert.equal((await browser().call(publicPage, { query: { slug: 'augy' } })).status, 200, 'signing in restores it');
  assert.equal(page.dormancy_warned_at, null, 'and resets the reminder');
});

test('visits and clicks become insights, with nothing about the visitor', async () => {
  const owner = browser();
  await makePage(owner);
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Site', url: 'https://example.com' } })).json;
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
  const seen = (ip, extra = {}) => browser().call(visit, {
    method: 'POST', ip, body: { slug: 'augy', referrer: 'https://l.instagram.com/?u=x' },
    headers: { 'user-agent': phone, 'x-vercel-ip-country': 'sg', ...extra },
  });
  assert.equal((await seen('203.0.113.1')).json.counted, true);
  assert.equal((await seen('203.0.113.1')).json.counted, false, 'once per visitor per half hour');
  assert.equal((await seen('203.0.113.2', { 'x-vercel-ip-country': 'MY', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' })).json.counted, true);
  assert.equal((await seen('203.0.113.3', { 'user-agent': 'facebookexternalhit/1.1' })).json.counted, false, 'previews are not visits');
  await browser().call(click, { method: 'POST', body: { id: links[0].id } });

  const stats = await owner.call(meStats, { query: { days: '7' } });
  assert.equal(stats.status, 200, stats.body);
  assert.deepEqual(stats.json.totals, { visits: 2, clicks: 1 });
  assert.equal(stats.json.daily.length, 7);
  assert.equal(stats.json.daily.at(-1).visits, 2);
  assert.deepEqual(stats.json.countries, [{ key: 'MY', hits: 1 }, { key: 'SG', hits: 1 }]);
  assert.deepEqual(stats.json.devices.map((d) => d.key).sort(), ['desktop', 'mobile']);
  assert.deepEqual(stats.json.referrers, [{ key: 'instagram.com', hits: 2 }]);
  const stored = JSON.stringify(fake.table('gftvonelink_page_stats'));
  assert.equal(stored.includes('203.0.113'), false, 'no address is kept');
  assert.equal((await browser().call(meStats)).status, 401);
});

test('staff block patterns: names, links, and slow patterns refused', async () => {
  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  const add = (value, appliesTo) => admin.call(adminBlocklist, { method: 'POST', body: { action: 'add-pattern', value, appliesTo, reason: 'test' } });

  assert.equal((await add('(a+)+', 'links')).json.error, 'pattern_slow');
  assert.equal((await add('[', 'links')).json.error, 'pattern_invalid');
  assert.equal((await add('^scam', 'names')).status, 200);
  const both = await add('promo\\.example/', 'links');
  assert.equal(both.json.patterns.length, 2);

  assert.deepEqual((await browser().call(slug, { query: { slug: 'scamshop' } })).json, { ok: true, available: false, reason: 'slug_not_allowed' });
  assert.equal((await browser().call(slug, { query: { slug: 'not-a-scam' } })).json.available, true, 'anchored to the start');

  const owner = browser();
  await makePage(owner);
  await owner.call(meLinks, { method: 'POST', body: { title: 'Fine', url: 'https://example.com' } });
  // Added before the pattern, then caught by it: hidden from visitors.
  fake.table('gftvonelink_links').push({ id: crypto.randomUUID(), page_id: fake.table('gftvonelink_pages')[0].id, title: 'Short', url: 'https://promo.example/abc', icon: 'link', order_index: 5, click_count: 0, is_active: true, removed_at: null });
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Short', url: 'https://PROMO.EXAMPLE/xyz' } })).json.error, 'url_blocked', 'case does not matter');
  const pub = (await browser().call(publicPage, { query: { slug: 'augy' } })).json.page;
  assert.deepEqual(pub.links.map((l) => l.title), ['Fine']);

  const id = both.json.patterns.find((p) => p.value === 'promo\\.example/').id;
  await admin.call(adminBlocklist, { method: 'POST', body: { action: 'remove-pattern', id } });
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Short', url: 'https://promo.example/xyz' } })).status, 200);
  const actions = fake.table('gftvonelink_audit_logs').map((r) => r.action);
  assert.ok(actions.includes('mod.pattern_blocked') && actions.includes('mod.pattern_unblocked'));
});

test('names on the review list wait for staff approval before going live', async () => {
  const { secret: adminSecret } = await makeStaff({ username: 'boss', role: 'admin' });
  const { secret: editorSecret } = await makeStaff({ username: 'ed', role: 'editor' });
  const admin = browser();
  await staffSignIn(admin, 'boss', adminSecret);
  const editor = browser();
  await staffSignIn(editor, 'ed', editorSecret);
  const added = await admin.call(adminBlocklist, { method: 'POST', body: { action: 'add-review', value: 'furcon', reason: 'event names' } });
  assert.equal(added.json.reviews.length, 1);

  assert.deepEqual((await browser().call(slug, { query: { slug: 'sgfurcon' } })).json, { ok: true, available: true, slug: 'sgfurcon', reason: null, review: true });
  assert.equal((await browser().call(slug, { query: { slug: 'augy' } })).json.review, false);

  const owner = browser();
  await makePage(owner, 'sgfurcon');
  const page = fake.table('gftvonelink_pages')[0];
  assert.equal(page.needs_review, true);
  assert.equal((await owner.call(mePage)).json.page.awaitingReview, true, 'the owner is told');
  assert.equal((await browser().call(publicPage, { query: { slug: 'sgfurcon' } })).json.error, 'page_in_review');
  assert.equal((await browser().call(render, { query: { slug: 'sgfurcon' } })).status, 404);
  assert.equal((await editor.call(adminOverview)).json.counts.awaitingReview, 1);
  assert.equal((await editor.call(adminPages, { query: { status: 'review' } })).json.pages.length, 1);

  assert.equal((await editor.call(adminPages, { method: 'POST', body: { action: 'approve', id: page.id } })).status, 200, 'editors can approve');
  assert.equal((await browser().call(publicPage, { query: { slug: 'sgfurcon' } })).status, 200);
  assert.equal((await editor.call(adminPages, { method: 'POST', body: { action: 'approve', id: page.id } })).json.error, 'not_in_review');
  assert.ok(fake.table('gftvonelink_audit_logs').some((r) => r.action === 'mod.page_approved'));
});

test('links: shorteners refused, Safe Browsing checked on save and again daily', async () => {
  const owner = browser();
  await makePage(owner);
  for (const url of ['https://bit.ly/abc', 'tinyurl.com/x', 'https://www.cutt.ly/y']) {
    assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Short', url } })).json.error, 'url_shortener', url);
  }
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'YouTube', url: 'https://youtu.be/abc' } })).status, 200, "a service's own short domain is fine");
  assert.equal((await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: 'https://bit.ly/abc' } })).json.error, 'url_shortener');

  process.env.GOOGLE_SAFE_BROWSING_KEY = 'sb-key';
  process.env.CRON_SECRET = 'cron-secret';
  const bad = new Set(['https://phish.example/login']);
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /safebrowsing\.googleapis\.com\/v4\/threatMatches:find\?key=sb-key/);
    const entries = JSON.parse(init.body).threatInfo.threatEntries.map((e) => e.url);
    asked.push(...entries);
    const matches = entries.filter((u) => bad.has(u)).map((u) => ({ threatType: 'SOCIAL_ENGINEERING', threat: { url: u } }));
    return new Response(JSON.stringify(matches.length ? { matches } : {}), { status: 200 });
  };
  try {
    assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Bad', url: 'https://phish.example/login' } })).json.error, 'url_unsafe');
    const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Later', url: 'https://later.example/' } })).json;
    await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: 'https://turned.example/' } });

    // Both go bad after they were added.
    bad.add('https://later.example/');
    bad.add('https://turned.example/');
    const ran = await browser().call(cleanup, { headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(ran.json.unsafe, 2);
    const later = (await owner.call(mePage)).json.page;
    assert.equal(later.links.find((l) => l.id === links.find((x) => x.title === 'Later').id).removed, true);
    assert.equal(later.redirectUrl, null, 'a flagged redirect is switched off');

    // A lookup that fails lets the address through.
    globalThis.fetch = async () => new Response('nope', { status: 503 });
    assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Ok', url: 'https://fine.example/' } })).status, 200);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GOOGLE_SAFE_BROWSING_KEY;
    delete process.env.CRON_SECRET;
  }
});

test('links: the domain blocklists, built into an index every two weeks', async () => {
  const owner = browser();
  await makePage(owner);
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Was fine', url: 'https://shop.fakestore.example/x' } })).json;
  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);

  const LISTS = {
    'https://lists.example/tif.txt': '# Title: test\n# Syntax: Domains Wildcard\n#\n*.evil.example\nmalware.example\n',
    'https://lists.example/fake.txt': '*.fakestore.example\n*.evil.example\n',
    'https://lists.example/gambling.txt': '*.casino.example\n',
    'https://lists.example/nsfw.txt': '*.adult.example\n',
    'https://lists.example/short.txt': '*.tiny.example\n',
    'https://lists.example/piracy.txt': '*.warez.example\n',
  };
  process.env.DOMAIN_BLOCKLISTS = [
    'unsafe:https://lists.example/tif.txt', 'unsafe:https://lists.example/fake.txt', 'gambling:https://lists.example/gambling.txt',
    'adult:https://lists.example/nsfw.txt', 'shortener:https://lists.example/short.txt', 'piracy:https://lists.example/piracy.txt',
  ].join(',');
  process.env.CRON_SECRET = 'cron-secret';
  forgetDomainBlocklist();
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(LISTS[String(url)], { status: 200 });
  };
  try {
    // Before any index exists, addresses get through.
    assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Early', url: 'https://notyet.evil.example/' } })).status, 200);

    const run = () => browser().call(cleanup, { headers: { authorization: 'Bearer cron-secret' } });
    const first = await run();
    assert.deepEqual(first.json.blocklist, { rebuilt: { unsafe: 3, gambling: 1, adult: 1, piracy: 1, shortener: 1 } }, 'duplicates across lists are merged');
    assert.equal(first.json.unsafe, 2, 'existing links on the lists are taken down');
    const removed = (await owner.call(mePage)).json.page.links.find((l) => l.id === links[0].id);
    assert.equal(removed.removed, true);
    assert.match(removed.removedReason, /HaGeZi/);
    assert.equal(fake.objects.get('gftvonelink_lists/domain-blocklist-unsafe.bin').body.length, 3 * 8, 'eight bytes a domain');

    forgetDomainBlocklist();
    // Each from its own connection, so the day's refusals do not flag one
    // (that is tested on its own).
    let ip = 0;
    const save = async (url) => (await owner.call(meLinks, { method: 'POST', body: { title: 'x', url }, ip: `198.51.100.${(ip += 1)}` })).json.error;
    assert.equal(await save('https://login.evil.example/'), 'url_unsafe');
    assert.equal(await save('https://MALWARE.example/'), 'url_unsafe');
    assert.equal(await save('https://www.casino.example/'), 'url_gambling');
    assert.equal(await save('https://adult.example/'), 'url_adult');
    assert.equal(await save('https://tiny.example/abc'), 'url_shortener');
    assert.equal(await save('https://dl.warez.example/x'), 'url_piracy');
    assert.equal(await save('https://notevil.example/'), undefined, 'a different domain ending the same is fine');

    fetched.length = 0;
    assert.ok((await run()).json.blocklist.current, 'not rebuilt inside two weeks');
    assert.equal(fetched.length, 0);

    const info = (await admin.call(adminBlocklist)).json.threatList;
    assert.deepEqual(info.categories, { unsafe: 3, gambling: 1, adult: 1, piracy: 1, shortener: 1 });
    assert.equal(info.refreshDays, 14);
    await admin.call(adminBlocklist, { method: 'POST', body: { action: 'refresh-threat-list' } });
    assert.equal(fetched.length, 6, 'staff can rebuild it now');
  } finally {
    globalThis.fetch = realFetch;
    process.env.DOMAIN_BLOCKLISTS = 'off';
    delete process.env.CRON_SECRET;
    forgetDomainBlocklist();
  }
});

test('repeated harmful addresses quarantine the page and flag the connection', async () => {
  const owner = browser();
  await makePage(owner);
  fake.table('gftvonelink_blocked_domains').push({ domain: 'evil.example', reason: 'x', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  const add = (url, ip) => owner.call(meLinks, { method: 'POST', body: { title: 'x', url }, ip });

  assert.equal((await add('https://bit.ly/x')).json.error, 'url_shortener');
  assert.equal((await add('notaurl')).json.error, 'url_invalid');
  assert.equal(fake.table('gftvonelink_pages')[0].quarantined_at, null, 'typos and shorteners do not count');

  await add('https://evil.example/1');
  await add('https://a.evil.example/2');
  assert.equal((await owner.call(mePage)).json.page.quarantined, false);
  await owner.call(mePage, { method: 'PATCH', body: { redirectUrl: 'https://b.evil.example/3' } });
  const page = fake.table('gftvonelink_pages')[0];
  assert.ok(page.quarantined_at, 'the third quarantines it');
  assert.equal((await owner.call(mePage)).json.page.quarantined, true, 'the owner is told');
  assert.equal((await browser().call(publicPage, { query: { slug: 'augy' } })).json.error, 'page_in_review');
  const report = fake.table('gftvonelink_reports').find((r) => r.page_id === page.id);
  assert.match(report.details, /^Automatic: 3 harmful addresses/);

  // Five from one connection and it is turned away for the day.
  await add('javascript:alert(1)');
  await add('data:text/html,hi');
  assert.equal((await add('https://fine.example/')).json.error, 'too_many_refused_links');
  assert.equal((await add('https://fine.example/', '198.51.100.99')).status, 200, 'other connections are not');
  const actions = fake.table('gftvonelink_audit_logs').map((r) => r.action);
  assert.ok(actions.includes('security.ip_flagged') && actions.includes('mod.page_quarantined'));
  assert.equal(JSON.stringify(fake.table('gftvonelink_audit_logs')).includes('203.0.113.7'), false, 'only a hash of the address');

  const { secret } = await makeStaff({ username: 'ed', role: 'editor' });
  const editor = browser();
  await staffSignIn(editor, 'ed', secret);
  assert.equal((await editor.call(adminOverview)).json.counts.quarantined, 1);
  const listed = (await editor.call(adminPages, { query: { status: 'quarantined' } })).json.pages;
  assert.equal(listed[0].quarantineReason, page.quarantine_reason);
  assert.equal((await editor.call(adminPages, { method: 'POST', body: { action: 'release', id: page.id } })).status, 200);
  assert.equal((await browser().call(publicPage, { query: { slug: 'augy' } })).status, 200);

  // A release starts the page's count again, so one more mistake does not
  // quarantine it straight back.
  await add('https://evil.example/again', '198.51.100.50');
  assert.equal(page.quarantined_at, null);

  // Admins see the flagged connection by the start of its hash and can lift it.
  const { secret: bossSecret } = await makeStaff({ username: 'boss', role: 'admin' });
  const boss = browser();
  await staffSignIn(boss, 'boss', bossSecret);
  assert.equal((await editor.call(adminBlocklist)).json.error, 'admin_only');
  const flagged = (await boss.call(adminBlocklist)).json.flagged;
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].id, /^[0-9a-f]{16}$/);
  assert.equal(flagged[0].attempts, 5);
  assert.equal(flagged[0].slug, 'augy');
  const lifted = await boss.call(adminBlocklist, { method: 'POST', body: { action: 'unflag-connection', id: flagged[0].id } });
  assert.deepEqual(lifted.json.flagged, []);
  assert.equal((await add('https://fine.example/2')).status, 200, 'the connection can save links again');
  assert.equal((await boss.call(adminBlocklist, { method: 'POST', body: { action: 'unflag-connection', id: flagged[0].id } })).json.error, 'not_flagged');
  assert.ok(fake.table('gftvonelink_audit_logs').some((r) => r.action === 'mod.connection_unflagged'));
});

test('the home page totals are real, and borrow the GFTV short links log', async () => {
  const empty = await browser().call(publicInsights);
  assert.equal(empty.json.clicks, 0);
  assert.equal(empty.json.referrer, null);
  assert.equal(empty.json.daily.length, 30);
  assert.match(empty.headers['cache-control'], /s-maxage=600/);

  const owner = browser();
  await makePage(owner);
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Site', url: 'https://example.com' } })).json;
  await browser().call(visit, { method: 'POST', body: { slug: 'augy', referrer: 'https://www.instagram.com/' }, headers: { 'user-agent': 'iPhone Mobile', 'x-vercel-ip-country': 'SG' } });
  await browser().call(click, { method: 'POST', body: { id: links[0].id } });
  const now = new Date().toISOString();
  fake.table('gftvlinks_linkvisits').push(
    { id: 'v1', link_id: 'x', slug: 'gftv', visited_at: now, device_type: 'Mobile' },
    { id: 'v2', link_id: 'x', slug: 'gftv', visited_at: now, device_type: 'Desktop' },
  );

  const data = (await browser().call(publicInsights)).json;
  assert.equal(data.clicks, 3, 'one OneLink click and two short link visits');
  assert.equal(data.visits, 1);
  assert.equal(data.pages, 1);
  assert.equal(data.daily.at(-1).clicks, 3);
  assert.deepEqual(data.devices, { mobile: 2, tablet: 0, desktop: 1, others: 0 });
  assert.deepEqual(data.country, { key: 'SG', hits: 1 });
  assert.deepEqual(data.referrer, { key: 'instagram.com', hits: 1, share: 100 });
  assert.deepEqual(leaks(data), []);
});

test('a second page quarantined from one connection bans it, until staff lift the ban', async () => {
  fake.table('gftvonelink_blocked_domains').push({ domain: 'evil.example', reason: 'x', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  const ip = '203.0.113.66';
  const quarantineFrom = async (b) => {
    for (const n of [1, 2, 3]) await b.call(meLinks, { method: 'POST', body: { title: 'x', url: `https://evil.example/${n}` }, ip });
  };
  const first = browser();
  await makePage(first, 'first');
  await quarantineFrom(first);
  assert.equal(fake.table('gftvonelink_ip_bans').length, 0, 'one quarantined page is not enough');

  // The second account's attempts come after a flag on the connection would
  // stop them, so lift the day's flag the way staff would.
  fake.table('gftvonelink_rate_limits').filter((r) => r.bucket.startsWith('badlink:ip:')).forEach((r) => { r.hits = 0; });
  const second = browser();
  await makePage(second, 'second');
  await quarantineFrom(second);
  assert.equal(fake.table('gftvonelink_ip_bans').length, 1, 'the second bans the connection');
  assert.ok(fake.table('gftvonelink_audit_logs').some((r) => r.action === 'security.ip_banned'));

  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ip })).json.error, 'ip_banned');
  assert.equal((await second.call(meLinks, { method: 'POST', body: { title: 'ok', url: 'https://fine.example' }, ip })).json.error, 'ip_banned');
  assert.equal((await second.call(mePage, { method: 'PATCH', body: { bio: 'hi' }, ip })).json.error, 'ip_banned');
  assert.equal((await second.call(mePage, { ip })).status, 200, 'the owner can still sign in and look');
  assert.equal((await second.call(meLinks, { method: 'POST', body: { title: 'ok', url: 'https://fine.example' }, ip: '198.51.100.7' })).status, 200, 'other connections are not banned');

  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  const banned = (await admin.call(adminBlocklist)).json.banned;
  assert.equal(banned.length, 1);
  assert.deepEqual(banned[0].slugs.sort(), ['first', 'second']);
  assert.equal(banned[0].byStaff, false);
  const lifted = await admin.call(adminBlocklist, { method: 'POST', body: { action: 'unban-connection', id: banned[0].id } });
  assert.deepEqual(lifted.json.banned, []);
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ip })).status, 200);

  // A flagged connection can also be banned by hand.
  for (const n of [4, 5, 6, 7, 8]) await second.call(meLinks, { method: 'POST', body: { title: 'x', url: `https://evil.example/${n}` }, ip: '198.51.100.9' });
  const flagged = (await admin.call(adminBlocklist)).json.flagged.find((f) => f.attempts >= 5);
  const manual = await admin.call(adminBlocklist, { method: 'POST', body: { action: 'ban-connection', id: flagged.id, reason: 'spam wave' } });
  assert.equal(manual.json.banned.find((b) => b.id === flagged.id).byStaff, true);
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'fourth', password: 'correct horse battery' }, ip: '198.51.100.9' })).json.error, 'ip_banned');
});

test('owners send testimonials, which wait for an admin or editor', async () => {
  const owner = browser();
  const { password } = await makePage(owner);
  await owner.call(mePage, { method: 'PATCH', body: { displayName: 'Augy' } });
  const send = (body) => owner.call(meTestimonial, { method: 'POST', body });

  assert.equal((await send({ quote: 'Love it' })).json.error, 'testimonial_consent', 'agreeing to be shown is required');
  assert.equal((await send({ quote: '', consent: true })).json.error, 'testimonial_required');
  assert.equal((await send({ quote: 'Go to bit[.]ly/x', consent: true })).json.error, 'text_address');
  const sent = await send({ quote: 'Made my con badge QR in a minute', consent: true });
  assert.equal(sent.json.testimonial.status, 'pending');
  assert.deepEqual((await browser().call(publicTestimonials)).json.testimonials, [], 'not shown until approved');

  const { secret } = await makeStaff({ username: 'ed', role: 'editor' });
  const editor = browser();
  await staffSignIn(editor, 'ed', secret);
  assert.equal((await editor.call(adminOverview)).json.counts.pendingTestimonials, 1);
  const waiting = (await editor.call(adminTestimonials)).json.testimonials.find((x) => x.status === 'pending');
  assert.equal(waiting.sentByOwner, true);
  assert.equal(waiting.author, 'Augy');
  assert.equal(waiting.pageSlug, 'augy');
  await editor.call(adminTestimonials, { method: 'POST', body: { action: 'approve', id: waiting.id } });
  assert.deepEqual((await browser().call(publicTestimonials)).json.testimonials.map((x) => x.quote), ['Made my con badge QR in a minute']);
  assert.equal((await owner.call(meTestimonial)).json.testimonial.status, 'approved', 'the owner sees it went up');

  // Sending again replaces it, and it waits again.
  await send({ quote: 'Still love it', consent: true });
  assert.equal(fake.table('gftvonelink_testimonials').length, 1, 'one per page');
  assert.deepEqual((await browser().call(publicTestimonials)).json.testimonials, []);
  await editor.call(adminTestimonials, { method: 'POST', body: { action: 'decline', id: waiting.id } });
  assert.equal((await owner.call(meTestimonial)).json.testimonial.status, 'declined');

  assert.equal((await owner.call(meTestimonial, { method: 'DELETE', body: {} })).json.testimonial, null, 'the owner can withdraw it');
  await send({ quote: 'Again', consent: true });
  await owner.call(security, { method: 'POST', body: { action: 'delete-page', password, confirmSlug: 'augy' } });
  assert.equal(fake.table('gftvonelink_testimonials').length, 0, 'deleting the page takes it too');
});

test('admins can delete a report, and the audit log keeps what it said', async () => {
  const owner = browser();
  await makePage(owner);
  await browser().call(report, { method: 'POST', body: { slug: 'augy', reason: 'spam', details: 'Mistaken report' } });
  const reportId = fake.table('gftvonelink_reports')[0].id;

  const { secret: adminSecret } = await makeStaff({ username: 'boss', role: 'admin' });
  const { secret: editorSecret } = await makeStaff({ username: 'ed', role: 'editor' });
  const admin = browser();
  await staffSignIn(admin, 'boss', adminSecret);
  const editor = browser();
  await staffSignIn(editor, 'ed', editorSecret);

  assert.equal((await editor.call(adminReports, { method: 'POST', body: { action: 'delete', id: reportId } })).json.error, 'admin_only');
  const done = await admin.call(adminReports, { method: 'POST', body: { action: 'delete', id: reportId } });
  assert.equal(done.json.deleted, true);
  assert.equal(fake.table('gftvonelink_reports').length, 0);
  const logged = fake.table('gftvonelink_audit_logs').find((r) => r.action === 'mod.report_deleted');
  assert.deepEqual(logged.details, { reportId, slug: 'augy', reason: 'spam', status: 'open', details: 'Mistaken report' });
  assert.equal((await admin.call(adminReports, { method: 'POST', body: { action: 'delete', id: reportId } })).json.error, 'report_not_found');
});

test('a bio holds up to 512 characters', async () => {
  const owner = browser();
  await makePage(owner);
  const long = 'fox '.repeat(200);
  const saved = (await owner.call(mePage, { method: 'PATCH', body: { bio: long } })).json.page.bio;
  assert.equal([...saved].length, 512, 'cut at 512');
  assert.equal(long.startsWith(saved), true);
});

test('addresses written into a bio, name or title follow the link rules', async () => {
  const owner = browser();
  await makePage(owner);
  fake.table('gftvonelink_blocked_domains').push({ domain: 'evil.example', reason: 'x', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  const bio = (text) => owner.call(mePage, { method: 'PATCH', body: { bio: text } });

  for (const text of ['DM me on evil[.]example/login', 'go to evil (dot) example', 'ｅｖｉｌ。example', 'shop.evil.example']) {
    const r = await bio(text);
    assert.equal(r.json.error, 'text_address', text);
    assert.equal(r.json.host, text.includes('shop') ? 'shop.evil.example' : 'evil.example');
  }
  assert.equal((await bio('Fox, artist. Nice to meet.you, 1.5 metres tall, v2.0 out now')).status, 200, 'text that only looks like an address is fine');
  assert.equal((await owner.call(mePage, { method: 'PATCH', body: { displayName: 'Mika bit.ly/x' } })).json.error, 'text_address');
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Real shop: evil.example', url: 'https://example.com' } })).json.error, 'text_address');
  assert.ok(fake.table('gftvonelink_pages')[0].quarantined_at, 'they count towards quarantine like links');

  // Text written before an address was listed is reported once, not edited.
  const page = fake.table('gftvonelink_pages')[0];
  page.quarantined_at = null;
  page.bio = 'old bio: later.example';
  fake.table('gftvonelink_blocked_domains').push({ domain: 'later.example', reason: 'x', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  process.env.CRON_SECRET = 'cron-secret';
  try {
    const run = () => browser().call(cleanup, { headers: { authorization: 'Bearer cron-secret' } });
    await run();
    await run();
    const reports = fake.table('gftvonelink_reports').filter((r) => r.details.includes('later.example'));
    assert.equal(reports.length, 1, 'reported once while open');
    assert.equal(page.bio, 'old bio: later.example', 'the text is left for staff to judge');
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('testimonials: admins manage them, the home page shows the visible ones', async () => {
  const { secret: adminSecret } = await makeStaff({ username: 'boss', role: 'admin' });
  const { secret: editorSecret } = await makeStaff({ username: 'ed', role: 'editor' });
  const admin = browser();
  await staffSignIn(admin, 'boss', adminSecret);
  const editor = browser();
  await staffSignIn(editor, 'ed', editorSecret);

  assert.equal((await editor.call(adminTestimonials)).status, 200, 'editors see them, to approve what owners send');
  assert.equal((await editor.call(adminTestimonials, { method: 'POST', body: { action: 'add', quote: 'x', author: 'y' } })).json.error, 'admin_only');
  const send = (body) => admin.call(adminTestimonials, { method: 'POST', body });
  assert.equal((await send({ action: 'add', quote: '', author: 'x' })).json.error, 'testimonial_required');
  assert.equal((await send({ action: 'add', quote: 'Lovely', author: 'A', pageSlug: 'not a slug!' })).json.error, 'slug_invalid');
  await send({ action: 'add', quote: 'First quote', author: 'Ann', pageSlug: 'ann' });
  let list = (await send({ action: 'add', quote: 'Second quote', author: 'Bo' })).json.testimonials;
  assert.deepEqual(list.map((x) => x.author), ['Ann', 'Bo']);
  list = (await send({ action: 'move', id: list[1].id, delta: -1 })).json.testimonials;
  assert.deepEqual(list.map((x) => x.author), ['Bo', 'Ann']);
  await send({ action: 'update', id: list[0].id, isVisible: false });

  const shown = await browser().call(publicTestimonials);
  assert.deepEqual(shown.json.testimonials, [{ id: list[1].id, quote: 'First quote', author: 'Ann', pageSlug: 'ann' }]);
  assert.match(shown.headers['cache-control'], /s-maxage=60/);
  await send({ action: 'remove', id: list[1].id });
  assert.deepEqual((await browser().call(publicTestimonials)).json.testimonials, []);
});
