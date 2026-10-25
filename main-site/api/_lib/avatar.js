// Profile pictures. Stored in the public gftvonelink_avatars bucket
// (migrations/002), always as a 512 by 512 WebP.
//
// The browser already crops and compresses to WebP, but the server re-encodes
// whatever arrives regardless: that guarantees the format and size, strips
// every byte of metadata (EXIF, including GPS), and means a crafted file is
// never stored as sent.

import sharp from 'sharp';
import { db } from './supabase.js';
import { optionalEnv } from './env.js';
import { randomToken } from './crypto.js';

export const AVATAR_BUCKET = 'gftvonelink_avatars';
const SIZE = 512;
// What the browser may send. Its own output is far smaller; this is room for
// a browser that could not compress and sent the picture nearly as it was.
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
// A decompression bomb is a tiny file that claims a huge canvas.
const MAX_INPUT_PIXELS = 40_000_000;

export function avatarUrl(path) {
  if (!path) return null;
  const base = optionalEnv('SUPABASE_URL').replace(/\/+$/, '');
  return base ? `${base}/storage/v1/object/public/${AVATAR_BUCKET}/${path}` : null;
}

function kindOf(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// { ok: true, buffer } with the WebP to store, or { ok: false, error }.
export async function prepareAvatar(input) {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, error: 'avatar_invalid' };
  const base64 = input.replace(/^data:image\/[a-z+.-]+;base64,/i, '');
  if (base64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) return { ok: false, error: 'avatar_too_large' };
  const raw = Buffer.from(base64, 'base64');
  if (raw.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'avatar_too_large' };
  if (!kindOf(raw)) return { ok: false, error: 'avatar_invalid' };

  try {
    const buffer = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate() // honour the camera's orientation before the metadata goes
      .resize(SIZE, SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
    return { ok: true, buffer };
  } catch (cause) {
    console.warn('[onelink] avatar could not be processed:', cause?.message ?? cause);
    return { ok: false, error: 'avatar_invalid' };
  }
}

// Upload under a fresh random name. Returns the path to keep on the page.
export async function storeAvatar(pageId, buffer) {
  const path = `${pageId}/${randomToken(18)}.webp`;
  const { error } = await db().storage.from(AVATAR_BUCKET).upload(path, buffer, {
    contentType: 'image/webp',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(`avatar upload: ${error.message}`);
  return path;
}

// Best effort: a file left behind costs a few kilobytes, a thrown error here
// would fail an action that has otherwise succeeded.
export async function deleteAvatarFile(path) {
  if (!path) return;
  const { error } = await db().storage.from(AVATAR_BUCKET).remove([path]);
  if (error) console.warn('[onelink] avatar delete:', path, error.message);
}
