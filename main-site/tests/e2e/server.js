// A local stand-in for Vercel for the browser tests: the real API handlers on
// the in-memory database from tests/fake-db.js, the static files, and
// /<slug> through api/render.js, with the production Content-Security-Policy
// from vercel.json. Seeds an admin, an editor and two live pages, and hands
// back their session cookies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { browser } from '../harness.js';
import { useTestClient } from '../../api/_lib/supabase.js';
import { createFakeDb } from '../fake-db.js';
import { totpAt, generateTotpSecret } from '../../api/_lib/totp.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.html': 'text/html', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };

const routes = {};
async function handler(name) {
  routes[name] ??= (await import(new URL(`../../api/${name}.js`, import.meta.url))).default;
  return routes[name];
}

export async function startServer({ port = 0 } = {}) {
  const fake = createFakeDb();
  useTestClient(fake);

  const secrets = {};
  for (const [username, role] of [['boss', 'admin'], ['ed', 'editor']]) {
    secrets[username] = generateTotpSecret();
    fake.table('gftvhello_users').push({ id: crypto.randomUUID(), username, display_name: username.toUpperCase(), email: `${username}@gftv.asia`, password_hash: await bcrypt.hash('staff password 1', 10), is_admin: role === 'admin', is_editor: role === 'editor', is_approved: true, totp_secret: secrets[username] });
  }
  const cookies = {};
  for (const name of ['augy', 'rando']) {
    const b = browser();
    const reg = await b.call(await handler('auth/register'), { method: 'POST', body: { slug: name, password: 'correct horse battery' } });
    const start = await b.call(await handler('auth/enrol'), { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-start' } });
    await b.call(await handler('auth/enrol'), { method: 'POST', body: { challenge: reg.json.challenge, action: 'totp-finish', code: totpAt(start.json.secret) } });
    await b.call(await handler('me/links'), { method: 'POST', body: { title: 'VK', url: `https://vk.com/${name}`, icon: 'vk' } });
    if (name === 'augy') cookies.owner = [...b.jar];
  }
  for (const username of ['boss', 'ed']) {
    const b = browser();
    const step = await b.call(await handler('admin/auth'), { method: 'POST', body: { action: 'login', identifier: username, password: 'staff password 1' } });
    await b.call(await handler('admin/auth'), { method: 'POST', body: { action: 'verify', challenge: step.json.challenge, method: 'totp', code: totpAt(secrets[username]) } });
    cookies[username] = [...b.jar];
  }

  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value.replace('; upgrade-insecure-requests', '');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      res.setHeader('Content-Security-Policy', csp);
      if (p.startsWith('/api/')) {
        req.query = Object.fromEntries(url.searchParams);
        return await (await handler(p.slice(5)))(req, res);
      }
      let file = p === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.statusCode = 404; return res.end(); }
      if (fs.existsSync(`${file}.html`)) file = `${file}.html`;
      else if (/^\/[A-Za-z0-9-]{2,32}$/.test(p)) {
        req.query = { slug: p.slice(1) };
        return await (await handler('render'))(req, res);
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch (error) {
      console.error(error);
      res.statusCode = 500;
      res.end('{"ok":false}');
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return { url: `http://localhost:${server.address().port}`, cookies, fake, close: () => new Promise((r) => server.close(r)) };
}
