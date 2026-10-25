// OneLink GFTV service worker.
//
// Precaches the app shell, and never activates a new version on its own: it
// installs, then waits until the page sends "skip-waiting" from the update
// bar. See update-bar-spec.md. `npm run check-sw` fails the build if
// skipWaiting() or clients.claim() appears anywhere outside that handler.
//
// Bump VERSION on every deploy that changes anything below or anything in
// PRECACHE. The browser compares this file byte for byte; if nothing here
// changes, nobody is told.
//
// What is never cached: /api/ (answers are per person and change), and other
// origins (Google Analytics). Public pages at /<slug> are network first, so a
// visitor always sees the owner's latest links when online.
//
// Offline viewing of public pages: every page a visitor opens is saved in
// SAVED_PAGES (the last 30), and profile pictures in AVATARS (the last 60).
// Those two caches are not tied to VERSION, so a deploy does not empty a
// visitor's saved pages. A page that has been taken down or deleted is
// dropped from the saved copies the next time it is fetched.

const VERSION = '2026-10-25.29';
const PREFIX = 'gftv-onelink-';
const CACHE = PREFIX + VERSION;
const SAVED_PAGES = 'onelink-saved-pages-v1';
const AVATARS = 'onelink-avatars-v1';
const MAX_SAVED_PAGES = 30;
const MAX_AVATARS = 60;
// Profile pictures, from the public bucket in migrations/002. Their names are
// random and never reused, so a cached copy never goes stale.
const AVATAR_PATH = '/storage/v1/object/public/gftvonelink_avatars/';

const PRECACHE = [
  '/',
  '/register',
  '/login',
  '/reset',
  '/edit',
  '/admin',
  '/404.html',
  '/shell/profile',
  '/style.css',
  '/manifest.json',
  '/favicon.ico',
  '/gftv-flag.png',
  '/OLG-180.png',
  '/OLG-192.png',
  '/OLG-512.png',
  '/assets/fonts/ProximaNova-Regular.woff2',
  '/assets/i18n/i18n.js',
  '/assets/i18n/locales.js',
  '/assets/i18n/switcher.js',
  '/assets/i18n/boot.js',
  '/assets/i18n/en.json',
  '/assets/i18n/zh.json',
  '/js/prepaint.js',
  '/js/official-bar.js',
  '/js/analytics.js',
  '/js/app.js',
  '/js/theme.js',
  '/js/icons.js',
  '/js/icon-data.js',
  '/js/platforms.js',
  '/js/ui.js',
  '/js/api.js',
  '/js/update-bar.js',
  '/js/passkeys.js',
  '/js/qr.js',
  '/js/codes.js',
  '/js/slug-check.js',
  '/js/avatar.js',
  '/js/blob-image.js',
  '/js/insights.js',
  '/js/regex-maker.js',
  '/js/avatar-composer.js',
  '/js/colour-wheel.js',
  '/js/bg-removal-worker.js',
  '/js/password-toggle.js',
  '/js/vendor/qrcode.js',
  '/js/pages/home.js',
  '/js/pages/register.js',
  '/js/pages/login.js',
  '/js/pages/reset.js',
  '/js/pages/edit.js',
  '/js/pages/admin.js',
  '/js/pages/profile.js',
  '/js/pages/notfound.js',
];

// The pages that are part of the shell, by their clean path.
const SHELL_PAGES = new Set(['/', '/register', '/login', '/reset', '/edit', '/admin']);
const SLUG_PATH = /^\/[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/;

// A redirected response cannot be served to a navigation, so store a clean copy.
async function fetchForCache(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
  if (!res.redirected) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(await res.blob(), { status: 200, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(PRECACHE.map(async (url) => cache.put(url, await fetchForCache(url))));
    })
  );
  // No skipWaiting() here. The update bar asks for it.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  // No clients.claim() here either; see the message handler.
});

self.addEventListener('message', (event) => {
  const type = typeof event.data === 'string' ? event.data : event.data?.type;

  // The only place either of these is ever called.
  if (type === 'skip-waiting') {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }

  // A public page asking to be kept for offline viewing: its first visit
  // happened before this worker was there to save it.
  if (type === 'keep-page' && typeof event.data.path === 'string' && SLUG_PATH.test(event.data.path)) {
    event.waitUntil(keepPage(event.data.path, event.data.avatar));
  }
});

// Keep at most max entries, dropping the oldest first.
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

// Save a public page's response, or forget it when the page is gone.
async function savePage(path, res) {
  const cache = await caches.open(SAVED_PAGES);
  if (res.ok && !res.redirected) {
    await cache.delete(path); // re-adding moves it to the newest end
    await cache.put(path, res);
    await trim(SAVED_PAGES, MAX_SAVED_PAGES);
  } else if (res.status === 404 || res.status === 410) {
    await cache.delete(path);
  }
}

function isAvatar(url) {
  return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') && url.pathname.startsWith(AVATAR_PATH);
}

async function saveAvatar(request, res) {
  if (!res.ok || res.type === 'opaque') return;
  const cache = await caches.open(AVATARS);
  await cache.put(request, res);
  await trim(AVATARS, MAX_AVATARS);
}

async function keepPage(path, avatar) {
  try {
    const res = await fetch(path, { credentials: 'same-origin' });
    await savePage(path, res);
    if (typeof avatar === 'string') {
      const url = new URL(avatar);
      if (isAvatar(url) && !(await caches.match(url.href))) {
        const req = new Request(url.href, { mode: 'cors', credentials: 'omit' });
        await saveAvatar(req, await fetch(req));
      }
    }
  } catch {
    /* offline or refused: the next visit saves it instead */
  }
}

// /edit, /edit/ and /edit.html are the same page.
function pageKey(url) {
  let path = url.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Profile pictures: cache first, kept for offline viewing.
  if (isAvatar(url)) {
    event.respondWith(
      caches.open(AVATARS).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        event.waitUntil(saveAvatar(req, res.clone()));
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // The background remover's model and runtime (about 57 MB) are only for
  // people editing a picture. The worker keeps the model in its own cache, and
  // the browser's HTTP cache holds the runtime; copying them here would only
  // double the space used.
  if (url.pathname.startsWith('/assets/models/') || url.pathname.startsWith('/assets/vendor/ort/')) return;

  if (req.mode === 'navigate') {
    const key = pageKey(url);

    // Shell pages: from the precache, so they open instantly and offline.
    if (SHELL_PAGES.has(key)) {
      event.respondWith(
        caches.open(CACHE).then(async (cache) => (await cache.match(key)) || fetch(req))
      );
      return;
    }

    // Public pages: the network first, saving each one for offline. With
    // no network, the saved copy; failing that, the shell, which says the
    // page needs a connection.
    if (SLUG_PATH.test(key)) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            event.waitUntil(savePage(key, res.clone()));
            return res;
          })
          .catch(async () => {
            const saved = await (await caches.open(SAVED_PAGES)).match(key);
            if (saved) return saved;
            return (await (await caches.open(CACHE)).match('/shell/profile')) || Response.error();
          })
      );
      return;
    }

    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match('/404.html')) || Response.error();
      })
    );
    return;
  }

  // Everything else on this origin: cache first, then network, keeping a
  // copy of anything new so it is there next time.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && !res.redirected) cache.put(req, res.clone());
      return res;
    })
  );
});
