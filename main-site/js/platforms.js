// Platform links: pick a service, type only the username or ID, and the rest
// of the address is filled in. Each platform has one or more address
// formats; a format is the fixed text before (and sometimes after) the part
// the person types, the pattern that part must match, and an example.
//
// The same table reads an existing link back, so editing a link shows its
// platform and username again. Links are stored as plain addresses; the
// server checks them like any other link.
//
// Brand names are written as the brands write them, so they are not
// translated. Format labels are, under link.format-<id> in the locale files.

const USER = '[A-Za-z0-9._-]{1,64}';

const f = (id, prefix, opts = {}) => ({
  id,
  prefix,
  suffix: opts.suffix || '',
  pattern: new RegExp(`^${opts.pattern || USER}$`),
  example: opts.example || 'yourname',
  strip: opts.strip ?? /^@/,
});

export const PLATFORMS = [
  // social
  { id: 'instagram', name: 'Instagram', icon: 'instagram', category: 'social', formats: [f('profile', 'https://www.instagram.com/')] },
  { id: 'x', name: 'X', icon: 'x', category: 'social', formats: [f('profile', 'https://x.com/', { pattern: '[A-Za-z0-9_]{1,15}' })] },
  { id: 'threads', name: 'Threads', icon: 'threads', category: 'social', formats: [f('profile', 'https://www.threads.net/@')] },
  { id: 'bluesky', name: 'Bluesky', icon: 'bluesky', category: 'social', formats: [f('profile', 'https://bsky.app/profile/', { pattern: '[A-Za-z0-9.-]{3,253}', example: 'yourname.bsky.social' })] },
  { id: 'facebook', name: 'Facebook', icon: 'facebook', category: 'social', formats: [f('profile', 'https://www.facebook.com/')] },
  { id: 'tiktok', name: 'TikTok', icon: 'tiktok', category: 'social', formats: [f('profile', 'https://www.tiktok.com/@')] },
  { id: 'mastodon', name: 'Mastodon', icon: 'mastodon', category: 'social', formats: [f('profile', 'https://', { pattern: '[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/@[A-Za-z0-9_]{1,30}', example: 'mastodon.social/@yourname', strip: /^$/ })] },
  { id: 'tumblr', name: 'Tumblr', icon: 'tumblr', category: 'social', formats: [f('blog', 'https://', { suffix: '.tumblr.com', pattern: '[A-Za-z0-9-]{1,32}' })] },
  { id: 'reddit', name: 'Reddit', icon: 'reddit', category: 'social', formats: [f('profile', 'https://www.reddit.com/user/', { strip: /^(u\/|@)/ })] },
  { id: 'snapchat', name: 'Snapchat', icon: 'snapchat', category: 'social', formats: [f('profile', 'https://www.snapchat.com/add/')] },
  { id: 'pinterest', name: 'Pinterest', icon: 'pinterest', category: 'social', formats: [f('profile', 'https://www.pinterest.com/')] },
  { id: 'xiaohongshu', name: 'Xiaohongshu', icon: 'xiaohongshu', category: 'social', formats: [f('profile', 'https://www.xiaohongshu.com/user/profile/', { pattern: '[A-Za-z0-9]{8,40}', example: '5f1a2b3c4d5e6f7a8b9c0d1e' })] },
  { id: 'linkedin', name: 'LinkedIn', icon: 'briefcase', category: 'social', formats: [f('profile', 'https://www.linkedin.com/in/', { pattern: '[A-Za-z0-9-]{3,100}' })] },

  // video and streaming
  {
    id: 'youtube', name: 'YouTube', icon: 'youtube', category: 'streaming',
    formats: [
      f('handle', 'https://www.youtube.com/@', { example: 'yourname' }),
      f('channel', 'https://www.youtube.com/channel/', { pattern: 'UC[A-Za-z0-9_-]{22}', example: 'UCxxxxxxxxxxxxxxxxxxxxxx', strip: /^$/ }),
      f('custom', 'https://www.youtube.com/c/', { strip: /^$/ }),
      f('user', 'https://www.youtube.com/user/', { strip: /^$/ }),
    ],
  },
  { id: 'twitch', name: 'Twitch', icon: 'twitch', category: 'streaming', formats: [f('channel', 'https://www.twitch.tv/', { pattern: '[A-Za-z0-9_]{3,25}' })] },
  { id: 'kick', name: 'Kick', icon: 'kick', category: 'streaming', formats: [f('channel', 'https://kick.com/')] },
  { id: 'vimeo', name: 'Vimeo', icon: 'vimeo', category: 'streaming', formats: [f('profile', 'https://vimeo.com/')] },
  { id: 'bilibili', name: 'Bilibili', icon: 'bilibili', category: 'streaming', formats: [f('space', 'https://space.bilibili.com/', { pattern: '[0-9]{1,20}', example: '123456789', strip: /^$/ })] },

  // music and podcasts
  {
    id: 'spotify', name: 'Spotify', icon: 'spotify', category: 'audio',
    formats: [
      f('artist', 'https://open.spotify.com/artist/', { pattern: '[A-Za-z0-9]{22}', example: '0OdUWJ0sBjDrqHygGUXeCF', strip: /^$/ }),
      f('profile', 'https://open.spotify.com/user/', { strip: /^$/ }),
    ],
  },
  { id: 'soundcloud', name: 'SoundCloud', icon: 'soundcloud', category: 'audio', formats: [f('profile', 'https://soundcloud.com/')] },
  { id: 'bandcamp', name: 'Bandcamp', icon: 'bandcamp', category: 'audio', formats: [f('profile', 'https://', { suffix: '.bandcamp.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'youtubemusic', name: 'YouTube Music', icon: 'youtubemusic', category: 'audio', formats: [f('channel', 'https://music.youtube.com/channel/', { pattern: 'UC[A-Za-z0-9_-]{22}', example: 'UCxxxxxxxxxxxxxxxxxxxxxx', strip: /^$/ })] },

  // messaging
  { id: 'telegram', name: 'Telegram', icon: 'telegram', category: 'messaging', formats: [f('profile', 'https://t.me/', { pattern: '[A-Za-z0-9_]{4,32}' })] },
  { id: 'discord', name: 'Discord', icon: 'discord', category: 'messaging', formats: [f('invite', 'https://discord.gg/', { pattern: '[A-Za-z0-9-]{2,32}', example: 'abc123', strip: /^(https?:\/\/)?(discord\.gg\/|discord\.com\/invite\/)/ })] },
  { id: 'whatsapp', name: 'WhatsApp', icon: 'whatsapp', category: 'messaging', formats: [f('number', 'https://wa.me/', { pattern: '[0-9]{7,15}', example: '6591234567', strip: /^\+|[\s-]/g })] },
  { id: 'line', name: 'LINE', icon: 'line', category: 'messaging', formats: [f('profile', 'https://line.me/ti/p/~', { strip: /^~/ })] },

  // art and creators
  { id: 'furaffinity', name: 'Fur Affinity', icon: 'furaffinity', category: 'creators', formats: [f('profile', 'https://www.furaffinity.net/user/', { pattern: '[A-Za-z0-9._~-]{1,64}' })] },
  { id: 'deviantart', name: 'DeviantArt', icon: 'deviantart', category: 'creators', formats: [f('profile', 'https://www.deviantart.com/')] },
  { id: 'artstation', name: 'ArtStation', icon: 'artstation', category: 'creators', formats: [f('profile', 'https://www.artstation.com/')] },
  { id: 'pixiv', name: 'pixiv', icon: 'pixiv', category: 'creators', formats: [f('profile', 'https://www.pixiv.net/users/', { pattern: '[0-9]{1,20}', example: '12345678', strip: /^$/ })] },
  { id: 'toyhouse', name: 'Toyhouse', icon: 'home', category: 'creators', formats: [f('profile', 'https://toyhou.se/')] },
  { id: 'vgen', name: 'VGen', icon: 'brush', category: 'creators', formats: [f('profile', 'https://vgen.co/')] },
  { id: 'behance', name: 'Behance', icon: 'behance', category: 'creators', formats: [f('profile', 'https://www.behance.net/')] },
  { id: 'dribbble', name: 'Dribbble', icon: 'dribbble', category: 'creators', formats: [f('profile', 'https://dribbble.com/')] },
  { id: 'vrchat', name: 'VRChat', icon: 'vrchat', category: 'creators', formats: [f('profile', 'https://vrchat.com/home/user/', { pattern: 'usr_[a-f0-9-]{36}', example: 'usr_c1644b5b-3ca4-45b4-97c6-a2a0de70d469', strip: /^$/ })] },
  { id: 'patreon', name: 'Patreon', icon: 'patreon', category: 'creators', formats: [f('profile', 'https://www.patreon.com/')] },
  { id: 'kofi', name: 'Ko-fi', icon: 'kofi', category: 'creators', formats: [f('profile', 'https://ko-fi.com/')] },
  { id: 'buymeacoffee', name: 'Buy Me a Coffee', icon: 'buymeacoffee', category: 'creators', formats: [f('profile', 'https://buymeacoffee.com/')] },
  { id: 'gumroad', name: 'Gumroad', icon: 'gumroad', category: 'creators', formats: [f('profile', 'https://', { suffix: '.gumroad.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'substack', name: 'Substack', icon: 'substack', category: 'creators', formats: [f('profile', 'https://', { suffix: '.substack.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'medium', name: 'Medium', icon: 'medium', category: 'creators', formats: [f('profile', 'https://medium.com/@')] },

  // shops and payments
  { id: 'etsy', name: 'Etsy', icon: 'etsy', category: 'payments', formats: [f('shop', 'https://www.etsy.com/shop/', { pattern: '[A-Za-z0-9]{4,20}' })] },
  { id: 'redbubble', name: 'Redbubble', icon: 'redbubble', category: 'payments', formats: [f('shop', 'https://www.redbubble.com/people/', { suffix: '/shop' })] },
  { id: 'threadless', name: 'Threadless', icon: 'threadless', category: 'payments', formats: [f('shop', 'https://', { suffix: '.threadless.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'shopee', name: 'Shopee', icon: 'shopee', category: 'payments', formats: [f('shop', 'https://shopee.sg/')] },
  { id: 'paypal', name: 'PayPal', icon: 'paypal', category: 'payments', formats: [f('me', 'https://paypal.me/', { pattern: '[A-Za-z0-9]{1,20}' })] },
  { id: 'cashapp', name: 'Cash App', icon: 'cashapp', category: 'payments', formats: [f('cashtag', 'https://cash.app/$', { pattern: '[A-Za-z0-9]{1,20}', strip: /^\$/ })] },
  { id: 'venmo', name: 'Venmo', icon: 'venmo', category: 'payments', formats: [f('profile', 'https://venmo.com/u/')] },

  // gaming and code
  {
    id: 'steam', name: 'Steam', icon: 'steam', category: 'gaming',
    formats: [
      f('custom', 'https://steamcommunity.com/id/', { strip: /^$/ }),
      f('profile', 'https://steamcommunity.com/profiles/', { pattern: '[0-9]{17}', example: '76561198000000000', strip: /^$/ }),
    ],
  },
  { id: 'itchio', name: 'itch.io', icon: 'itchdotio', category: 'gaming', formats: [f('profile', 'https://', { suffix: '.itch.io', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'github', name: 'GitHub', icon: 'github', category: 'gaming', formats: [f('profile', 'https://github.com/', { pattern: '[A-Za-z0-9-]{1,39}' })] },
  { id: 'gitlab', name: 'GitLab', icon: 'gitlab', category: 'gaming', formats: [f('profile', 'https://gitlab.com/')] },
];

export const PLATFORM_CATEGORIES = ['social', 'streaming', 'audio', 'messaging', 'creators', 'payments', 'gaming'];

export function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

// What the person typed, tidied: whitespace trimmed, a leading @ (or the
// format's own prefix character) dropped, and a whole pasted address cut
// down to its username when it is this format's address.
export function cleanUsername(format, input) {
  let value = String(input || '').trim();
  const fromUrl = readWith(format, value);
  if (fromUrl !== null) return fromUrl;
  value = value.replace(format.strip, '');
  return value.replace(/\/+$/, '');
}

export function buildUrl(format, username) {
  return `${format.prefix}${username}${format.suffix}`;
}

export function usernameOk(format, username) {
  return format.pattern.test(username);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The username in a full address of this format, or null. The scheme and a
// leading "www." are optional, so pasted addresses still match.
function readWith(format, url) {
  const host = format.prefix.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const re = new RegExp(`^(?:https?://)?(?:www\\.)?${escape(host)}(.+?)${escape(format.suffix)}/?$`, 'i');
  const m = url.match(re);
  return m && format.pattern.test(m[1]) ? m[1] : null;
}

// The platform, format and username of an existing link, or null when it is
// not one of the platforms here.
export function matchPlatform(url) {
  for (const platform of PLATFORMS) {
    for (const format of platform.formats) {
      // A format that is only "https://" with no fixed ending (Mastodon,
      // where the server varies) would match nearly any address, so it is
      // never guessed from a link; it is only chosen.
      if (format.prefix === 'https://' && !format.suffix) continue;
      const username = readWith(format, url);
      if (username !== null) return { platform, format, username };
    }
  }
  return null;
}
