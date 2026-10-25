// A public page at /<slug>. The server inlines the page data; when it is not
// there (the shell served offline, or opened directly) it is fetched.
//
// Every link opens with rel="noopener noreferrer nofollow". Owner-written
// text only ever goes in through textContent.
//
// A redirect page shows where it is going for five seconds and then goes,
// the way go.gov.sg short links do: the visitor sees the full address first,
// can pause, go now, or report it, and the countdown waits while the report
// dialog is open or the tab is in the background.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { openModal, closeModal, withBusy, toast, copyText, el } from '../ui.js';
import { iconNode, hydrateIcons } from '../icons.js';
import { qrSvg, downloadQr } from '../qr.js';
import { fillAvatar } from '../avatar.js';
import { humanCheck } from '../turnstile.js';

const $ = (id) => document.getElementById(id);
const root = $('profile');
let data = null;
let reportTarget = null;
// Turnstile, loaded the first time the report form opens and not before:
// nothing from Cloudflare loads for someone who only reads the page.
let reportCheck = null;
const REDIRECT_SECONDS = 5;

function slugFromPath() {
  return window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
}

async function load() {
  try {
    data = JSON.parse($('pageData').textContent);
  } catch {
    data = { state: 'shell' };
  }
  if (data.state === 'shell') {
    try {
      const result = await api(`/api/public/page?slug=${encodeURIComponent(slugFromPath())}`);
      data = { state: 'active', page: result.page };
    } catch (error) {
      const state = { page_dormant: 'dormant', page_in_review: 'review', page_unavailable: 'banned', offline: 'offline' }[error.code];
      data = { state: state || 'missing', slug: slugFromPath() };
    }
  }
  render();
}

function pageUrl() {
  return `${window.location.origin}/${data.page.slug}`;
}

function render() {
  root.removeAttribute('aria-busy');
  root.replaceChildren();

  if (data.state !== 'active') {
    const COPY = {
      banned: ['profile.banned-title', 'profile.banned-body'],
      dormant: ['profile.dormant-title', 'profile.dormant-body'],
      review: ['profile.review-title', 'profile.review-body'],
      offline: ['profile.offline-title', 'profile.offline-body'],
      missing: ['profile.missing-title', 'profile.missing-body'],
    };
    const [title, body] = COPY[data.state] || COPY.missing;
    // A dormant page comes back when its owner signs in, so offer that.
    const signIn = data.state === 'dormant'
      ? el('a', { class: 'btn', href: `/login?slug=${encodeURIComponent(data.slug || '')}`, text: t('profile.dormant-sign-in') })
      : null;
    root.append(el('div', { class: 'glass-card page-card not-found u-mx-auto' }, [
      el('h1', { text: t(title) }),
      el('p', { text: t(body) }),
      el('div', { class: 'actions' }, [el('a', { class: 'btn btn-primary', href: '/', text: t('notfound.home') }), signIn]),
    ]));
    $('profileStatus')?.remove();
    return;
  }

  const page = data.page;
  countVisit();
  if (page.redirectUrl) return renderRedirect(page);
  const list = el('ul', { class: 'link-list' });
  for (const link of page.links) {
    const a = el('a', {
      class: 'glass-card link-btn',
      href: link.url,
      // An email link hands over to the mail app; a new tab would stay empty.
      target: link.url.startsWith('mailto:') ? null : '_blank',
      rel: 'noopener noreferrer nofollow',
    }, [iconNode(link.icon), el('span', { class: 'link-title', text: link.title })]);
    a.addEventListener('click', () => {
      // Counted on the side; the visitor's navigation never waits on it.
      api('/api/public/click', { method: 'POST', body: { id: link.id }, keepalive: true }).catch(() => {});
    });
    const flag = el('button', {
      class: 'icon-btn small link-more',
      type: 'button',
      'aria-label': t('report.link-named', { title: link.title }),
      title: t('report.link'),
      onclick: () => openReport(link),
    });
    flag.append(iconNode('flag'));
    list.append(el('li', { class: 'link-item' }, [a, flag]));
  }

  const share = el('button', { class: 'btn btn-small', type: 'button', onclick: openShare }, [iconNode('share'), el('span', { text: t('share.share') })]);
  const report = el('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => openReport(null) }, [iconNode('flag'), el('span', { text: t('report.page') })]);

  const avatar = el('div', { class: 'avatar', 'aria-hidden': 'true' });
  fillAvatar(avatar, page.avatarUrl, page.displayName);

  root.append(...[
    // Offline, the service worker serves the copy saved on an earlier visit.
    navigator.onLine === false ? el('p', { class: 'callout warn profile-saved', role: 'status', text: t('profile.saved-copy') }) : null,
    avatar,
    el('h1', { text: page.displayName }),
    el('p', { class: 'handle', text: `links.gftv.asia/${page.slug}` }),
    page.bio ? el('p', { class: 'bio', text: page.bio }) : null,
    page.links.length > 0 ? list : el('p', { class: 'profile-empty', text: t('profile.empty') }),
    el('div', { class: 'profile-actions' }, [share, report]),
    el('p', { class: 'profile-made' }, [
      el('span', { text: t('profile.made-with') }),
      ' ',
      el('a', { class: 'text-link', href: '/register', text: t('profile.make-own') }),
    ]),
  ].filter(Boolean));
  hydrateIcons(root);
  $('profileStatus')?.remove();
  keepForOffline();
}

// One visit per page load for the owner's insights, sent alongside so it
// never holds the page up. The server keeps daily totals only.
let visitCounted = false;
function countVisit() {
  if (visitCounted || navigator.onLine === false) return;
  visitCounted = true;
  api('/api/public/visit', { method: 'POST', body: { slug: data.page.slug, referrer: document.referrer }, keepalive: true }).catch(() => {});
}

// --- redirect -----------------------------------------------------------------

let countdown = null;

function renderRedirect(page) {
  const target = new URL(page.redirectUrl);
  const avatar = el('div', { class: 'avatar small', 'aria-hidden': 'true' });
  fillAvatar(avatar, page.avatarUrl, page.displayName);

  const ring = el('div', { class: 'countdown', 'aria-hidden': 'true' });
  ring.innerHTML = '<svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="20"/><circle class="progress" cx="22" cy="22" r="20" pathLength="100"/></svg>';
  const seconds = el('span', { class: 'countdown-number' });
  ring.append(seconds);
  const status = el('p', { class: 'redirect-status', role: 'status' });

  const go = el('a', { class: 'btn btn-primary', href: target.href, rel: 'noopener noreferrer nofollow' }, [iconNode('external'), el('span', { text: t('redirect.go-now') })]);
  const pause = el('button', { class: 'btn', type: 'button' });
  const report = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openReport(null) }, [iconNode('flag'), el('span', { text: t('report.page') })]);

  root.append(el('div', { class: 'glass-card redirect-card u-mx-auto' }, [
    el('div', { class: 'redirect-from' }, [avatar, el('div', {}, [
      el('div', { class: 'name', text: page.displayName }),
      el('div', { class: 'handle', text: `links.gftv.asia/${page.slug}` }),
    ])]),
    el('h1', { text: t('redirect.heading') }),
    el('p', { class: 'redirect-host', text: target.hostname.replace(/^www\./, '') }),
    el('p', { class: 'redirect-url', text: target.href }),
    ring,
    status,
    el('div', { class: 'actions' }, [go, pause, report]),
    el('p', { class: 'muted small', text: t('redirect.check-address') }),
  ]));
  hydrateIcons(root);
  $('profileStatus')?.remove();
  keepForOffline();

  // Elapsed time adds up only while running, so a pause holds the place.
  const state = countdown ?? { elapsed: 0, last: null, paused: false, held: new Set(), done: false };
  countdown = state;
  const total = REDIRECT_SECONDS * 1000;
  const running = () => !state.paused && state.held.size === 0 && !state.done;
  const paint = () => {
    const left = Math.max(0, Math.ceil((total - state.elapsed) / 1000));
    seconds.textContent = String(left);
    ring.style.setProperty('--progress', String(Math.min(100, (state.elapsed / total) * 100)));
    pause.replaceChildren(iconNode(state.paused ? 'play' : 'pause'), el('span', { text: t(state.paused ? 'redirect.resume' : 'redirect.pause') }));
    status.textContent = running() ? t('redirect.in', { count: left, n: left }) : t('redirect.paused');
  };
  const tick = (now) => {
    if (state.done) return;
    if (running()) {
      if (state.last !== null) state.elapsed += now - state.last;
      state.last = now;
      if (state.elapsed >= total) {
        state.done = true;
        paint();
        window.location.replace(target.href);
        return;
      }
    } else {
      state.last = null;
    }
    paint();
    state.frame = requestAnimationFrame(tick);
  };
  pause.addEventListener('click', () => {
    state.paused = !state.paused;
    paint();
  });
  state.hold = (reason, on) => {
    if (on) state.held.add(reason);
    else state.held.delete(reason);
  };
  if (!state.started) {
    state.started = true;
    document.addEventListener('visibilitychange', () => state.hold('hidden', document.hidden));
    state.hold('hidden', document.hidden);
  }
  // A re-render (a language switch) takes over from the previous loop.
  if (state.frame) cancelAnimationFrame(state.frame);
  state.last = null;
  paint();
  state.frame = requestAnimationFrame(tick);
}

// Ask the service worker to keep this page for offline viewing. Its own
// fetch handler saves every later visit; this covers the first one, which
// happened before the worker was installed.
let keptForOffline = false;
function keepForOffline() {
  if (keptForOffline || !('serviceWorker' in navigator) || navigator.onLine === false) return;
  keptForOffline = true;
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: 'keep-page', path: window.location.pathname, avatar: data.page?.avatarUrl || null }))
    .catch(() => {});
}

// --- share ------------------------------------------------------------------

function openShare() {
  $('shareQr').innerHTML = qrSvg(pageUrl(), t('share.qr-label', { slug: data.page.slug }));
  $('shareUrl').textContent = pageUrl().replace(/^https?:\/\//, '');
  $('shareNative').hidden = typeof navigator.share !== 'function';
  openModal('shareModal');
}
$('shareCopy').addEventListener('click', () => copyText(pageUrl()));
$('shareDownload').addEventListener('click', () => downloadQr(pageUrl(), `onelink-${data.page.slug}-qr.png`));
$('shareNative').addEventListener('click', () => {
  navigator.share({ title: data.page.displayName, url: pageUrl() }).catch(() => {});
});

// --- report -----------------------------------------------------------------

function openReport(link) {
  reportTarget = link;
  $('reportWhat').textContent = link
    ? t('report.about-link', { title: link.title })
    : t(data.page.redirectUrl ? 'report.about-redirect' : 'report.about-page', { slug: data.page.slug, url: data.page.redirectUrl });
  $('reportDetails').value = '';
  $('reportError').textContent = '';
  // A redirect waits while the visitor is reporting it.
  countdown?.hold('report', true);
  openModal('reportModal', { initialFocus: $('reportReason'), onClose: () => countdown?.hold('report', false) });
  reportCheck ??= humanCheck($('reportCheck'), 'report');
}

$('reportForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('reportSubmit'), $('reportError'), async () => {
    const turnstile = await reportCheck.token();
    try {
      await post('/api/public/report', {
        slug: data.page.slug,
        linkId: reportTarget ? reportTarget.id : null,
        reason: $('reportReason').value,
        details: $('reportDetails').value,
        turnstile,
      });
    } finally {
      reportCheck.reset();
    }
    closeModal('reportModal');
    toast(t('report.thanks'));
  });
});

onChange(() => { if (data) render(); });
load();
