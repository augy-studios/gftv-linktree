// api/_lib/turnstile.js on its own, with Cloudflare's siteverify faked.
import './harness.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTurnstile, turnstileSiteKey, turnstileToken, allowedHostnames, SITE_KEY, TIMEOUT_MS } from '../api/_lib/turnstile.js';

const req = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} };
const ENV = ['TURNSTILE_SECRET', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY', 'TURNSTILE_HOSTNAMES', 'VERCEL_ENV'];
const realFetch = globalThis.fetch;
const { warn, error } = console;
let saved;
let calls;
let logged;

// answer: what siteverify says, or a function of the call.
function cloudflare(answer) {
  globalThis.fetch = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({ url: String(url), init, body });
    return typeof answer === 'function' ? answer(init) : new Response(JSON.stringify(answer));
  };
}
const passed = (extra = {}) => ({ success: true, action: 'register', hostname: 'links.gftv.asia', 'error-codes': [], ...extra });

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.TURNSTILE_SECRET = 'test-secret';
  calls = [];
  logged = [];
  console.warn = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
  Object.assign(console, { warn, error });
});

test('turnstile: a passed check for the right action and hostname is accepted', async () => {
  cloudflare(passed());
  assert.deepEqual(await verifyTurnstile(req, 'tok', 'register'), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'sent with a timeout');
  assert.deepEqual(calls[0].body, { secret: 'test-secret', response: 'tok', remoteip: '203.0.113.9' });
  assert.equal(TIMEOUT_MS, 10000);
});

test('turnstile: a token for another action is refused', async () => {
  cloudflare(passed({ action: 'report' }));
  assert.deepEqual(await verifyTurnstile(req, 'tok', 'register'), { ok: false, status: 403, error: 'human_check_failed', reason: 'action' });
  cloudflare(passed({ action: undefined }));
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).reason, 'action', 'no action is not a match either');
});

test('turnstile: a token from a hostname not on the list is refused', async () => {
  cloudflare(passed({ hostname: 'evil.example' }));
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).reason, 'hostname');
  cloudflare(passed({ hostname: undefined }));
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).reason, 'hostname');

  process.env.TURNSTILE_HOSTNAMES = ' links.gftv.asia , Preview.Example.app ';
  cloudflare(passed({ hostname: 'preview.example.app' }));
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).ok, true, 'listed hostnames, any case and spacing');
});

test('turnstile: the hostname list defaults to SITE_URL, and production drops local ones', () => {
  assert.deepEqual(allowedHostnames(), ['links.gftv.asia']);
  process.env.TURNSTILE_HOSTNAMES = 'links.gftv.asia,localhost,127.0.0.1,app.localhost';
  assert.deepEqual(allowedHostnames(), ['links.gftv.asia', 'localhost', '127.0.0.1', 'app.localhost']);
  process.env.VERCEL_ENV = 'production';
  assert.deepEqual(allowedHostnames(), ['links.gftv.asia']);
});

test('turnstile: a refused check fails, and so does our secret being refused', async () => {
  cloudflare({ success: false, 'error-codes': ['invalid-input-response'] });
  assert.deepEqual(await verifyTurnstile(req, 'tok', 'register'), { ok: false, status: 403, error: 'human_check_failed', reason: 'rejected' });
  cloudflare({ success: false, 'error-codes': ['timeout-or-duplicate'] });
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).reason, 'rejected', 'a token used twice');
  cloudflare({ success: false, 'error-codes': ['invalid-input-secret'] });
  assert.deepEqual(await verifyTurnstile(req, 'tok', 'register'), { ok: false, status: 503, error: 'human_check_unavailable', reason: 'setup' });
  cloudflare(() => new Response('oops', { status: 500 }));
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).error, 'human_check_unavailable');
  cloudflare(() => new Response('not json'));
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).error, 'human_check_unavailable');
});

test('turnstile: Cloudflare timing out or out of reach fails closed', async () => {
  cloudflare(() => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
  assert.deepEqual(await verifyTurnstile(req, 'tok', 'register'), { ok: false, status: 503, error: 'human_check_unavailable', reason: 'unreachable' });
  assert.match(logged.at(-1), /timed out/);
  cloudflare(() => { throw new TypeError('fetch failed'); });
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).reason, 'unreachable');
});

test('turnstile: a missing, empty, non-string or overlong token is refused without asking Cloudflare', async () => {
  cloudflare(passed());
  for (const token of [undefined, null, '', 42, {}, 'x'.repeat(2049)]) {
    assert.deepEqual(await verifyTurnstile(req, token, 'register'), { ok: false, status: 403, error: 'human_check_failed', reason: 'missing-token' });
  }
  assert.equal(calls.length, 0);
  assert.equal((await verifyTurnstile(req, 'x'.repeat(2048), 'register')).ok, true, '2048 is the limit, not over it');
});

test('turnstile: without a secret, skipped outside production and refused in it', async () => {
  delete process.env.TURNSTILE_SECRET;
  cloudflare(passed());
  assert.equal(turnstileSiteKey(), null, 'no widget when nothing is checked');
  assert.deepEqual(await verifyTurnstile(req, undefined, 'register'), { ok: true, skipped: true });
  process.env.VERCEL_ENV = 'preview';
  assert.equal((await verifyTurnstile(req, undefined, 'register')).ok, true);
  process.env.VERCEL_ENV = 'production';
  assert.equal(turnstileSiteKey(), SITE_KEY, 'the widget shows, so the page can say why');
  assert.deepEqual(await verifyTurnstile(req, 'tok', 'register'), { ok: false, status: 503, error: 'human_check_unavailable', reason: 'no-secret' });
  assert.equal(calls.length, 0);

  // "off" switches it off, production included.
  process.env.TURNSTILE_SECRET = 'off';
  assert.equal(turnstileSiteKey(), null);
  assert.deepEqual(await verifyTurnstile(req, undefined, 'register'), { ok: true, skipped: true });
  assert.equal(calls.length, 0);
  delete process.env.TURNSTILE_SECRET;

  // The first setup guide's name still works.
  process.env.TURNSTILE_SECRET_KEY = 'older-name';
  assert.equal((await verifyTurnstile(req, 'tok', 'register')).ok, true);
  assert.equal(calls[0].body.secret, 'older-name');
});

test('turnstile: the site key, and the token under either field name', () => {
  assert.equal(SITE_KEY, '0x4AAAAAAFlkl5LtUMQYO1DZ');
  assert.equal(turnstileSiteKey(), SITE_KEY);
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  assert.equal(turnstileSiteKey(), '1x00000000000000000000AA');
  assert.equal(turnstileToken({ 'cf-turnstile-response': 'a', turnstile: 'b' }), 'a');
  assert.equal(turnstileToken({ turnstile: 'b' }), 'b');
  assert.equal(turnstileToken(null), undefined);
});

test('turnstile: neither the token nor the address reaches the logs', async () => {
  const token = 'secret-token-value';
  for (const answer of [passed({ action: 'report' }), passed({ hostname: 'evil.example' }), { success: false, 'error-codes': ['invalid-input-secret'] }]) {
    cloudflare(answer);
    await verifyTurnstile(req, token, 'register');
  }
  cloudflare(() => { throw new Error('down'); });
  await verifyTurnstile(req, token, 'register');
  assert.ok(logged.length >= 3);
  for (const line of logged) {
    assert.equal(line.includes(token), false, line);
    assert.equal(line.includes('203.0.113.9'), false, line);
    assert.equal(line.includes('test-secret'), false, line);
  }
});
