// Drive a route handler with a fake request and response, carrying cookies
// between calls like a browser on https://links.gftv.asia would.

import { randomBytes } from 'node:crypto';

process.env.TOTP_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.IP_HASH_SALT ??= 'test-salt';
process.env.SITE_URL ??= 'https://links.gftv.asia';

export const ORIGIN = 'https://links.gftv.asia';

export function browser() {
  const jar = new Map();

  async function call(handler, { method = 'GET', body, query = {}, headers = {}, ip = '203.0.113.7' } = {}) {
    const req = {
      method,
      url: `/x?${new URLSearchParams(query)}`,
      query,
      body,
      socket: { remoteAddress: ip },
      headers: {
        'x-forwarded-for': ip,
        cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
        ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
        ...headers,
      },
    };
    const out = { status: 200, headers: {}, body: '' };
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
      getHeader(k) { return out.headers[k.toLowerCase()]; },
      end(text = '') {
        this.headersSent = true;
        out.status = this.statusCode;
        out.body = String(text);
      },
    };
    await handler(req, res);
    for (const cookie of [].concat(out.headers['set-cookie'] || [])) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = decodeURIComponent(pair.slice(index + 1));
      if (/Max-Age=0/.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
    let json = null;
    try { json = JSON.parse(out.body); } catch { /* html */ }
    return { status: out.status, json, body: out.body, headers: out.headers };
  }

  return { call, jar };
}

// Every field name that must never reach a browser.
export const SECRET_FIELDS = [
  'password_hash', 'totp_secret', 'telegram_chat_id', 'code_hash', 'token_hash',
  'pending_totp_secret', 'telegram_code_hash', 'public_key', 'reporter_hash', 'ip_hash', 'email',
];

export function leaks(value) {
  const text = JSON.stringify(value);
  return SECRET_FIELDS.filter((f) => text.includes(`"${f}"`));
}
