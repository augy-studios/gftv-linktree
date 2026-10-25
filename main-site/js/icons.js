// Inline SVG icons, coloured with currentColor. Feather-style, 24 unit grid.
// Usage: <span data-icon="sun" aria-hidden="true"></span>, then hydrateIcons().
// No emoji anywhere, per the theme rules.

import { BRANDS, FEATHER } from './icon-data.js';

const PATHS = {
  // interface
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.6-10-8.6z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3M21 14v7h-7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  // Passkeys use "key"; backup codes use the life ring, so the two never
  // look alike side by side in the sign-in choices.
  lifebuoy: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="M4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M14.83 9.17l4.24-4.24M4.93 19.07l4.24-4.24"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>',
  restore: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
  // link icons, the set an owner can pick from (api/_lib/validate.js LINK_ICONS)
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  video: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M23 7l-6 5 6 5V7z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  shop: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  heart: '<path fill="currentColor" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>',
  game: '<path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><rect x="2" y="6" width="20" height="12" rx="4"/>',
  news: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/>',
  map: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  gift: '<path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  ticket: '<path d="M2 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
};

// The icons a link can use, by picker category. The first twenty names keep
// their original drawings above; the rest come from icon-data.js (Feather
// outlines and Simple Icons logos). LINK_ICONS in api/_lib/validate.js is
// the authority on which names a link may store, and the tests check the two
// lists agree.
export const ICON_CATEGORIES = [
  ['general', ['link', 'globe', 'home', 'user', 'users', 'info', 'star', 'heart', 'bookmark', 'award', 'zap', 'smile']],
  ['media', ['video', 'film', 'music', 'headphones', 'mic', 'radio', 'tv', 'camera', 'image']],
  ['contact', ['chat', 'mail', 'phone', 'at', 'send', 'smartphone']],
  ['shopping', ['shop', 'cart', 'card', 'dollar', 'coffee', 'gift', 'ticket', 'tag', 'package', 'box']],
  ['creative', ['brush', 'pencil', 'feather', 'book', 'book-open', 'document', 'news', 'rss', 'layers']],
  ['tech', ['code', 'terminal', 'cpu', 'monitor', 'download', 'game']],
  ['places', ['map', 'map-pin', 'compass', 'calendar', 'clock', 'sun', 'moon', 'cloud', 'briefcase']],
  ['social', ['instagram', 'x', 'threads', 'bluesky', 'facebook', 'tiktok', 'mastodon', 'tumblr', 'reddit', 'snapchat', 'pinterest', 'xiaohongshu', 'linktree']],
  ['streaming', ['youtube', 'twitch', 'kick', 'vimeo', 'bilibili']],
  ['audio', ['spotify', 'soundcloud', 'bandcamp', 'applemusic', 'youtubemusic', 'applepodcasts']],
  ['messaging', ['telegram', 'discord', 'whatsapp', 'line']],
  ['creators', ['furaffinity', 'deviantart', 'artstation', 'pixiv', 'behance', 'dribbble', 'vrchat', 'patreon', 'kofi', 'buymeacoffee', 'gumroad', 'substack', 'medium']],
  ['payments', ['etsy', 'redbubble', 'threadless', 'shopee', 'paypal', 'cashapp', 'venmo']],
  ['gaming', ['steam', 'itchdotio', 'github', 'gitlab']],
];

export const LINK_ICONS = ICON_CATEGORIES.flatMap(([, names]) => names);

export function isBrand(name) {
  return Object.prototype.hasOwnProperty.call(BRANDS, name);
}

// A brand's own name, for labels ("YouTube"), or null for a general icon.
export function brandTitle(name) {
  return isBrand(name) ? BRANDS[name].title : null;
}

export function icon(name) {
  const svg = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  // Logos are filled shapes; everything else is a stroked outline.
  if (isBrand(name)) return `<svg ${svg} fill="currentColor"><path d="${BRANDS[name].path}"/></svg>`;
  const body = PATHS[name] ?? FEATHER[name];
  if (!body) return '';
  return `<svg ${svg} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// A span holding an icon, for building nodes in code.
export function iconNode(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = icon(name);
  return span;
}

// Replace every [data-icon] span under root with its SVG.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const svg = icon(el.getAttribute('data-icon'));
    if (!svg) return;
    el.innerHTML = svg;
    el.setAttribute('aria-hidden', 'true');
    el.removeAttribute('data-icon');
    el.classList.add('icon');
  });
}

// A sensible icon for an address, used as the default when adding a link.
const HOST_ICONS = [
  [/(^|\.)(youtube\.com|youtu\.be|twitch\.tv|vimeo\.com|tiktok\.com|bilibili\.com)$/, 'video'],
  [/(^|\.)(spotify\.com|music\.apple\.com|soundcloud\.com|bandcamp\.com|music\.youtube\.com)$/, 'music'],
  [/(^|\.)(instagram\.com|flickr\.com|500px\.com|vsco\.co|pixiv\.net|deviantart\.com|furaffinity\.net)$/, 'camera'],
  [/(^|\.)(t\.me|telegram\.me|discord\.gg|discord\.com|wa\.me|whatsapp\.com|line\.me|signal\.me|x\.com|twitter\.com|bsky\.app|threads\.net|mastodon\.social|facebook\.com)$/, 'chat'],
  [/(^|\.)(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)$/, 'code'],
  [/(^|\.)(shopee\.\w+|lazada\.\w+|etsy\.com|amazon\.\w+|carousell\.\w+|ko-fi\.com|patreon\.com|gumroad\.com)$/, 'shop'],
  [/(^|\.)(calendly\.com|cal\.com)$/, 'calendar'],
  [/(^|\.)(steamcommunity\.com|store\.steampowered\.com|itch\.io|roblox\.com)$/, 'game'],
  [/(^|\.)(maps\.google\.com|goo\.gl|maps\.app\.goo\.gl|openstreetmap\.org)$/, 'map'],
  [/(^|\.)(medium\.com|substack\.com|wordpress\.com|blogspot\.com)$/, 'news'],
];

export function guessIcon(url) {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
    for (const [pattern, name] of HOST_ICONS) if (pattern.test(host)) return name;
  } catch {
    /* not an address yet */
  }
  return 'link';
}
