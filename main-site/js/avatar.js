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
    let fullName = '';
    if (name) {
      fullName = name;
    }
    // Spread by code point, so a first letter outside the BMP (an emoji) stays whole.
    let firstLetter = [...String(fullName).trim()][0];
    if (!firstLetter) {
      firstLetter = '?';
    }
    container.textContent = firstLetter;
  };
  if (!url) {
    return letter();
  }
  const image = document.createElement('img');
  image.alt = '';
  image.width = 256;
  image.height = 256;
  image.decoding = 'async';
  image.crossOrigin = 'anonymous';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', letter, { once: true });
  setBlobSrc(image, url);
  container.classList.add('has-image');
  container.appendChild(image);
}
