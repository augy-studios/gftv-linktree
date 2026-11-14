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
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { openModal, closeModal, withBusy, toast, copyText, createElement } from '../ui.js';
import { iconNode, hydrateIcons } from '../icons.js';
import { qrSvg, downloadQr } from '../qr.js';
import { fillAvatar } from '../avatar.js';
import { humanCheck } from '../turnstile.js';

const byId = (id) => document.getElementById(id);
const root = byId('profile');
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
    data = JSON.parse(byId('pageData').textContent);
  } catch {
    data = { state: 'shell' };
  }
  if (data.state === 'shell') {
    try {
      const result = await api(`/api/public/page?slug=${encodeURIComponent(slugFromPath())}`);
      data = { state: 'active', page: result.page };
    } catch (error) {
      // Renamed: go to the page's name now.
      if (error.code === 'page_moved' && error.detail.slug) {
        window.location.replace(`/${error.detail.slug}`);
        return;
      }
      let state = { page_dormant: 'dormant', page_in_review: 'review', page_unavailable: 'banned', offline: 'offline' }[error.code];
      if (!state) {
        state = 'missing';
      }
      data = { state, slug: slugFromPath() };
    }
  }
  render();
}

function pageUrl() {
  return `${window.location.origin}/${data.page.slug}`;
}

// Draws the page. Anything but an active page gets a card saying why it
// cannot be shown; a redirect page gets the countdown (renderRedirect); any
// other page gets its picture, name, bio, links, and share and report buttons.
function render() {
  root.removeAttribute('aria-busy');
  root.replaceChildren();
  let footerTeam = null;
  if (data.state === 'active') {
    footerTeam = data.page.team;
  }
  footerTeamNote(footerTeam);

  if (data.state !== 'active') {
    const COPY = {
      banned: ['profile.banned-title', 'profile.banned-body'],
      dormant: ['profile.dormant-title', 'profile.dormant-body'],
      review: ['profile.review-title', 'profile.review-body'],
      offline: ['profile.offline-title', 'profile.offline-body'],
      missing: ['profile.missing-title', 'profile.missing-body'],
    };
    let copy = COPY[data.state];
    if (!copy) {
      copy = COPY.missing;
    }
    const [title, body] = copy;
    // A dormant page comes back when its owner signs in, so offer that.
    let signIn = null;
    if (data.state === 'dormant') {
      let slug = data.slug;
      if (!slug) {
        slug = '';
      }
      signIn = createElement('a', { class: 'btn', href: `/login?slug=${encodeURIComponent(slug)}`, text: translate('profile.dormant-sign-in') });
    }
    root.append(createElement('div', { class: 'glass-card page-card not-found u-mx-auto' }, [
      createElement('h1', { text: translate(title) }),
      createElement('p', { text: translate(body) }),
      createElement('div', { class: 'actions' }, [createElement('a', { class: 'btn btn-primary', href: '/', text: translate('notfound.home') }), signIn]),
    ]));
    const profileStatus = byId('profileStatus');
    if (profileStatus) {
      profileStatus.remove();
    }
    return;
  }

  const page = data.page;
  countVisit();
  if (page.redirectUrl) {
    return renderRedirect(page);
  }
  const list = createElement('ul', { class: 'link-list' });
  for (const link of page.links) {
    // An email link hands over to the mail app; a new tab would stay empty.
    let linkTarget;
    if (link.url.startsWith('mailto:')) {
      linkTarget = null;
    } else {
      linkTarget = '_blank';
    }
    const linkButton = createElement('a', {
      class: 'glass-card link-btn',
      href: link.url,
      target: linkTarget,
      rel: 'noopener noreferrer nofollow',
    }, [iconNode(link.icon), createElement('span', { class: 'link-title', text: link.title })]);
    linkButton.addEventListener('click', () => {
      // Counted on the side; the visitor's navigation never waits on it.
      api('/api/public/click', { method: 'POST', body: { id: link.id }, keepalive: true }).catch(() => {});
    });
    const flag = createElement('button', {
      class: 'icon-btn small link-more',
      type: 'button',
      'aria-label': translate('report.link-named', { title: link.title }),
      title: translate('report.link'),
      onclick: () => openReport(link),
    });
    flag.append(iconNode('flag'));
    list.append(createElement('li', { class: 'link-item' }, [linkButton, flag]));
  }

  const share = createElement('button', { class: 'btn btn-small', type: 'button', onclick: openShare }, [iconNode('share'), createElement('span', { text: translate('share.share') })]);
  const report = createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => openReport(null) }, [iconNode('flag'), createElement('span', { text: translate('report.page') })]);

  const avatar = createElement('div', { class: 'avatar', 'aria-hidden': 'true' });
  fillAvatar(avatar, page.avatarUrl, page.displayName);

  // Offline, the service worker serves the copy saved on an earlier visit.
  let savedCopy = null;
  if (navigator.onLine === false) {
    savedCopy = createElement('p', { class: 'callout warn profile-saved', role: 'status', text: translate('profile.saved-copy') });
  }
  let bio = null;
  if (page.bio) {
    bio = createElement('p', { class: 'bio', text: page.bio });
  }
  let linksOrEmpty;
  if (page.links.length > 0) {
    linksOrEmpty = list;
  } else {
    linksOrEmpty = createElement('p', { class: 'profile-empty', text: translate('profile.empty') });
  }

  // The parts left out above are null, and filtered out here.
  root.append(...[
    savedCopy,
    teamAvatar(avatar, page.team),
    createElement('h1', { text: page.displayName }),
    createElement('p', { class: 'handle', text: `links.gftv.asia/${page.slug}` }),
    teamNote(page.team),
    bio,
    linksOrEmpty,
    createElement('div', { class: 'profile-actions' }, [share, report]),
    createElement('p', { class: 'profile-made' }, [
      createElement('span', { text: translate('profile.made-with') }),
      ' ',
      createElement('a', { class: 'text-link', href: '/register', text: translate('profile.make-own') }),
    ]),
  ].filter(Boolean));
  hydrateIcons(root);
  const profileStatus = byId('profileStatus');
  if (profileStatus) {
    profileStatus.remove();
  }
  keepForOffline();
}

// --- GFTV team ----------------------------------------------------------------
//
// A page an admin has marked as someone on the GFTV team gets a ring and a
// tick on its picture, a label under the name, and a note at the top of the
// footer saying what the mark means; the label jumps to the note. The mark comes from the server, never from anything the owner
// typed or uploaded, so it is a way for anyone to check that a person is on
// the team.

function teamLabel(team) {
  if (team.role) {
    return translate('team.label-role', { role: team.role });
  }
  return translate('team.label');
}

function teamAvatar(avatar, team, small = false) {
  if (!team) {
    return avatar;
  }
  const tick = createElement('span', { class: 'team-tick', 'aria-hidden': 'true' }, [iconNode('check')]);
  let sizeClass = '';
  if (small) {
    sizeClass = ' small';
  }
  return createElement('div', { class: `avatar-wrap team${sizeClass}`, title: translate('team.label') }, [avatar, tick]);
}

function teamNote(team) {
  if (!team) {
    return null;
  }
  return createElement('p', { class: 'team-note' }, [
    createElement('a', { class: 'team-pill', href: '#teamNote', onclick: jumpToTeamNote }, [iconNode('check'), createElement('span', { text: teamLabel(team) })]),
  ]);
}

// Down to the note, gently unless the visitor asked for less motion, and
// focus it so a screen reader reads it next.
function jumpToTeamNote(event) {
  const note = document.getElementById('teamNote');
  if (!note) {
    return;
  }
  event.preventDefault();
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scrollBehavior;
  if (still) {
    scrollBehavior = 'auto';
  } else {
    scrollBehavior = 'smooth';
  }
  note.scrollIntoView({ behavior: scrollBehavior, block: 'center' });
  note.focus({ preventScroll: true });
}

// The explanation, at the top of the footer. Replaced on every render (a
// language change redraws the page) and removed when there is no mark.
function footerTeamNote(team) {
  const oldNote = document.getElementById('teamNote');
  if (oldNote) {
    oldNote.remove();
  }
  if (!team) {
    return;
  }
  // No page language means the browser's own.
  let locale = document.documentElement.lang;
  if (!locale) {
    locale = undefined;
  }
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(team.verifiedAt));
  const note = createElement('p', { class: 'footer-team-note', id: 'teamNote', tabindex: '-1' }, [
    createElement('span', { class: 'footer-team-mark', 'aria-hidden': 'true' }, [iconNode('check')]),
    ' ',
    translate('team.explain', { date: when }),
    ' ',
    createElement('a', { href: '/team', text: translate('team.see-all') }),
  ]);
  const footer = document.querySelector('.site-footer');
  if (footer) {
    footer.prepend(note);
  }
}

// One visit per page load for the owner's insights, sent alongside so it
// never holds the page up. The server keeps daily totals only.
let visitCounted = false;
function countVisit() {
  if (visitCounted || navigator.onLine === false) {
    return;
  }
  visitCounted = true;
  api('/api/public/visit', { method: 'POST', body: { slug: data.page.slug, referrer: document.referrer }, keepalive: true }).catch(() => {});
}

// --- redirect -----------------------------------------------------------------

let countdown = null;

// Draws a redirect page (where it goes, a ring counting down, go now, pause
// and report) and runs the countdown on animation frames. The countdown's
// state lives in `countdown`, outside the render, so a language switch redraws
// without restarting it; hold() pauses it while the tab is hidden or the
// report dialog is open.
function renderRedirect(page) {
  const target = new URL(page.redirectUrl);
  const avatar = createElement('div', { class: 'avatar small', 'aria-hidden': 'true' });
  fillAvatar(avatar, page.avatarUrl, page.displayName);

  const ring = createElement('div', { class: 'countdown', 'aria-hidden': 'true' });
  ring.innerHTML = '<svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="20"/><circle class="progress" cx="22" cy="22" r="20" pathLength="100"/></svg>';
  const seconds = createElement('span', { class: 'countdown-number' });
  ring.append(seconds);
  const status = createElement('p', { class: 'redirect-status', role: 'status' });

  const go = createElement('a', { class: 'btn btn-primary', href: target.href, rel: 'noopener noreferrer nofollow' }, [iconNode('external'), createElement('span', { text: translate('redirect.go-now') })]);
  const pause = createElement('button', { class: 'btn', type: 'button' });
  const report = createElement('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openReport(null) }, [iconNode('flag'), createElement('span', { text: translate('report.page') })]);

  let teamLine = null;
  if (page.team) {
    teamLine = createElement('div', { class: 'team-inline' }, [iconNode('check'), createElement('span', { text: teamLabel(page.team) })]);
  }
  root.append(createElement('div', { class: 'glass-card redirect-card u-mx-auto' }, [
    createElement('div', { class: 'redirect-from' }, [teamAvatar(avatar, page.team, true), createElement('div', {}, [
      createElement('div', { class: 'name', text: page.displayName }),
      createElement('div', { class: 'handle', text: `links.gftv.asia/${page.slug}` }),
      teamLine,
    ])]),
    createElement('h1', { text: translate('redirect.heading') }),
    createElement('p', { class: 'redirect-host', text: target.hostname.replace(/^www\./, '') }),
    createElement('p', { class: 'redirect-url', text: target.href }),
    ring,
    status,
    createElement('div', { class: 'actions' }, [go, pause, report]),
    createElement('p', { class: 'muted small', text: translate('redirect.check-address') }),
  ]));
  hydrateIcons(root);
  const profileStatus = byId('profileStatus');
  if (profileStatus) {
    profileStatus.remove();
  }
  keepForOffline();

  // Elapsed time adds up only while running, so a pause holds the place.
  if (countdown === null || countdown === undefined) {
    countdown = { elapsed: 0, last: null, paused: false, held: new Set(), done: false };
  }
  const state = countdown;
  const total = REDIRECT_SECONDS * 1000;
  // Running unless paused, held (tab hidden or report open) or already gone.
  const running = () => {
    if (!state.paused && state.held.size === 0 && !state.done) {
      return true;
    }
    return false;
  };
  const paint = () => {
    const left = Math.max(0, Math.ceil((total - state.elapsed) / 1000));
    seconds.textContent = String(left);
    ring.style.setProperty('--progress', String(Math.min(100, (state.elapsed / total) * 100)));
    let pauseIcon;
    let pauseLabel;
    if (state.paused) {
      pauseIcon = 'play';
      pauseLabel = 'redirect.resume';
    } else {
      pauseIcon = 'pause';
      pauseLabel = 'redirect.pause';
    }
    pause.replaceChildren(iconNode(pauseIcon), createElement('span', { text: translate(pauseLabel) }));
    if (running()) {
      status.textContent = translate('redirect.in', { count: left, n: left });
    } else {
      status.textContent = translate('redirect.paused');
    }
  };
  // One animation frame: add the time since the last frame while running,
  // and go once the full time has passed.
  const tick = (now) => {
    if (state.done) {
      return;
    }
    if (running()) {
      if (state.last !== null) {
        state.elapsed += now - state.last;
      }
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
  // Each reason to wait (the tab hidden, the report dialog open) is added or
  // taken away on its own; the countdown runs only when none is left.
  state.hold = (reason, on) => {
    if (on) {
      state.held.add(reason);
    } else {
      state.held.delete(reason);
    }
  };
  if (!state.started) {
    state.started = true;
    document.addEventListener('visibilitychange', () => state.hold('hidden', document.hidden));
    state.hold('hidden', document.hidden);
  }
  // A re-render (a language switch) takes over from the previous loop.
  if (state.frame) {
    cancelAnimationFrame(state.frame);
  }
  state.last = null;
  paint();
  state.frame = requestAnimationFrame(tick);
}

// Ask the service worker to keep this page for offline viewing. Its own
// fetch handler saves every later visit; this covers the first one, which
// happened before the worker was installed.
let keptForOffline = false;
function keepForOffline() {
  if (keptForOffline || !('serviceWorker' in navigator) || navigator.onLine === false) {
    return;
  }
  keptForOffline = true;
  navigator.serviceWorker.ready
    .then((registration) => {
      const worker = registration.active;
      if (worker === null || worker === undefined) {
        return;
      }
      // The picture too, when the page has one.
      const page = data.page;
      let avatarUrl;
      if (page !== null && page !== undefined) {
        avatarUrl = page.avatarUrl;
      }
      if (!avatarUrl) {
        avatarUrl = null;
      }
      worker.postMessage({ type: 'keep-page', path: window.location.pathname, avatar: avatarUrl });
    })
    .catch(() => {});
}

// --- share ------------------------------------------------------------------

function openShare() {
  byId('shareQr').innerHTML = qrSvg(pageUrl(), translate('share.qr-label', { slug: data.page.slug }));
  byId('shareUrl').textContent = pageUrl().replace(/^https?:\/\//, '');
  byId('shareNative').hidden = typeof navigator.share !== 'function';
  openModal('shareModal');
}
byId('shareCopy').addEventListener('click', () => copyText(pageUrl()));
byId('shareDownload').addEventListener('click', () => downloadQr(pageUrl(), `onelink-${data.page.slug}-qr.png`));
byId('shareNative').addEventListener('click', () => {
  navigator.share({ title: data.page.displayName, url: pageUrl() }).catch(() => {});
});

// --- report -----------------------------------------------------------------

function openReport(link) {
  reportTarget = link;
  // What is being reported: one link, or the whole page (a redirect names
  // where it goes).
  let about;
  if (link) {
    about = translate('report.about-link', { title: link.title });
  } else {
    let aboutKey;
    if (data.page.redirectUrl) {
      aboutKey = 'report.about-redirect';
    } else {
      aboutKey = 'report.about-page';
    }
    about = translate(aboutKey, { slug: data.page.slug, url: data.page.redirectUrl });
  }
  byId('reportWhat').textContent = about;
  byId('reportDetails').value = '';
  byId('reportError').textContent = '';
  // A redirect waits while the visitor is reporting it.
  if (countdown !== null && countdown !== undefined) {
    countdown.hold('report', true);
  }
  openModal('reportModal', {
    initialFocus: byId('reportReason'),
    onClose: () => {
      if (countdown !== null && countdown !== undefined) {
        countdown.hold('report', false);
      }
    },
  });
  if (reportCheck === null || reportCheck === undefined) {
    reportCheck = humanCheck(byId('reportCheck'));
  }
}

byId('reportForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('reportSubmit'), byId('reportError'), async () => {
    const token = await reportCheck.token();
    try {
      // The link being reported, or null for the whole page.
      let linkId = null;
      if (reportTarget) {
        linkId = reportTarget.id;
      }
      await post('/api/public/report', {
        slug: data.page.slug,
        linkId,
        reason: byId('reportReason').value,
        details: byId('reportDetails').value,
        'cf-turnstile-response': token,
      });
    } finally {
      reportCheck.reset();
    }
    closeModal('reportModal');
    toast(translate('report.thanks'));
  });
});

onChange(() => {
  if (data) {
    render();
  }
});
load();
