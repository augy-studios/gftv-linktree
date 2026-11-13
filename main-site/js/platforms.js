// Platform links: pick a service, type only the username or ID, and the rest
// of the address is filled in. Each platform has one or more address
// formats; a format is the fixed text before (and sometimes after) the part
// the person types, the pattern that part must match, and an example.
//
// The same table reads an existing link back, so editing a link shows its
// platform and username again. Links are stored as plain addresses; the
// server checks them like any other link.
//
// name is the brand as the brand writes it, for code and tests. What people
// see is platform.<id> in the locale files: the same brand name in English,
// and in Chinese the name the service is known by there where it has one
// (小红书, 领英, 电报), the brand otherwise. Format labels are under
// link.format-<id>, and a format's note (options.note) is a locale key shown
// under the username field when that format is chosen. options.label and
// options.invalid replace the username field's name and its "does not look
// right" message, for a format that takes something other than a username.

const USER = '[A-Za-z0-9._-]{1,64}';
// The same as validate.js EMAIL_PATTERN; the tests check they agree.
export const EMAIL = '[A-Za-z0-9._+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,24}';

// One address format. Each option left out (or empty) takes its default.
const addressFormat = (id, prefix, options = {}) => {
  let suffix = options.suffix;
  if (!suffix) {
    suffix = '';
  }
  let pattern = options.pattern;
  if (!pattern) {
    pattern = USER;
  }
  let example = options.example;
  if (!example) {
    example = 'yourname';
  }
  let strip = options.strip;
  if (strip === null || strip === undefined) {
    strip = /^@/;
  }
  let note = options.note;
  if (!note) {
    note = null;
  }
  let label = options.label;
  if (!label) {
    label = 'link.username';
  }
  let invalid = options.invalid;
  if (!invalid) {
    invalid = 'link.username-invalid';
  }
  let inputMode = options.inputmode;
  if (!inputMode) {
    inputMode = 'text';
  }
  return {
    id,
    prefix,
    suffix,
    pattern: new RegExp(`^${pattern}$`),
    example,
    strip,
    note,
    label,
    invalid,
    inputmode: inputMode,
  };
};

export const PLATFORMS = [
  // social
  { id: 'instagram', name: 'Instagram', icon: 'instagram', category: 'social', formats: [addressFormat('profile', 'https://www.instagram.com/')] },
  { id: 'x', name: 'X', icon: 'x', category: 'social', formats: [addressFormat('profile', 'https://x.com/', { pattern: '[A-Za-z0-9_]{1,15}' })] },
  { id: 'threads', name: 'Threads', icon: 'threads', category: 'social', formats: [addressFormat('profile', 'https://www.threads.net/@')] },
  { id: 'bluesky', name: 'Bluesky', icon: 'bluesky', category: 'social', formats: [addressFormat('profile', 'https://bsky.app/profile/', { pattern: '[A-Za-z0-9.-]{3,253}', example: 'yourname.bsky.social' })] },
  { id: 'facebook', name: 'Facebook', icon: 'facebook', category: 'social', formats: [addressFormat('profile', 'https://www.facebook.com/')] },
  { id: 'tiktok', name: 'TikTok', icon: 'tiktok', category: 'social', formats: [addressFormat('profile', 'https://www.tiktok.com/@')] },
  { id: 'mastodon', name: 'Mastodon', icon: 'mastodon', category: 'social', formats: [addressFormat('profile', 'https://', { pattern: '[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/@[A-Za-z0-9_]{1,30}', example: 'mastodon.social/@yourname', strip: /^$/ })] },
  { id: 'tumblr', name: 'Tumblr', icon: 'tumblr', category: 'social', formats: [addressFormat('blog', 'https://', { suffix: '.tumblr.com', pattern: '[A-Za-z0-9-]{1,32}' })] },
  { id: 'reddit', name: 'Reddit', icon: 'reddit', category: 'social', formats: [addressFormat('profile', 'https://www.reddit.com/user/', { strip: /^(u\/|@)/ })] },
  { id: 'snapchat', name: 'Snapchat', icon: 'snapchat', category: 'social', formats: [addressFormat('profile', 'https://www.snapchat.com/add/')] },
  { id: 'pinterest', name: 'Pinterest', icon: 'pinterest', category: 'social', formats: [addressFormat('profile', 'https://www.pinterest.com/')] },
  { id: 'xiaohongshu', name: 'Xiaohongshu', icon: 'xiaohongshu', category: 'social', formats: [addressFormat('profile', 'https://www.xiaohongshu.com/user/profile/', { pattern: '[A-Za-z0-9]{8,40}', example: '5f1a2b3c4d5e6f7a8b9c0d1e' })] },
  { id: 'vk', name: 'VK', icon: 'vk', category: 'social', formats: [addressFormat('profile', 'https://vk.com/', { pattern: '[A-Za-z0-9._]{1,64}' })] },
  { id: 'weibo', name: 'Weibo', icon: 'sinaweibo', category: 'social', formats: [addressFormat('uid', 'https://weibo.com/u/', { pattern: '[0-9]{5,20}', example: '1234567890', strip: /^$/ })] },
  { id: 'barq', name: 'Barq', icon: 'barq', category: 'social', formats: [addressFormat('profile', 'https://barq.app/@')] },
  { id: 'linkedin', name: 'LinkedIn', icon: 'briefcase', category: 'social', formats: [addressFormat('profile', 'https://www.linkedin.com/in/', { pattern: '[A-Za-z0-9-]{3,100}' })] },

  // video and streaming
  {
    id: 'youtube', name: 'YouTube', icon: 'youtube', category: 'streaming',
    formats: [
      addressFormat('handle', 'https://www.youtube.com/@', { example: 'yourname' }),
      addressFormat('channel', 'https://www.youtube.com/channel/', { pattern: 'UC[A-Za-z0-9_-]{22}', example: 'UCxxxxxxxxxxxxxxxxxxxxxx', strip: /^$/ }),
      addressFormat('custom', 'https://www.youtube.com/c/', { strip: /^$/ }),
      addressFormat('user', 'https://www.youtube.com/user/', { strip: /^$/ }),
    ],
  },
  { id: 'twitch', name: 'Twitch', icon: 'twitch', category: 'streaming', formats: [addressFormat('channel', 'https://www.twitch.tv/', { pattern: '[A-Za-z0-9_]{3,25}' })] },
  { id: 'kick', name: 'Kick', icon: 'kick', category: 'streaming', formats: [addressFormat('channel', 'https://kick.com/')] },
  { id: 'vimeo', name: 'Vimeo', icon: 'vimeo', category: 'streaming', formats: [addressFormat('profile', 'https://vimeo.com/')] },
  { id: 'bilibili', name: 'Bilibili', icon: 'bilibili', category: 'streaming', formats: [addressFormat('space', 'https://space.bilibili.com/', { pattern: '[0-9]{1,20}', example: '123456789', strip: /^$/ })] },

  // music and podcasts
  {
    id: 'spotify', name: 'Spotify', icon: 'spotify', category: 'audio',
    formats: [
      addressFormat('artist', 'https://open.spotify.com/artist/', { pattern: '[A-Za-z0-9]{22}', example: '0OdUWJ0sBjDrqHygGUXeCF', strip: /^$/ }),
      addressFormat('profile', 'https://open.spotify.com/user/', { strip: /^$/ }),
    ],
  },
  { id: 'soundcloud', name: 'SoundCloud', icon: 'soundcloud', category: 'audio', formats: [addressFormat('profile', 'https://soundcloud.com/')] },
  { id: 'bandcamp', name: 'Bandcamp', icon: 'bandcamp', category: 'audio', formats: [addressFormat('profile', 'https://', { suffix: '.bandcamp.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'youtubemusic', name: 'YouTube Music', icon: 'youtubemusic', category: 'audio', formats: [addressFormat('channel', 'https://music.youtube.com/channel/', { pattern: 'UC[A-Za-z0-9_-]{22}', example: 'UCxxxxxxxxxxxxxxxxxxxxxx', strip: /^$/ })] },

  // messaging
  { id: 'email', name: 'Email', icon: 'mail', category: 'messaging', formats: [addressFormat('address', 'mailto:', { pattern: EMAIL, example: 'you@example.com', strip: /^mailto:/i, label: 'link.email-address', invalid: 'link.email-invalid', inputmode: 'email' })] },
  { id: 'telegram', name: 'Telegram', icon: 'telegram', category: 'messaging', formats: [addressFormat('profile', 'https://t.me/', { pattern: '[A-Za-z0-9_]{4,32}' })] },
  {
    id: 'discord', name: 'Discord', icon: 'discord', category: 'messaging',
    formats: [
      // A server is an invite, at either of Discord's two addresses for one; a
      // person is their numeric user ID (never the username), which the note
      // says and explains how to find.
      addressFormat('invite', 'https://discord.gg/', { pattern: '[A-Za-z0-9-]{2,32}', example: 'abc123', strip: /^(https?:\/\/)?(discord\.gg\/|discord\.com\/invite\/)/, note: 'link.note-discord-invite' }),
      addressFormat('invite-com', 'https://discord.com/invite/', { pattern: '[A-Za-z0-9-]{2,32}', example: 'abc123', strip: /^(https?:\/\/)?(discord\.gg\/|discord\.com\/invite\/)/, note: 'link.note-discord-invite' }),
      addressFormat('userid', 'https://discord.com/users/', { pattern: '[0-9]{17,20}', example: '723403569260134401', strip: /^(https?:\/\/)?discord\.com\/users\//, note: 'link.note-discord-user' }),
    ],
  },
  { id: 'whatsapp', name: 'WhatsApp', icon: 'whatsapp', category: 'messaging', formats: [addressFormat('number', 'https://wa.me/', { pattern: '[0-9]{7,15}', example: '6591234567', strip: /^\+|[\s-]/g })] },
  { id: 'line', name: 'LINE', icon: 'line', category: 'messaging', formats: [addressFormat('profile', 'https://line.me/ti/p/~', { strip: /^~/ })] },

  // art and creators
  { id: 'furaffinity', name: 'Fur Affinity', icon: 'furaffinity', category: 'creators', formats: [addressFormat('profile', 'https://www.furaffinity.net/user/', { pattern: '[A-Za-z0-9._~-]{1,64}' })] },
  { id: 'deviantart', name: 'DeviantArt', icon: 'deviantart', category: 'creators', formats: [addressFormat('profile', 'https://www.deviantart.com/')] },
  { id: 'artstation', name: 'ArtStation', icon: 'artstation', category: 'creators', formats: [addressFormat('profile', 'https://www.artstation.com/')] },
  { id: 'pixiv', name: 'pixiv', icon: 'pixiv', category: 'creators', formats: [addressFormat('profile', 'https://www.pixiv.net/users/', { pattern: '[0-9]{1,20}', example: '12345678', strip: /^$/ })] },
  { id: 'toyhouse', name: 'Toyhouse', icon: 'home', category: 'creators', formats: [addressFormat('profile', 'https://toyhou.se/')] },
  { id: 'vgen', name: 'VGen', icon: 'brush', category: 'creators', formats: [addressFormat('profile', 'https://vgen.co/')] },
  { id: 'behance', name: 'Behance', icon: 'behance', category: 'creators', formats: [addressFormat('profile', 'https://www.behance.net/')] },
  { id: 'dribbble', name: 'Dribbble', icon: 'dribbble', category: 'creators', formats: [addressFormat('profile', 'https://dribbble.com/')] },
  { id: 'vrchat', name: 'VRChat', icon: 'vrchat', category: 'creators', formats: [addressFormat('profile', 'https://vrchat.com/home/user/', { pattern: 'usr_[a-f0-9-]{36}', example: 'usr_c1644b5b-3ca4-45b4-97c6-a2a0de70d469', strip: /^$/ })] },
  { id: 'patreon', name: 'Patreon', icon: 'patreon', category: 'creators', formats: [addressFormat('profile', 'https://www.patreon.com/')] },
  { id: 'kofi', name: 'Ko-fi', icon: 'kofi', category: 'creators', formats: [addressFormat('profile', 'https://ko-fi.com/')] },
  { id: 'buymeacoffee', name: 'Buy Me a Coffee', icon: 'buymeacoffee', category: 'creators', formats: [addressFormat('profile', 'https://buymeacoffee.com/')] },
  { id: 'gumroad', name: 'Gumroad', icon: 'gumroad', category: 'creators', formats: [addressFormat('profile', 'https://', { suffix: '.gumroad.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'substack', name: 'Substack', icon: 'substack', category: 'creators', formats: [addressFormat('profile', 'https://', { suffix: '.substack.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'medium', name: 'Medium', icon: 'medium', category: 'creators', formats: [addressFormat('profile', 'https://medium.com/@')] },

  // shops and payments
  { id: 'etsy', name: 'Etsy', icon: 'etsy', category: 'payments', formats: [addressFormat('shop', 'https://www.etsy.com/shop/', { pattern: '[A-Za-z0-9]{4,20}' })] },
  { id: 'redbubble', name: 'Redbubble', icon: 'redbubble', category: 'payments', formats: [addressFormat('shop', 'https://www.redbubble.com/people/', { suffix: '/shop' })] },
  { id: 'threadless', name: 'Threadless', icon: 'threadless', category: 'payments', formats: [addressFormat('shop', 'https://', { suffix: '.threadless.com', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'shopee', name: 'Shopee', icon: 'shopee', category: 'payments', formats: [addressFormat('shop', 'https://shopee.sg/')] },
  { id: 'paypal', name: 'PayPal', icon: 'paypal', category: 'payments', formats: [addressFormat('me', 'https://paypal.me/', { pattern: '[A-Za-z0-9]{1,20}' })] },
  { id: 'cashapp', name: 'Cash App', icon: 'cashapp', category: 'payments', formats: [addressFormat('cashtag', 'https://cash.app/$', { pattern: '[A-Za-z0-9]{1,20}', strip: /^\$/ })] },
  { id: 'venmo', name: 'Venmo', icon: 'venmo', category: 'payments', formats: [addressFormat('profile', 'https://venmo.com/u/')] },

  // gaming and code
  {
    id: 'steam', name: 'Steam', icon: 'steam', category: 'gaming',
    formats: [
      addressFormat('custom', 'https://steamcommunity.com/id/', { strip: /^$/ }),
      addressFormat('profile', 'https://steamcommunity.com/profiles/', { pattern: '[0-9]{17}', example: '76561198000000000', strip: /^$/ }),
    ],
  },
  { id: 'itchio', name: 'itch.io', icon: 'itchdotio', category: 'gaming', formats: [addressFormat('profile', 'https://', { suffix: '.itch.io', pattern: '[A-Za-z0-9-]{1,64}' })] },
  { id: 'github', name: 'GitHub', icon: 'github', category: 'gaming', formats: [addressFormat('profile', 'https://github.com/', { pattern: '[A-Za-z0-9-]{1,39}' })] },
  { id: 'gitlab', name: 'GitLab', icon: 'gitlab', category: 'gaming', formats: [addressFormat('profile', 'https://gitlab.com/')] },
];

export const PLATFORM_CATEGORIES = ['social', 'streaming', 'audio', 'messaging', 'creators', 'payments', 'gaming'];

export function platformById(id) {
  const platform = PLATFORMS.find((candidate) => candidate.id === id);
  if (!platform) {
    return null;
  }
  return platform;
}

// What the person typed, tidied: whitespace trimmed, a leading @ (or the
// format's own prefix character) dropped, and a whole pasted address cut
// down to its username when it is this format's address.
export function cleanUsername(format, input) {
  let value = '';
  if (input) {
    value = String(input).trim();
  }
  const fromUrl = readWith(format, value);
  if (fromUrl !== null) {
    return fromUrl;
  }
  value = value.replace(format.strip, '');
  return value.replace(/\/+$/, '');
}

export function buildUrl(format, username) {
  return `${format.prefix}${username}${format.suffix}`;
}

export function usernameOk(format, username) {
  return format.pattern.test(username);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The username in a full address of this format, or null. The scheme and a
// leading "www." are optional, so pasted addresses still match.
function readWith(format, url) {
  const host = format.prefix.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const addressPattern = new RegExp(`^(?:https?://)?(?:www\\.)?${escape(host)}(.+?)${escape(format.suffix)}/?$`, 'i');
  const match = url.match(addressPattern);
  if (match && format.pattern.test(match[1])) {
    return match[1];
  }
  return null;
}

// The platform, format and username of an existing link, or null when it is
// not one of the platforms here.
export function matchPlatform(url) {
  for (const platform of PLATFORMS) {
    for (const format of platform.formats) {
      // A format that is only "https://" with no fixed ending (Mastodon,
      // where the server varies) would match nearly any address, so it is
      // never guessed from a link; it is only chosen.
      if (format.prefix === 'https://' && !format.suffix) {
        continue;
      }
      const username = readWith(format, url);
      if (username !== null) {
        return { platform, format, username };
      }
    }
  }
  return null;
}
