// Input rules: slugs, URLs, text, passwords, icons. Every rule that the
// browser also shows lives here first; the browser copy is only a courtesy.

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
// the caller, since they need a query.
export function checkSlug(input) {
  const slug = normaliseSlug(input);
  if (!SLUG_SHAPE.test(slug)) return { ok: false, error: 'slug_invalid' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'slug_reserved' };
  return { ok: true, slug };
}

// http and https only. A bare domain gets https:// in front, the way people
// type addresses. Anything with another scheme (javascript:, data:, file:,
// mailto:, intent: and the rest) is refused, never rewritten.
export function sanitizeUrl(input) {
  let raw = String(input ?? '').trim();
  if (raw === '' || raw.length > 2048) return { ok: false, error: 'url_invalid' };
  // Control characters and whitespace are how scheme filters get dodged
  // ("java\tscript:"), so they end the check rather than being stripped.
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return { ok: false, error: 'url_invalid' };

  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') return { ok: false, error: 'url_scheme' };
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

// True when host is a blocked domain or a subdomain of one.
export function hostIsBlocked(host, blockedDomains) {
  const h = String(host || '').toLowerCase();
  return blockedDomains.some((d) => h === d || h.endsWith(`.${d}`));
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

// Names from the app's inline SVG set (js/icons.js LINK_ICONS). Never markup.
export const LINK_ICONS = new Set([
  'link', 'globe', 'video', 'music', 'camera', 'chat', 'shop', 'code',
  'calendar', 'document', 'heart', 'star', 'mic', 'game', 'news', 'map',
  'gift', 'ticket', 'mail', 'phone',
]);

export function checkIcon(value) {
  return LINK_ICONS.has(value) ? value : 'link';
}

// A page left in `pending` (setup never finished) for this long releases its
// slug to the next person who asks for it.
export const STALE_PENDING_MS = 3600_000;

export const MAX_LINKS = 50;
export const LIMITS = Object.freeze({ displayName: 60, bio: 280, title: 80, reportDetails: 500, reason: 500, label: 60 });

export const REPORT_REASONS = new Set(['spam', 'scam', 'malware', 'impersonation', 'abuse', 'adult', 'other']);

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
