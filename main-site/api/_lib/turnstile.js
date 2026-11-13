// Cloudflare Turnstile: the "are you a person" check on sign-up, sign-in,
// password reset and the report form. See TURNSTILE-SETUP.md.
//
// The page draws the widget with the site key (api/public/turnstile.js hands
// it over) and sends the token it gets as "cf-turnstile-response"; this
// checks the token with Cloudflare using TURNSTILE_SECRET. A token works once
// and lasts 300 seconds, so the page resets the widget after every try.
//
// A token passes only when Cloudflare says success, it was made for this
// form's action, and on a hostname in TURNSTILE_HOSTNAMES (by default the
// hostname of SITE_URL). Anything else is refused, including Cloudflare
// being out of reach or refusing our secret: the browser cannot get a token
// without Cloudflare either, so letting requests through then would only help
// scripts.
//
// Without TURNSTILE_SECRET:
//   - in production (VERCEL_ENV=production) every protected request is
//     refused with human_check_unavailable, so a missing secret is noticed
//     at once rather than leaving the forms open;
//   - anywhere else (local runs, Vercel previews) the check is skipped, said
//     once in the logs, and the page shows no widget.
// TURNSTILE_SECRET=off switches it off everywhere, production included: the
// way out if Cloudflare is down for long.
//
// Tokens and IP addresses are never logged.

import { optionalEnv, siteUrl } from './env.js';
import { fail, clientIp } from './http.js';

// The widget made for OneLink in Cloudflare. Site keys are public by design;
// TURNSTILE_SITE_KEY overrides it (Cloudflare's test key, say).
export const SITE_KEY = '0x4AAAAAAFlkl5LtUMQYO1DZ';

const ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TIMEOUT_MS = 10000;
// Cloudflare's limit on a token's length.
const MAX_TOKEN = 2048;
// Never accepted in production, whatever TURNSTILE_HOSTNAMES says.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

let warned = false;

const isProduction = () => process.env.VERCEL_ENV === 'production';

// TURNSTILE_SECRET_KEY is the name the first setup guide used; still read.
function secret() {
  const value = optionalEnv('TURNSTILE_SECRET');
  if (value) {
    return value;
  }
  return optionalEnv('TURNSTILE_SECRET_KEY');
}

const switchedOff = () => secret().toLowerCase() === 'off';

// Whether protected forms need a token here.
export function turnstileOn() {
  if (switchedOff()) {
    return false;
  }
  if (secret()) {
    return true;
  }
  return isProduction();
}

// The site key for the page, or null when the check is off and the page
// should show no widget.
export function turnstileSiteKey() {
  if (turnstileOn()) {
    return optionalEnv('TURNSTILE_SITE_KEY', SITE_KEY);
  }
  return null;
}

// The hostnames a token may come from: TURNSTILE_HOSTNAMES, comma-separated,
// or SITE_URL's hostname. Local ones are dropped in production.
export function allowedHostnames() {
  const listed = optionalEnv('TURNSTILE_HOSTNAMES')
    .split(',')
    .map((hostname) => hostname.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  let hosts;
  if (listed.length) {
    hosts = listed;
  } else {
    hosts = [new URL(siteUrl()).hostname.toLowerCase()];
  }
  if (!isProduction()) {
    return hosts;
  }
  return hosts.filter((host) => {
    if (LOCAL_HOSTS.has(host)) {
      return false;
    }
    return !host.endsWith('.localhost');
  });
}

// Checks a token for action. Returns { ok: true } or { ok: false, status,
// error, reason }, where error is what the page is told and reason is for
// the logs and tests only. The checks, in order: a secret is set (or the
// check is skipped), the token is there, Cloudflare answers, our setup is
// fine, Cloudflare says success, the action matches, the hostname is allowed.
export async function verifyTurnstile(request, token, action) {
  const key = secret();
  if (!key && isProduction()) {
    return { ok: false, status: 503, error: 'human_check_unavailable', reason: 'no-secret' };
  }
  if (!key || switchedOff()) {
    if (!warned) {
      let warning;
      if (key) {
        warning = '[onelink] TURNSTILE_SECRET is "off": the Turnstile check is skipped';
      } else {
        warning = '[onelink] TURNSTILE_SECRET is not set: the Turnstile check is skipped (not production)';
      }
      console.warn(warning);
    }
    warned = true;
    return { ok: true, skipped: true };
  }
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN) {
    return { ok: false, status: 403, error: 'human_check_failed', reason: 'missing-token' };
  }
  let data;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({ secret: key, response: token, remoteip: clientIp(request) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    data = await response.json();
  } catch (cause) {
    let detail = cause;
    if (cause !== null && cause !== undefined) {
      if (cause.name === 'TimeoutError') {
        detail = 'timed out';
      } else if (cause.message !== null && cause.message !== undefined) {
        detail = cause.message;
      }
    }
    console.warn('[onelink] turnstile siteverify:', detail);
    return { ok: false, status: 503, error: 'human_check_unavailable', reason: 'unreachable' };
  }
  let codes = [];
  if (data !== null && data !== undefined && Array.isArray(data['error-codes'])) {
    codes = data['error-codes'];
  }
  // Our own setup is wrong (a bad secret, say), or Cloudflare's is.
  if (codes.includes('missing-input-secret') || codes.includes('invalid-input-secret') || codes.includes('internal-error')) {
    console.error('[onelink] turnstile:', codes.join(', '));
    return { ok: false, status: 503, error: 'human_check_unavailable', reason: 'setup' };
  }
  if (data === null || data === undefined || data.success !== true) {
    return { ok: false, status: 403, error: 'human_check_failed', reason: 'rejected' };
  }
  // A token made for another form does not count.
  if (data.action !== action) {
    let sentAction = '';
    if (data.action !== null && data.action !== undefined) {
      sentAction = data.action;
    }
    console.warn(`[onelink] turnstile: token for action "${String(sentAction).slice(0, 32)}" sent to "${action}"`);
    return { ok: false, status: 403, error: 'human_check_failed', reason: 'action' };
  }
  let sentHostname = '';
  if (data.hostname !== null && data.hostname !== undefined) {
    sentHostname = data.hostname;
  }
  const hostname = String(sentHostname).toLowerCase();
  if (!allowedHostnames().includes(hostname)) {
    console.warn(`[onelink] turnstile: hostname "${hostname.slice(0, 253)}" is not in TURNSTILE_HOSTNAMES`);
    return { ok: false, status: 403, error: 'human_check_failed', reason: 'hostname' };
  }
  return { ok: true };
}

// The token in a request body: "cf-turnstile-response", or "turnstile" from a
// page cached before the rename.
export function turnstileToken(body) {
  if (body === null || body === undefined) {
    return undefined;
  }
  const token = body['cf-turnstile-response'];
  if (token !== null && token !== undefined) {
    return token;
  }
  return body.turnstile;
}

// Answers the request and returns true when it needed a passed check for
// action ("register", "login", "recover" or "report", as the widget was
// given) and has none.
export async function refusedForTurnstile(request, response, body, action) {
  const result = await verifyTurnstile(request, turnstileToken(body), action);
  if (result.ok) {
    return false;
  }
  fail(response, result.status, result.error);
  return true;
}
