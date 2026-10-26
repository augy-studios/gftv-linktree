// End to end through the real route handlers, against tests/fake-db.js.
import { browser, leaks, ORIGIN } from './harness.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import publicTurnstile from '../api/public/turnstile.js';
import meLinkCap from '../api/me/link-cap.js';
import adminLinkCaps from '../api/admin/link-caps.js';

let fake;
beforeEach(() => {
  fake = createFakeDb();
  useTestClient(fake);
  forgetBlockedDomains();
  forgetBlockedPatterns();
  forgetReviewPatterns();
});

// A page set up the way a person would: register, authenticator, codes.
// from: { ip, headers } for the requests, when a test needs them.
async function makePage(b, name = 'augy', password = 'correct horse battery', from = {}) {
  const reg = await b.call(register, { method: 'POST', body: { slug: name, password }, ...from });
  assert.equal(reg.status, 200, reg.body);
  const start = await b.call(enrol, { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-start' }, ...from });
  assert.equal(start.status, 200, start.body);
  assert.match(start.json.uri, /^otpauth:\/\/totp\//);
  const done = await b.call(enrol, { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-finish', code: totpAt(start.json.secret) }, ...from });
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

// ---------------------------------------------------------------------------
// Device fingerprints (migration 012)
// ---------------------------------------------------------------------------

const DEVICE = '0123456789abcdef0123456789abcdef';
const fromDevice = (ip, visitor = DEVICE) => ({ ip, headers: { 'x-olg-visitor': visitor } });
const saltedHash = (value) => createHash('sha256').update(`test-salt:${value}`).digest('hex');

// Two pages quarantined from one connection and device, which bans both.
// Returns each page's authenticator secret, by name.
async function banConnectionAndDevice(from) {
  const secrets = {};
  fake.table('gftvonelink_blocked_domains').push({ domain: 'evil.example', reason: 'x', created_at: new Date().toISOString() });
  forgetBlockedDomains();
  for (const name of ['first', 'second']) {
    fake.table('gftvonelink_rate_limits').filter((r) => r.bucket.startsWith('badlink:ip:')).forEach((r) => { r.hits = 0; });
    const b = browser();
    secrets[name] = (await makePage(b, name, undefined, from)).secret;
    for (const n of [1, 2, 3]) await b.call(meLinks, { method: 'POST', body: { title: 'x', url: `https://evil.example/${n}` }, ...from });
  }
  assert.equal(fake.table('gftvonelink_ip_bans').length, 1);
  return secrets;
}

test('a device id is kept only as a salted hash, and never sent back', async () => {
  const owner = browser();
  await makePage(owner, 'augy', undefined, fromDevice('203.0.113.7'));
  const row = fake.table('gftvonelink_audit_logs').find((r) => r.action === 'page.register');
  assert.equal(row.visitor_hash, saltedHash(DEVICE));
  assert.equal(JSON.stringify(fake.tables).includes(DEVICE), false, 'the id itself is stored nowhere');

  // Untrusted input: anything not shaped like a FingerprintJS id is ignored.
  await browser().call(register, { method: 'POST', body: { slug: 'other', password: 'correct horse battery' }, headers: { 'x-olg-visitor': 'x'.repeat(32) } });
  assert.equal(fake.table('gftvonelink_audit_logs').find((r) => r.details.slug === 'other').visitor_hash, null);

  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  assert.deepEqual(leaks((await admin.call(adminAudit)).json), []);
  assert.deepEqual(leaks((await admin.call(adminBlocklist)).json), []);
  assert.deepEqual(leaks((await owner.call(mePage, fromDevice('203.0.113.7'))).json), []);

  // The daily cleanup clears device hashes from entries older than 30 days.
  process.env.CRON_SECRET = 'cron-secret';
  try {
    row.created_at = new Date(Date.now() - 31 * 86400_000).toISOString();
    const ran = await browser().call(cleanup, { headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(ran.json.removed.visitorHashes, 1);
    assert.equal(row.visitor_hash, null);
    assert.ok(fake.table('gftvonelink_audit_logs').some((r) => r.visitor_hash), 'newer entries keep theirs');
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('a banned device on a new connection is flagged: no new page, but sign-in and editing still work', async () => {
  const secrets = await banConnectionAndDevice(fromDevice('203.0.113.66'));
  const bans = fake.table('gftvonelink_visitor_bans');
  assert.equal(bans.length, 1, 'the device seen on the connection is banned with it');
  assert.equal(bans[0].visitor_hash, saltedHash(DEVICE));
  assert.equal(bans[0].ip_hash, fake.table('gftvonelink_ip_bans')[0].ip_hash);

  const elsewhere = fromDevice('198.51.100.20');
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ...elsewhere })).json.error, 'visitor_banned');
  assert.equal(fake.table('gftvonelink_ip_bans').length, 1, 'never banned automatically');
  assert.ok(fake.table('gftvonelink_audit_logs').some((r) => r.action === 'security.visitor_flagged'));
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ip: '198.51.100.21' })).status, 200, 'other devices are not affected');

  // The owner of an existing page signs in and edits from the new connection.
  const owner = browser();
  const step = await owner.call(login, { method: 'POST', body: { slug: 'second', password: 'correct horse battery' }, ...elsewhere });
  assert.equal(step.status, 200);
  const signedIn = await owner.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'totp', code: totpAt(secrets.second) }, ...elsewhere });
  assert.equal(signedIn.status, 200, signedIn.body);
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'ok', url: 'https://fine.example' }, ...elsewhere })).status, 200);
  assert.equal((await owner.call(mePage, { method: 'PATCH', body: { bio: 'hi' }, ...elsewhere })).status, 200);

  // Staff see it by the start of the device and connection hashes.
  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  const data = (await admin.call(adminBlocklist)).json;
  assert.deepEqual(leaks(data), []);
  assert.equal(data.flaggedVisitors.length, 1);
  const [flagged] = data.flaggedVisitors;
  assert.match(flagged.id, /^[0-9a-f]{32}$/);
  assert.equal(flagged.device, saltedHash(DEVICE).slice(0, 16));
  assert.ok(flagged.requests >= 3);
  assert.equal(data.banned[0].devices, 1);

  // Unflag: it is someone else. The device's ban goes; the connection's stays.
  const lifted = await admin.call(adminBlocklist, { method: 'POST', body: { action: 'unflag-visitor', id: flagged.id } });
  assert.deepEqual(lifted.json.flaggedVisitors, []);
  assert.equal(fake.table('gftvonelink_visitor_bans').length, 0);
  assert.equal(fake.table('gftvonelink_ip_bans').length, 1);
  assert.ok(fake.table('gftvonelink_audit_logs').some((r) => r.action === 'mod.visitor_unflagged'));
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'fourth', password: 'correct horse battery' }, ...elsewhere })).status, 200);
  assert.equal((await admin.call(adminBlocklist, { method: 'POST', body: { action: 'unflag-visitor', id: flagged.id } })).json.error, 'not_flagged_visitor');
});

test('staff can ban a flagged device\'s connection, and unbanning a connection lifts its devices', async () => {
  await banConnectionAndDevice(fromDevice('203.0.113.66'));
  const elsewhere = fromDevice('198.51.100.30');
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ...elsewhere })).json.error, 'visitor_banned');

  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  const [flagged] = (await admin.call(adminBlocklist)).json.flaggedVisitors;
  const banned = await admin.call(adminBlocklist, { method: 'POST', body: { action: 'ban-visitor', id: flagged.id, reason: 'same person' } });
  assert.deepEqual(banned.json.flaggedVisitors, []);
  assert.equal(banned.json.banned.length, 2);
  const second = banned.json.banned.find((b) => b.id === flagged.connection);
  assert.equal(second.byStaff, true);
  assert.equal(second.devices, 1);
  assert.equal(fake.table('gftvonelink_visitor_bans').length, 2, 'one row per device and connection');
  assert.ok(fake.table('gftvonelink_audit_logs').some((r) => r.action === 'mod.visitor_banned'));
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ...elsewhere })).json.error, 'ip_banned');

  // Lifting one connection's ban leaves the device banned through the other.
  await admin.call(adminBlocklist, { method: 'POST', body: { action: 'unban-connection', id: flagged.connection } });
  assert.equal(fake.table('gftvonelink_visitor_bans').length, 1);
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ...fromDevice('198.51.100.31') })).json.error, 'visitor_banned');
  const first = (await admin.call(adminBlocklist)).json.banned[0];
  await admin.call(adminBlocklist, { method: 'POST', body: { action: 'unban-connection', id: first.id } });
  assert.equal(fake.table('gftvonelink_visitor_bans').length, 0);
  assert.equal((await browser().call(register, { method: 'POST', body: { slug: 'third', password: 'correct horse battery' }, ...fromDevice('198.51.100.32') })).status, 200);
});

// ---------------------------------------------------------------------------
// Cloudflare Turnstile, and where the fingerprint library loads
// ---------------------------------------------------------------------------

test('Turnstile: skipped until both keys are set, then sign-up and reports need a passed check', async () => {
  const owner = browser();
  await makePage(owner);
  let n = 0;
  const signUp = (turnstile) => browser().call(register, { method: 'POST', body: { slug: `t${(n += 1)}x`, password: 'correct horse battery', turnstile }, ip: `198.51.100.${100 + n}` });
  const sendReport = (turnstile) => browser().call(report, { method: 'POST', body: { slug: 'augy', reason: 'spam', turnstile }, ip: `198.51.100.${200 + (n += 1)}` });

  assert.equal((await browser().call(publicTurnstile)).json.siteKey, null);
  assert.equal((await signUp()).status, 200, 'no keys: nothing checked');
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  assert.equal((await signUp()).status, 200, 'a secret without a site key is not enforced');

  const calls = [];
  const realFetch = globalThis.fetch;
  process.env.TURNSTILE_SITE_KEY = 'test-site-key';
  // Cloudflare's answer, by token: good-<action> passes for that action.
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (body.response === 'unreachable') throw new Error('network down');
    const [verdict, action] = body.response.split('-');
    return new Response(JSON.stringify(verdict === 'good' ? { success: true, action } : { success: false, 'error-codes': ['invalid-input-response'] }));
  };
  try {
    assert.equal((await browser().call(publicTurnstile)).json.siteKey, 'test-site-key');

    assert.equal((await signUp()).json.error, 'human_check_failed', 'no token');
    assert.equal(calls.length, 0, 'a missing token is refused without asking Cloudflare');
    assert.equal((await signUp('bad-register')).json.error, 'human_check_failed');
    assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(calls[0].body.secret, 'test-secret');
    assert.match(calls[0].body.remoteip, /^198\.51\.100\./);
    assert.equal((await signUp('good-report')).json.error, 'human_check_failed', 'a token from the report form does not count');
    assert.equal((await signUp('good-register')).status, 200);

    assert.equal((await sendReport()).json.error, 'human_check_failed');
    assert.equal((await sendReport('bad-report')).json.error, 'human_check_failed');
    assert.equal((await sendReport('good-report')).status, 200);

    // Cloudflare out of reach: let it through, as the other outside checks do.
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await signUp('unreachable')).status, 200);
    } finally {
      console.warn = warn;
    }
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  }
});

test('the fingerprint library loads on sign-up, sign-in, reset and the editor, and nowhere else', async () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const vendor = '/js/vendor/fingerprintjs.js';
  for (const page of ['register', 'login', 'reset', 'edit']) {
    assert.ok(read(`${page}.html`).includes(vendor), page);
    assert.match(read(`js/pages/${page}.js`), /^import '\.\.\/visitor\.js';$/m, page);
  }
  for (const page of ['index.html', '404.html', 'shell/profile.html', 'admin.html', 'privacy.html']) {
    assert.equal(read(page).includes('fingerprintjs'), false, page);
  }
  for (const script of ['home', 'profile', 'notfound', 'admin', 'privacy']) {
    assert.equal(read(`js/pages/${script}.js`).includes('visitor.js'), false, script);
  }
  // Nothing the public pages import pulls it in either.
  for (const shared of ['app.js', 'api.js', 'ui.js', 'turnstile.js']) {
    assert.equal(/import [^;]*visitor\.js/.test(read(`js/${shared}`)), false, shared);
  }

  // The page a visitor actually gets.
  const owner = browser();
  await makePage(owner);
  const html = await browser().call(render, { query: { slug: 'augy' } });
  assert.equal(html.status, 200);
  assert.equal(html.body.includes('fingerprintjs'), false);
  assert.equal(html.body.includes('challenges.cloudflare.com'), false, 'Turnstile waits for the report form');
});

// Links put straight into the table, standing in for ones added earlier.
function seedLinks(pageId, n) {
  for (let i = 0; i < n; i += 1) {
    fake.table('gftvonelink_links').push({ id: crypto.randomUUID(), page_id: pageId, title: `Seed ${i}`, url: `https://example.com/${i}`, icon: 'link', order_index: i, click_count: 0, is_active: true, removed_at: null, created_at: new Date().toISOString() });
  }
}

test('link limits: 20 by default, admins change it, and lowering one keeps the links', async () => {
  const owner = browser();
  await makePage(owner);
  const pageId = fake.table('gftvonelink_pages')[0].id;
  const add = (title = 'New') => owner.call(meLinks, { method: 'POST', body: { title, url: 'https://example.org/new' } });

  seedLinks(pageId, 19);
  assert.deepEqual((await owner.call(mePage)).json.page.linkCap, { used: 19, limit: 20, custom: false });
  const twentieth = await add();
  assert.equal(twentieth.status, 200);
  assert.deepEqual(twentieth.json.linkCap, { used: 20, limit: 20, custom: false });
  const full = await add();
  assert.equal(full.json.error, 'too_many_links');
  assert.equal(full.json.limit, 20);

  // A link staff removed does not take up a place, since its owner cannot delete it.
  fake.table('gftvonelink_links')[0].removed_at = new Date().toISOString();
  assert.equal((await add()).status, 200);
  assert.equal((await add()).json.error, 'too_many_links');

  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  const { secret: edSecret } = await makeStaff({ username: 'ed', role: 'editor' });
  const editor = browser();
  await staffSignIn(editor, 'ed', edSecret);
  // Editors see requests, but the default and per-page limits are for admins.
  const edView = (await editor.call(adminLinkCaps)).json;
  assert.equal(edView.defaultCap, 20);
  assert.equal(edView.custom, undefined, 'editors are not sent the pages with their own limit');
  assert.equal((await editor.call(adminLinkCaps, { method: 'POST', body: { action: 'set-default', cap: 99 } })).json.error, 'admin_only');
  assert.equal((await editor.call(adminLinkCaps, { method: 'POST', body: { action: 'set-page', id: pageId, cap: 99 } })).json.error, 'admin_only');

  for (const cap of [0, 201, 'abc', 2.5, null]) {
    assert.equal((await admin.call(adminLinkCaps, { method: 'POST', body: { action: 'set-default', cap } })).json.error, 'cap_invalid', String(cap));
  }
  const lowered = await admin.call(adminLinkCaps, { method: 'POST', body: { action: 'set-default', cap: 5 } });
  assert.equal(lowered.json.defaultCap, 5);
  const over = (await owner.call(mePage)).json.page;
  assert.deepEqual(over.linkCap, { used: 20, limit: 5, custom: false }, 'over the limit, nothing deleted');
  assert.equal(over.links.length, 21);
  assert.equal((await add()).json.limit, 5);
  // Editing, hiding and deleting still work while over the limit.
  const first = over.links.find((l) => !l.removed);
  assert.equal((await owner.call(meLinks, { method: 'PATCH', body: { id: first.id, title: 'Renamed' } })).status, 200);

  // A page of its own limit, then back on the default.
  const own = await admin.call(adminLinkCaps, { method: 'POST', body: { action: 'set-page', id: pageId, cap: 22 } });
  assert.deepEqual(own.json.custom.map((p) => [p.slug, p.limit, p.used]), [['augy', 22, 20]]);
  const detail = await editor.call(adminPages, { query: { id: pageId } });
  assert.deepEqual(detail.json.linkCap, { used: 20, limit: 22, custom: true, defaultCap: 5 });
  assert.equal((await add('A')).status, 200);
  assert.equal((await add('B')).status, 200);
  assert.equal((await add('C')).json.error, 'too_many_links');
  await admin.call(adminLinkCaps, { method: 'POST', body: { action: 'set-page', id: pageId, cap: null } });
  assert.deepEqual((await owner.call(mePage)).json.page.linkCap, { used: 22, limit: 5, custom: false });

  // Two adds at once with one place left: the database lets one through.
  await admin.call(adminLinkCaps, { method: 'POST', body: { action: 'set-page', id: pageId, cap: 23 } });
  const both = await Promise.all([add('X'), add('Y')]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
  assert.equal(fake.table('gftvonelink_links').filter((l) => l.page_id === pageId && !l.removed_at).length, 23);

  const log = (await admin.call(adminAudit, { query: { action: 'mod.' } })).json.entries.map((e) => e.action);
  for (const a of ['mod.link_cap_default', 'mod.link_cap_page']) assert.ok(log.includes(a), a);
});

test('owners ask for a higher link limit, and staff approve or decline', async () => {
  const owner = browser();
  const { password } = await makePage(owner);
  const pageId = fake.table('gftvonelink_pages')[0].id;
  seedLinks(pageId, 20);
  const ask = (body) => owner.call(meLinkCap, { method: 'POST', body });

  assert.equal((await ask({ requested: 20, reason: 'More please' })).json.error, 'cap_not_higher');
  assert.equal((await ask({ requested: 500, reason: 'More please' })).json.error, 'cap_invalid');
  assert.equal((await ask({ requested: 30, reason: '   ' })).json.error, 'cap_reason_required');
  const sent = await ask({ requested: '30', reason: 'I run a convention and link every panel.' });
  assert.equal(sent.status, 200, sent.body);
  assert.deepEqual(Object.keys(sent.json.request).sort(), ['granted', 'note', 'reason', 'requested', 'reviewedAt', 'sentAt', 'status']);
  assert.equal(sent.json.request.status, 'pending');
  assert.equal(sent.json.request.requested, 30);
  assert.equal((await ask({ requested: 40, reason: 'Again' })).json.error, 'cap_request_open', 'one open request at a time');
  assert.equal((await owner.call(mePage)).json.page.linkCapRequest.status, 'pending');

  const { secret } = await makeStaff({ username: 'boss', role: 'admin' });
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  const { secret: edSecret } = await makeStaff({ username: 'ed', role: 'editor' });
  const editor = browser();
  await staffSignIn(editor, 'ed', edSecret);
  assert.equal((await admin.call(adminOverview)).json.counts.linkCapRequests, 1);
  assert.equal((await editor.call(adminOverview)).json.counts.linkCapRequests, 1, 'editors answer requests too');

  const list = await editor.call(adminLinkCaps);
  assert.deepEqual(leaks(list.json), []);
  const waiting = list.json.pending[0];
  assert.equal(waiting.slug, 'augy');
  assert.equal(waiting.requested, 30);
  assert.equal(waiting.used, 20);
  assert.equal(waiting.limit, 20);
  assert.equal(waiting.reason, 'I run a convention and link every panel.');
  // An editor can give up to what was asked, and more than the page has now.
  const approve = (b, cap) => b.call(adminLinkCaps, { method: 'POST', body: { action: 'approve', id: waiting.id, cap } });
  for (const cap of [31, 20, 0]) {
    const r = await approve(editor, cap);
    assert.equal(r.json.error, 'cap_grant_range', String(cap));
    assert.deepEqual([r.json.min, r.json.max], [21, 30]);
  }

  // Approved for a different number than asked, with a note.
  const approved = await editor.call(adminLinkCaps, { method: 'POST', body: { action: 'approve', id: waiting.id, cap: 25, note: 'Start with 25.' } });
  assert.equal(approved.json.pending.length, 0);
  assert.equal(fake.table('gftvonelink_pages')[0].links_cap, 25);
  assert.equal((await admin.call(adminLinkCaps, { method: 'POST', body: { action: 'approve', id: waiting.id } })).json.error, 'cap_request_closed');
  let mine = (await owner.call(meLinkCap)).json;
  assert.deepEqual(mine.linkCap, { used: 20, limit: 25, custom: true });
  assert.equal(mine.request.status, 'approved');
  assert.equal(mine.request.granted, 25);
  assert.equal(mine.request.note, 'Start with 25.');
  assert.deepEqual(leaks(mine), []);
  assert.equal((await owner.call(meLinks, { method: 'POST', body: { title: 'Now fits', url: 'https://example.org/' } })).status, 200);

  // Asking again, declined: the limit stays where it was.
  await ask({ requested: 60, reason: 'Even more' });
  let again = (await admin.call(adminLinkCaps)).json.pending[0];
  assert.equal(again.limit, 25);
  assert.equal(again.capWhenAsked, 25);
  await editor.call(adminLinkCaps, { method: 'POST', body: { action: 'decline', id: again.id, note: 'Not for now.' } });
  mine = (await owner.call(meLinkCap)).json;
  assert.equal(mine.request.status, 'declined');
  assert.equal(mine.request.granted, null);
  assert.equal(mine.request.note, 'Not for now.');
  assert.equal(mine.linkCap.limit, 25);

  // Declined with a compromise: above the limit now, below what was asked.
  await ask({ requested: 60, reason: 'Please' });
  again = (await editor.call(adminLinkCaps)).json.pending[0];
  for (const cap of [60, 25, 'x']) {
    const r = await editor.call(adminLinkCaps, { method: 'POST', body: { action: 'decline', id: again.id, cap } });
    assert.equal(r.json.error, 'cap_grant_range', String(cap));
    assert.deepEqual([r.json.min, r.json.max], [26, 59]);
  }
  await editor.call(adminLinkCaps, { method: 'POST', body: { action: 'decline', id: again.id, cap: 40, note: 'Meet you halfway.' } });
  mine = (await owner.call(meLinkCap)).json;
  assert.equal(mine.request.status, 'declined');
  assert.equal(mine.request.granted, 40);
  assert.equal(mine.request.note, 'Meet you halfway.');
  assert.deepEqual(mine.linkCap, { used: 21, limit: 40, custom: true });

  // The owner can take an open request back.
  assert.equal((await ask({ requested: 45, reason: 'Third time' })).status, 200);
  assert.equal((await owner.call(meLinkCap, { method: 'DELETE', body: {} })).json.request, null);
  assert.equal((await admin.call(adminLinkCaps)).json.pending.length, 0);

  const log = (await admin.call(adminAudit)).json.entries.map((e) => e.action);
  for (const a of ['page.link_cap_requested', 'mod.link_cap_approved', 'mod.link_cap_declined']) assert.ok(log.includes(a), a);

  await owner.call(security, { method: 'POST', body: { action: 'delete-page', password, confirmSlug: 'augy' } });
  assert.equal(fake.table('gftvonelink_link_cap_requests').length, 0, 'deleting the page takes its requests too');
});

test('the owner hears about a review on Telegram, and a failed send does not stop it', async () => {
  const owner = browser();
  await makePage(owner);
  const page = fake.table('gftvonelink_pages')[0];
  page.telegram_chat_id = 4242;
  const ask = (requested) => owner.call(meLinkCap, { method: 'POST', body: { requested, reason: 'Shop links' } });
  const { secret } = await makeStaff({ username: 'ed', role: 'editor' });
  const editor = browser();
  await staffSignIn(editor, 'ed', secret);
  const review = async (body) => {
    const id = (await editor.call(adminLinkCaps)).json.pending[0].id;
    return editor.call(adminLinkCaps, { method: 'POST', body: { id, ...body } });
  };

  const calls = [];
  let failing = false;
  const realFetch = globalThis.fetch;
  const warn = console.warn;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'onelink_test_bot';
  console.warn = () => {};
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
    if (failing) throw new Error('network down');
    return new Response('{"ok":true}');
  };
  try {
    await ask(30);
    assert.equal((await review({ action: 'approve', note: 'Enjoy *bold* <b>' })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
    assert.equal(calls[0].body.chat_id, 4242);
    const md = calls[0].body.rich_message.markdown;
    assert.match(md, /approved/);
    assert.match(md, /links\.gftv\.asia\/augy/);
    assert.ok(md.includes(String.raw`Enjoy \*bold\* \<b\>`), 'the note is escaped');

    await ask(50);
    await review({ action: 'decline', cap: 40 });
    assert.match(calls[1].body.rich_message.markdown, /raised to 40/);

    // Telegram down: the review still goes through.
    failing = true;
    await ask(60);
    const r = await review({ action: 'decline', note: 'No' });
    assert.equal(r.status, 200);
    assert.equal(fake.table('gftvonelink_link_cap_requests').filter((x) => x.status === 'declined').length, 2);

    // No Telegram linked: nothing is sent.
    failing = false;
    page.telegram_chat_id = null;
    const before = calls.length;
    await ask(70);
    await review({ action: 'approve' });
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = warn;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_USERNAME;
  }
});
