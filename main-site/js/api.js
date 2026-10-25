// The one way the browser talks to /api. JSON in, JSON out, cookies sent,
// and a failure always arrives as an ApiError carrying the server's code
// (or "offline"), which ui.js turns into a sentence in the reader's language.

export class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, keepalive };
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
    throw new ApiError((data && data.error) || (response.status === 503 ? 'offline' : 'generic'), response.status);
  }
  return data;
}

export const post = (path, body) => api(path, { method: 'POST', body });
