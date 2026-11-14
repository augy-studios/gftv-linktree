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

// Text made safe for HTML, inside an element or a quoted attribute.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// U+2028 and U+2029 end a line inside a script in older engines.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const LINE_SEPARATORS = new RegExp(`[${LINE_SEPARATOR}${String.fromCharCode(0x2029)}]`, 'g');

// JSON that is safe inside a <script> element: nothing in it can close the
// element or open a comment, whatever an owner typed into their bio.
export function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATORS, (character) => {
      if (character === LINE_SEPARATOR) {
        return '\\u2028';
      }
      return '\\u2029';
    });
}

// The title, description and preview tags for a live page, which replace
// everything between the OLG:META markers in the shell.
function metaFor(page) {
  const url = `${siteUrl()}/${page.slug}`;
  const title = `${page.displayName} | OneLink GFTV`;
  let description;
  if (page.bio) {
    description = page.bio.replace(/\s+/g, ' ').slice(0, 200);
  } else {
    description = `Links from ${page.displayName}, on OneLink GFTV.`;
  }
  // The owner's picture when there is one, so a shared link previews as them.
  let image = page.avatarUrl;
  if (!image) {
    image = `${siteUrl()}/OLG-main.png`;
  }
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

// Lowercases a mixed-case name (308), follows a rename (307), answers 404 for
// no page, and otherwise serves the shell with the page data inlined: live
// pages with their preview tags, the rest with only their state.
export default route('render', async (request, response) => {
  // Slugs are lowercase; /Augy goes to /augy rather than to a 404.
  const asked = query(request, 'slug');
  if (asked !== asked.toLowerCase() && /^[A-Za-z0-9-]{2,32}$/.test(asked)) {
    response.statusCode = 308;
    response.setHeader('Location', `/${asked.toLowerCase()}`);
    return response.end();
  }

  const result = await loadPublicPage(asked);
  // A name the page was renamed away from: on to its name now, temporarily,
  // since the old name is only held for a while.
  if (result.state === 'moved') {
    response.statusCode = 307;
    response.setHeader('Location', `/${result.slug}`);
    response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10');
    return response.end();
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (result.state === 'missing') {
    response.statusCode = 404;
    response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10');
    return response.end(NOT_FOUND);
  }

  // Banned, dormant and in-review pages get the shell with their state and
  // nothing else.
  let data;
  if (result.state === 'active') {
    data = { state: 'active', page: result.page };
  } else {
    data = { state: result.state, slug: result.slug };
  }
  let html = SHELL.replace(DATA_BLOCK, `<script type="application/json" id="pageData">${inlineJson(data)}</script>`);
  if (result.state === 'active') {
    html = html.replace(META_BLOCK, metaFor(result.page));
  } else {
    html = html.replace('<meta name="robots" content="index">', '<meta name="robots" content="noindex">');
  }

  // Live 200; in review 404, as if it were not there yet; banned or dormant 410.
  if (result.state === 'active') {
    response.statusCode = 200;
  } else if (result.state === 'review') {
    response.statusCode = 404;
  } else {
    response.statusCode = 410;
  }
  // A few seconds at the edge, so a busy page is not a query per visit, while
  // an edit or a ban still shows within seconds.
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30');
  response.end(html);
});
