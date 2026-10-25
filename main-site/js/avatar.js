// Showing a profile picture. Choosing, framing and compressing one is in
// js/avatar-composer.js.

import { setBlobSrc } from './blob-image.js';

// Fill an .avatar circle with the picture, or the name's first letter when
// there is none or it fails to load. The picture is decorative: the name sits
// right beside it, so it has an empty alt. It is shown from a blob: URL (see
// js/blob-image.js); crossorigin covers the plain address it falls back to,
// so the service worker can still keep a readable copy for offline viewing.
export function fillAvatar(container, url, name) {
  container.replaceChildren();
  const letter = () => {
    container.classList.remove('has-image');
    container.textContent = [...String(name || '').trim()][0] || '?';
  };
  if (!url) return letter();
  const img = document.createElement('img');
  img.alt = '';
  img.width = 256;
  img.height = 256;
  img.decoding = 'async';
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', letter, { once: true });
  setBlobSrc(img, url);
  container.classList.add('has-image');
  container.appendChild(img);
}
