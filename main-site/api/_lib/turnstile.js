// Cloudflare Turnstile: the "are you a person" check on sign-up and reports.
//
// The page shows the widget with TURNSTILE_SITE_KEY (api/public/turnstile.js
// hands it over) and sends the token it gets; this checks the token with
// Cloudflare using TURNSTILE_SECRET_KEY. A token works once and lasts 300
// seconds, so the page resets the widget after every try.
//
// Until both keys are set nothing is checked (said once in the logs), so the
// site works before they are added, and a secret without a site key (which
// leaves the page no way to get a token) does not turn everybody away. With
// both set, a missing or refused token is refused. If Cloudflare cannot be
// reached, or answers with an error of its own, the request goes through and
// it is logged, like the Safe Browsing check: the rate limits and bans still
// apply.

import { optionalEnv } from './env.js';
import { fail, clientIp } from './http.js';

const ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;
// Cloudflare's limit on a token's length.
const MAX_TOKEN = 2048;

let warned = false;

export function turnstileSiteKey() {
  return optionalEnv('TURNSTILE_SITE_KEY') || null;
}

// Answers 400 and returns true when the request needed a passed check for
// action ("register" or "report", as the widget was given) and has none.
export async function refusedForTurnstile(req, res, token, action) {
  const secret = optionalEnv('TURNSTILE_SECRET_KEY');
  if (!secret || !turnstileSiteKey()) {
    if (!warned) console.warn('[onelink] TURNSTILE_SECRET_KEY or TURNSTILE_SITE_KEY is not set: the Turnstile check is skipped');
    warned = true;
    return false;
  }
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN) {
    fail(res, 400, 'human_check_failed');
    return true;
  }
  let data;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ secret, response: token, remoteip: clientIp(req) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (cause) {
    console.warn('[onelink] turnstile siteverify:', cause?.message ?? cause);
    return false;
  }
  const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'] : [];
  // Our own setup is wrong (a bad secret, say): log it rather than turn
  // everybody away.
  if (codes.includes('missing-input-secret') || codes.includes('invalid-input-secret') || codes.includes('internal-error')) {
    console.error('[onelink] turnstile:', codes.join(', '));
    return false;
  }
  // A token made for the other form does not count.
  if (data?.success === true && (!data.action || data.action === action)) return false;
  fail(res, 400, 'human_check_failed');
  return true;
}
