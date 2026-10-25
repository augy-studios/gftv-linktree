// GET /<slug>, rewritten here by vercel.json.
//
// Serves shell/profile.html with the page's own title and description in the
// head, so a link shared in a chat previews as the person rather than as the
// site, and with the page data inlined, so the browser draws the links
// without a second request. The browser script takes it from there.

import { readFileSync } from 'node:fs';
import { route, query } from './_lib/http.js';
import { loadPublicPage } from './_lib/public-page.js';
import { siteUrl } from './_lib/env.js';

const SHELL = readFileSync(new URL('../shell/profile.html', import.meta.url), 'utf8');
const NOT_FOUND = readFileSync(new URL('../404.html', import.meta.url), 'utf8');
const META_BLOCK = /<!--OLG:META-->[\s\S]*?<!--\/OLG:META-->/;
const DATA_BLOCK = /<script type="application\/json" id="pageData">[\s\S]*?<\/script>/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON that is safe inside a <script> element: nothing in it can close the
// element or open a comment, whatever an owner typed into their bio.
// U+2028 and U+2029 end a line inside a script in older engines.
const LS = String.fromCharCode(0x2028);
const LINE_SEPARATORS = new RegExp(`[${LS}${String.fromCharCode(0x2029)}]`, 'g');

export function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATORS, (c) => (c === LS ? '\\u2028' : '\\u2029'));
}

function metaFor(page) {
  const url = `${siteUrl()}/${page.slug}`;
  const title = `${page.displayName} | OneLink GFTV`;
  const description = page.bio ? page.bio.replace(/\s+/g, ' ').slice(0, 200) : `Links from ${page.displayName}, on OneLink GFTV.`;
  const image = `${siteUrl()}/OLG-main.png`;
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:site_name" content="OneLink GFTV">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
  ].join('\n    ');
}

export default route('render', async (req, res) => {
  // Slugs are lowercase; /Augy goes to /augy rather than to a 404.
  const asked = query(req, 'slug');
  if (asked !== asked.toLowerCase() && /^[A-Za-z0-9-]{2,32}$/.test(asked)) {
    res.statusCode = 308;
    res.setHeader('Location', `/${asked.toLowerCase()}`);
    return res.end();
  }

  const result = await loadPublicPage(asked);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (result.state === 'missing') {
    res.statusCode = 404;
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10');
    return res.end(NOT_FOUND);
  }

  const data = result.state === 'active' ? { state: 'active', page: result.page } : { state: 'banned', slug: result.slug };
  let html = SHELL.replace(DATA_BLOCK, `<script type="application/json" id="pageData">${inlineJson(data)}</script>`);
  if (result.state === 'active') {
    html = html.replace(META_BLOCK, metaFor(result.page));
  } else {
    html = html.replace('<meta name="robots" content="index">', '<meta name="robots" content="noindex">');
  }

  res.statusCode = result.state === 'active' ? 200 : 410;
  // A few seconds at the edge, so a busy page is not a query per visit, while
  // an edit or a ban still shows within seconds.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30');
  res.end(html);
});
