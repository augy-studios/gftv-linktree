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

const VERSION = '2026-10-25.2';
const PREFIX = 'gftv-onelink-';
const CACHE = PREFIX + VERSION;

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
  '/js/ui.js',
  '/js/api.js',
  '/js/update-bar.js',
  '/js/passkeys.js',
  '/js/qr.js',
  '/js/codes.js',
  '/js/slug-check.js',
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
});

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
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    const key = pageKey(url);

    // Shell pages: from the precache, so they open instantly and offline.
    if (SHELL_PAGES.has(key)) {
      event.respondWith(
        caches.open(CACHE).then(async (cache) => (await cache.match(key)) || fetch(req))
      );
      return;
    }

    // Public pages: the network first, then the shell, which says it is
    // offline when it cannot fetch the page itself.
    if (SLUG_PATH.test(key)) {
      event.respondWith(
        fetch(req).catch(async () => {
          const cache = await caches.open(CACHE);
          return (await cache.match('/shell/profile')) || Response.error();
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
