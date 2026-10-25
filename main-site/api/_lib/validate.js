// Input rules: slugs, URLs, text, passwords, icons. Every rule that the
// browser also shows lives here first; the browser copy is only a courtesy.

import { nameIsUnwelcome } from './name-filter.js';

// The system list from the brief, plus the paths this site itself serves and
// a few names that would read as GFTV speaking officially.
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'auth', 'callback', 'dashboard', 'edit', 'help', 'health',
  'login', 'logout', 'mod', 'privacy', 'register', 'report', 'reset',
  'robots.txt', 'settings', 'sitemap.xml', 'static', 'status', 'terms', 'webhook',
  // served by this site
  '404', 'index', 'assets', 'js', 'images', 'shell', 'www', 'offline',
  // official-sounding
  'gftv', 'globalfurrytv', 'onelink', 'official', 'staff', 'support',
]);

const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/;

export function normaliseSlug(input) {
  return String(input ?? '').trim().toLowerCase();
}

// { ok: true, slug } or { ok: false, error }. Database blocks are checked by
// the caller, since they need a query. A slur or a name posing as GFTV, staff
// or a trusted body (api/_lib/name-filter.js) is "not allowed" rather than
// "reserved", without saying which list it is on.
export function checkSlug(input) {
  const slug = normaliseSlug(input);
  if (!SLUG_SHAPE.test(slug)) return { ok: false, error: 'slug_invalid' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'slug_reserved' };
  if (nameIsUnwelcome(slug)) return { ok: false, error: 'slug_not_allowed' };
  return { ok: true, slug };
}

// A plain email address. No display name, nothing percent-encoded, and no
// ?subject=, ?bcc= or other headers, which could write the message for the
// visitor or copy it to someone else. js/platforms.js has the same pattern;
// the tests check they agree.
export const EMAIL_PATTERN = '[A-Za-z0-9._+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,24}';
const EMAIL = new RegExp(`^${EMAIL_PATTERN}$`);

// http and https only, and with { mail: true } (links, not redirects) an
// email address as well. A bare domain gets https:// in front, and with mail
// a bare email address gets mailto:, the way people type them. Anything with
// another scheme (javascript:, data:, file:, intent: and the rest) is
// refused, never rewritten. host is the web address's host, or the email
// address's domain.
export function sanitizeUrl(input, { mail = false } = {}) {
  let raw = String(input ?? '').trim();
  if (raw === '' || raw.length > 2048) return { ok: false, error: 'url_invalid' };
  // Control characters and whitespace are how scheme filters get dodged
  // ("java\tscript:"), so they end the check rather than being stripped.
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return { ok: false, error: 'url_invalid' };

  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  const name = scheme ? scheme[1].toLowerCase() : null;
  if (mail && (name === 'mailto' || (!scheme && raw.includes('@') && !raw.includes('/')))) return sanitizeMail(raw);
  if (scheme) {
    if (name !== 'http' && name !== 'https') return { ok: false, error: mail ? 'url_scheme_link' : 'url_scheme' };
  } else {
    raw = `https://${raw.replace(/^\/+/, '')}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'url_invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'url_scheme' };
  // https://gftv.asia@evil.example shows a trusted name and goes elsewhere.
  if (url.username || url.password) return { ok: false, error: 'url_credentials' };
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || host === 'localhost') {
    return { ok: false, error: 'url_invalid' };
  }
  if (url.href.length > 2048) return { ok: false, error: 'url_invalid' };
  return { ok: true, url: url.href, host };
}

// mailto: and one address, the domain in lower case.
function sanitizeMail(raw) {
  const address = raw.replace(/^mailto:/i, '');
  if (address.length > 254 || !EMAIL.test(address)) return { ok: false, error: 'mail_invalid' };
  const at = address.lastIndexOf('@');
  const host = address.slice(at + 1).toLowerCase();
  return { ok: true, url: `mailto:${address.slice(0, at)}@${host}`, host, mail: true };
}

// Where a saved link leads: an email address's domain, or a web address's
// host. '' when it is neither.
export function linkHost(url) {
  const value = String(url ?? '');
  if (/^mailto:/i.test(value)) return value.slice(value.lastIndexOf('@') + 1).toLowerCase();
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

// The address Safe Browsing is asked about for a link: the link itself, or
// for an email address, its domain's home page.
export function lookupUrl(url) {
  return /^mailto:/i.test(url) ? `https://${linkHost(url)}/` : url;
}

// Web addresses written into text (a bio, a display name, a link title),
// including the ways people hide one from a filter. The text is flattened
// step by step into something an address pattern can find:
//
//   1. NFKC: full-width letters and dots (ｅｖｉｌ．ｃｏｍ) become plain ones.
//   2. Letters that look Latin but are Cyrillic or Greek (еvil, with a
//      Cyrillic е) become the Latin letter they imitate.
//   3. Single characters spaced apart (e v i l . c o m) are closed up.
//   4. Every way of writing the dot becomes ".": wrapped in brackets, quotes,
//      asterisks or other marks (evil[.]com, evil'.'com, evil"."com,
//      evil*.*com, evil<dot>com, evil (dot) com), the word on its own
//      (evil dot com, evil d0t com), dot-like characters (· • ・ ․ ﹒ 。), and
//      a plain dot with spaces around it (evil . com).
//
// Liberal on purpose: a candidate is only refused when a block list names
// it, so a sentence that merely looks like an address ("meet.you", or "Hi. I
// am" read as hi.i) costs nothing. [{ host, url }], at most forty.
const LOOKALIKES = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ї: 'i', ј: 'j', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w', ɡ: 'g', ı: 'i',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};
const LOOKALIKE_CHARS = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'g');
const SPACED_OUT = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}.] ){2,}[\p{L}\p{N}.](?![\p{L}\p{N}])/gu;
const WRAP = `[\\[\\](){}<>'"\`*_~|^=+\\\\/-]`;
const DOT_WORD = '(?:dot|d0t|dawt)';
const DOT_CHAR = '[.·•․‧∙⋅・﹒。｡]';
const DOT_SPELLINGS = new RegExp([
  `\\s*${WRAP}+\\s*(?:${DOT_CHAR}|${DOT_WORD})\\s*${WRAP}*\\s*`,
  `\\s*${WRAP}*\\s*(?:${DOT_CHAR}|${DOT_WORD})\\s*${WRAP}+\\s*`,
  `\\s+${DOT_WORD}\\s+`,
  `\\s*[·•․‧∙⋅・﹒。｡]\\s*`,
  `\\s+\\.\\s*`,
  `\\s*\\.\\s+`,
].join('|'), 'gi');
// The ending may hold digits standing in for letters (evil.c0m), so it is
// any letters and digits with at least one letter; 1.5 and 2.0 are not.
const ADDRESS_IN_TEXT = /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9]*[a-z])[a-z0-9]{2,24})(\/\S*)?/gi;
const LEET = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };

export function flattenForAddresses(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(LOOKALIKE_CHARS, (c) => LOOKALIKES[c])
    .replace(SPACED_OUT, (run) => run.replace(/ /g, ''))
    .replace(DOT_SPELLINGS, '.');
}

// Each address as written and, when it has digits, as a reader would type it
// with the digits read as letters (ev1l.c0m is evil.com; 1 is tried as l
// and as i).
export function addressesInText(text) {
  const flat = flattenForAddresses(text);
  const found = new Map();
  const add = (host, path) => {
    const bare = host.replace(/^www\./, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(bare) && !found.has(bare)) found.set(bare, `https://${bare}${path || '/'}`);
  };
  for (const m of flat.matchAll(ADDRESS_IN_TEXT)) {
    add(m[1], m[2]);
    if (/\d/.test(m[1])) {
      add(m[1].replace(/\d/g, (d) => LEET[d] ?? d), m[2]);
      add(m[1].replace(/\d/g, (d) => (d === '1' ? 'i' : LEET[d] ?? d)), m[2]);
    }
    if (found.size >= 40) break;
  }
  return [...found].map(([host, url]) => ({ host, url })).slice(0, 40);
}

// Generic link shorteners. A link through one hides where it really goes,
// which is what a phishing link relies on, so owners are asked for the full
// address instead. A service's own short domain (youtu.be, spoti.fi) is not
// here: it only ever leads to that service.
export const SHORTENER_HOSTS = [
  'bit.ly', 'bitly.com', 'j.mp', 'tinyurl.com', 't.ly', 'is.gd', 'v.gd', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'tiny.one', 'bl.ink', 's.id', 'x.gd',
  'shorte.st', 'adf.ly', 'ouo.io', 'bc.vc', 'shrinkme.io', 'clk.sh', 'short.gy', 'shorturl.asia',
  'tny.im', 'surl.li', 'clck.ru', 'u.to', 'goo.gl', 't.co', 'lnkd.in', 'qrco.de', 'tinylink.net',
  'shorturl.me', 'gg.gg', 'chilp.it', 'soo.gd', 'urlzs.com', 'bit.do', 'dub.sh', 'kutt.it',
];

export function isShortener(host) {
  return hostIsBlocked(host, SHORTENER_HOSTS);
}

// True when host is a blocked domain or a subdomain of one.
export function hostIsBlocked(host, blockedDomains) {
  const h = String(host || '').toLowerCase();
  return blockedDomains.some((d) => h === d || h.endsWith(`.${d}`));
}

// A staff block pattern: a JavaScript regular expression, matched without
// regard to case. { ok, pattern } or { ok: false, error }. Patterns run on
// every link saved and every page served, so the shapes that can take
// exponential time on a crafted address (a repeated group that itself
// repeats, like (a+)+ or (\w*)*) are refused.
export const PATTERN_MAX = 200;
// A group holding a repeat (+, * or {n,}), itself followed by a repeat.
// Escaped characters inside the group are skipped over, so \( does not open
// one.
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,\d*\})/;
export function checkPattern(input) {
  const pattern = String(input ?? '').trim();
  if (!pattern || pattern.length > PATTERN_MAX) return { ok: false, error: 'pattern_invalid' };
  try {
    new RegExp(pattern, 'i');
  } catch {
    return { ok: false, error: 'pattern_invalid' };
  }
  if (NESTED_REPEAT.test(pattern)) return { ok: false, error: 'pattern_slow' };
  return { ok: true, pattern };
}

export const PATTERN_SCOPES = new Set(['links', 'names', 'both']);

// Compiled staff patterns ({ re, appliesTo }) against a text. scope:
// "links" for a link's full address, "names" for a page name.
export function patternBlocks(text, patterns, scope) {
  return (patterns ?? []).some((p) => (p.appliesTo === scope || p.appliesTo === 'both') && p.re.test(text));
}

// An address against both staff lists ({ domains, patterns }). An address
// that does not parse counts as blocked, since it cannot be checked. An
// email address is blocked by its domain.
export function addressBlocked(url, { domains = [], patterns = [] } = {}) {
  const host = linkHost(url);
  if (!host) return true;
  return hostIsBlocked(host, domains) || patternBlocks(url, patterns, 'links');
}

export function normaliseDomain(input) {
  let value = String(input ?? '').trim().toLowerCase();
  value = value.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].replace(/^\*\./, '').replace(/^www\./, '');
  return /^[a-z0-9.-]{3,253}$/.test(value) && value.includes('.') ? value : null;
}

// Plain text for names, bios and titles: NFC, no control characters except
// newlines where allowed, trimmed, capped.
export function cleanText(input, max, { multiline = false } = {}) {
  let value = String(input ?? '').normalize('NFC');
  value = multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    : value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ');
  value = value.replace(multiline ? /[ \t]+/g : /\s+/g, ' ').trim();
  if (multiline) value = value.replace(/\n{3,}/g, '\n\n');
  return [...value].slice(0, max).join('');
}

export const PASSWORD_MIN = 10;
// bcrypt reads 72 bytes and silently ignores the rest. Refusing a longer
// password is honest; accepting it would mean the tail never mattered.
export const PASSWORD_MAX_BYTES = 72;

export function checkPassword(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: 'password_required' };
  if ([...value].length < PASSWORD_MIN) return { ok: false, error: 'password_too_short' };
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) return { ok: false, error: 'password_too_long' };
  return { ok: true };
}

// Names from the app's icon set (js/icons.js ICON_CATEGORIES): general icons
// and service logos. A link stores one of these names, never markup or a URL.
// The tests check this list and the browser's agree.
export const LINK_ICONS = new Set([
  // general
  'link', 'globe', 'home', 'user', 'users', 'info', 'star', 'heart', 'bookmark', 'award', 'zap', 'smile',
  // media
  'video', 'film', 'music', 'headphones', 'mic', 'radio', 'tv', 'camera', 'image',
  // contact
  'chat', 'mail', 'phone', 'at', 'send', 'smartphone',
  // shopping
  'shop', 'cart', 'card', 'dollar', 'coffee', 'gift', 'ticket', 'tag', 'package', 'box',
  // creative
  'brush', 'pencil', 'feather', 'book', 'book-open', 'document', 'news', 'rss', 'layers',
  // tech
  'code', 'terminal', 'cpu', 'monitor', 'download', 'game',
  // places
  'map', 'map-pin', 'compass', 'calendar', 'clock', 'sun', 'moon', 'cloud', 'briefcase',
  // social
  'instagram', 'x', 'threads', 'bluesky', 'facebook', 'tiktok', 'mastodon', 'tumblr', 'reddit', 'snapchat', 'pinterest', 'xiaohongshu', 'linktree',
  // streaming
  'youtube', 'twitch', 'kick', 'vimeo', 'bilibili',
  // audio
  'spotify', 'soundcloud', 'bandcamp', 'applemusic', 'youtubemusic', 'applepodcasts',
  // messaging
  'telegram', 'discord', 'whatsapp', 'line',
  // creators
  'furaffinity', 'deviantart', 'artstation', 'pixiv', 'behance', 'dribbble', 'vrchat', 'patreon', 'kofi', 'buymeacoffee', 'gumroad', 'substack', 'medium',
  // payments
  'etsy', 'redbubble', 'threadless', 'shopee', 'paypal', 'cashapp', 'venmo',
  // gaming
  'steam', 'itchdotio', 'github', 'gitlab',
]);

export function checkIcon(value) {
  return LINK_ICONS.has(value) ? value : 'link';
}

// A page left in `pending` (setup never finished) for this long releases its
// slug to the next person who asks for it.
export const STALE_PENDING_MS = 3600_000;

export const MAX_LINKS = 50;
export const LIMITS = Object.freeze({ displayName: 60, bio: 512, title: 80, reportDetails: 500, reason: 500, label: 60, quote: 280, author: 60 });

// A page whose owner has not signed in for this long stops being shown until
// they sign in again; the Telegram reminder goes out this long before that.
export const DORMANT_AFTER_DAYS = 365;
export const DORMANCY_WARNING_DAYS = 30;

export function isDormant(lastSignInAt, now = Date.now()) {
  if (!lastSignInAt) return false;
  return now - new Date(lastSignInAt).getTime() > DORMANT_AFTER_DAYS * 86400_000;
}

export function dormantFrom(lastSignInAt) {
  return new Date(new Date(lastSignInAt).getTime() + DORMANT_AFTER_DAYS * 86400_000).toISOString();
}

export const REPORT_REASONS = new Set(['spam', 'scam', 'malware', 'impersonation', 'abuse', 'adult', 'other']);

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
