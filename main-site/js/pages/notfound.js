// 404: when the missing address is shaped like a page name, offer it.

import '../app.js';

const path = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
if (/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/.test(path)) {
  const claim = document.querySelector('a[href="/register"]');
  if (claim) claim.href = `/register?slug=${encodeURIComponent(path)}`;
}
