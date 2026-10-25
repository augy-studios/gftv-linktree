// A public page at /<slug>. The server inlines the page data; when it is not
// there (the shell served offline, or opened directly) it is fetched.
//
// Every link opens with rel="noopener noreferrer nofollow". Owner-written
// text only ever goes in through textContent.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { openModal, closeModal, withBusy, toast, copyText, el } from '../ui.js';
import { iconNode, hydrateIcons } from '../icons.js';
import { qrSvg, downloadQr } from '../qr.js';

const $ = (id) => document.getElementById(id);
const root = $('profile');
let data = null;
let reportTarget = null;

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
      data = { state: error.status === 410 ? 'banned' : error.code === 'offline' ? 'offline' : 'missing', slug: slugFromPath() };
    }
  }
  render();
}

function firstLetter(name) {
  const [first] = [...String(name || '').trim()];
  return first || '?';
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
      offline: ['profile.offline-title', 'profile.offline-body'],
      missing: ['profile.missing-title', 'profile.missing-body'],
    };
    const [title, body] = COPY[data.state] || COPY.missing;
    root.append(el('div', { class: 'glass-card page-card not-found u-mx-auto' }, [
      el('h1', { text: t(title) }),
      el('p', { text: t(body) }),
      el('div', { class: 'actions' }, [el('a', { class: 'btn btn-primary', href: '/', text: t('notfound.home') })]),
    ]));
    $('profileStatus')?.remove();
    return;
  }

  const page = data.page;
  const list = el('ul', { class: 'link-list' });
  for (const link of page.links) {
    const a = el('a', {
      class: 'glass-card link-btn',
      href: link.url,
      target: '_blank',
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

  root.append(...[
    el('div', { class: 'avatar', 'aria-hidden': 'true', text: firstLetter(page.displayName) }),
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
    : t('report.about-page', { slug: data.page.slug });
  $('reportDetails').value = '';
  $('reportError').textContent = '';
  openModal('reportModal', { initialFocus: $('reportReason') });
}

$('reportForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('reportSubmit'), $('reportError'), async () => {
    await post('/api/public/report', {
      slug: data.page.slug,
      linkId: reportTarget ? reportTarget.id : null,
      reason: $('reportReason').value,
      details: $('reportDetails').value,
    });
    closeModal('reportModal');
    toast(t('report.thanks'));
  });
});

onChange(() => { if (data) render(); });
load();
