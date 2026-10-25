// The one way the browser talks to /api. JSON in, JSON out, cookies sent,
// and a failure always arrives as an ApiError carrying the server's code
// (or "offline"), which ui.js turns into a sentence in the reader's language.

// detail: the rest of the server's answer, for messages that name something
// ({ host } for an address the lists refused).
export class ApiError extends Error {
  constructor(code, status, detail = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// The device fingerprint, on the pages that work one out (visitor.js). A
// request waits for it at most VISITOR_WAIT_MS, then goes without it.
const VISITOR_WAIT_MS = 1500;
let visitorId = null;

export function useVisitorId(promise) {
  visitorId = promise;
}

function visitorHeader() {
  if (!visitorId) return null;
  const late = new Promise((resolve) => { setTimeout(() => resolve(null), VISITOR_WAIT_MS); });
  return Promise.race([visitorId, late]).catch(() => null);
}

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, keepalive };
  const visitor = await visitorHeader();
  if (typeof visitor === 'string' && visitor) init.headers['X-OLG-Visitor'] = visitor;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('offline', 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* not JSON: handled below */
  }
  if (!response.ok || !data || data.ok === false) {
    throw new ApiError((data && data.error) || (response.status === 503 ? 'offline' : 'generic'), response.status, data || {});
  }
  return data;
}

export const post = (path, body) => api(path, { method: 'POST', body });
