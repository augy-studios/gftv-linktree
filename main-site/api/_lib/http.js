// Request and response helpers shared by every route.
//
// Errors go out as a short machine code ({ ok: false, error: "slug_taken" })
// rather than English, so the browser can look the sentence up in its own
// locale file under error.<code>.
//
// No HMAC request signing. Cross-site requests are refused by three things
// together: SameSite=Strict cookies, an Origin check on every state-changing
// method, and a JSON content type, which a plain HTML form cannot send.

import { siteOrigin } from './env.js';

const MAX_BODY_BYTES = 32 * 1024;

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

export function ok(res, data = {}) {
  send(res, 200, { ok: true, ...data });
}

export function fail(res, status, error, extra = {}) {
  send(res, status, { ok: false, error, ...extra });
}

export function failInternal(res, cause, where) {
  console.error(`[onelink] ${where}:`, cause?.message ?? cause);
  if (!res.headersSent) fail(res, 500, 'server_error');
}

// Wraps a route so anything thrown becomes a plain 500 with no detail sent.
export function route(name, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (cause) {
      failInternal(res, cause, name);
    }
  };
}

// Method, origin and content type, in one call at the top of a route.
// Returns true when the request has been answered and the route should stop.
export function guard(req, res, methods) {
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    fail(res, 405, 'method_not_allowed');
    return true;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return false;

  const origin = req.headers.origin;
  if (origin !== siteOrigin() && !isLocalDev(origin)) {
    fail(res, 403, 'bad_origin');
    return true;
  }
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    fail(res, 415, 'bad_content_type');
    return true;
  }
  return false;
}

// `vercel dev` on localhost, where SITE_URL is still the production origin.
function isLocalDev(origin) {
  if (process.env.VERCEL_ENV === 'production') return false;
  return typeof origin === 'string' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// The parsed JSON body, or null after answering 400. Vercel's Node runtime
// parses JSON bodies itself; the stream fallback covers anything that does not.
export async function readJson(req, res) {
  try {
    let body = req.body;
    if (body === undefined) body = await readStream(req);
    if (typeof body === 'string') body = body === '' ? {} : JSON.parse(body);
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    fail(res, 400, 'bad_request');
    return null;
  }
}

function readStream(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function query(req, name) {
  const value = req.query?.[name] ?? new URL(req.url, 'http://x').searchParams.get(name);
  return typeof value === 'string' ? value : '';
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '') || req.socket?.remoteAddress || 'unknown';
}

export function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

// __Host- cookies: Secure, Path=/, no Domain, so no subdomain can set or read
// them. HttpOnly keeps them out of reach of any script on the page.
export function setCookie(res, name, value, maxAgeSeconds) {
  appendCookie(
    res,
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`
  );
}

export function clearCookie(res, name) {
  appendCookie(res, `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}
