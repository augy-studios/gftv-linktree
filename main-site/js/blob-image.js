// Images are shown from blob: URLs. Each address is fetched once, and the
// <img> is given an object URL for the bytes rather than the address itself.
//
// Markup and js/official-bar.js give the address as data-src, which
// hydrateImages turns into a blob: src. Code that builds an <img> calls
// setBlobSrc directly. The fetch goes through the service worker like any
// image request, so offline copies keep working.

// address -> Promise of its object URL. Kept for the life of the page, so the
// same picture shown twice is fetched and stored once.
const loaded = new Map();

function blobUrl(url) {
  if (!loaded.has(url)) {
    const job = fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(async (res) => {
      if (!res.ok) throw new Error(`image ${res.status}`);
      return URL.createObjectURL(await res.blob());
    });
    // A failure is not remembered, so the next try fetches again.
    job.catch(() => loaded.delete(url));
    loaded.set(url, job);
  }
  return loaded.get(url);
}

// When the fetch fails, the plain address is used instead, so the image
// still shows and its own error handling still runs.
export function setBlobSrc(img, url) {
  return blobUrl(url).then(
    (objectUrl) => { img.src = objectUrl; },
    () => { img.src = url; }
  );
}

export function hydrateImages(root = document) {
  root.querySelectorAll('img[data-src]').forEach((img) => {
    const url = img.dataset.src;
    img.removeAttribute('data-src');
    setBlobSrc(img, url);
  });
}
