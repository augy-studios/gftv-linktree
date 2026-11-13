// The page editor: links (or a redirect), profile, sharing, stats and security.

import '../app.js';
import '../visitor.js';
import { t as translate, onChange, getLocale } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { openModal, closeModal, withBusy, toast, copyText, createElement, formatNumber, formatDate, errorText, setBusy } from '../ui.js';
import { icon, iconNode, ICON_CATEGORIES, brandTitle, guessIcon } from '../icons.js';
import { PLATFORMS, PLATFORM_CATEGORIES, platformById, matchPlatform, cleanUsername, buildUrl, usernameOk } from '../platforms.js';
import { qrSvg, downloadQr } from '../qr.js';
import { showCodes } from '../codes.js';
import { passkeysSupported, createPasskey, passkeyErrorCode } from '../passkeys.js';
import { fillAvatar } from '../avatar.js';
import { editAvatar } from '../avatar-composer.js';
import { drawColumns, fillBarList, dayLabel } from '../insights.js';
import { wireSlugCheck, normaliseSlugInput } from '../slug-check.js';

const byId = (id) => document.getElementById(id);
let page = null;

// What a platform is called in the current language (platforms.js).
const platformName = (p) => translate(`platform.${p.id}`);

function pageUrl() {
  return `${window.location.origin}/${page.slug}`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function view(name) {
  byId('editorLoading').hidden = name !== 'loading';
  byId('editorSignedOut').hidden = name !== 'signedOut';
  byId('editorBanned').hidden = name !== 'banned';
  byId('editorReady').hidden = name !== 'ready';
  byId('signOut').hidden = name !== 'ready';
}

async function load() {
  try {
    const data = await api('/api/me/page');
    page = data.page;
    view('ready');
    render();
    loadOwnQuote();
  } catch (error) {
    if (error.code === 'page_banned') view('banned');
    else if (error.status === 401) view('signedOut');
    else {
      view('signedOut');
      toast(errorText(error));
    }
  }
}

function setPage(next) {
  if (next) page = next;
  render();
}

function render() {
  if (!page) return;
  const url = pageUrl();
  byId('pageUrl').textContent = url.replace(/^https?:\/\//, '');
  byId('pageUrl').href = url;
  byId('viewPage').href = url;
  byId('reviewNotice').hidden = !page.awaitingReview;
  byId('quarantineNotice').hidden = !page.quarantined;
  renderRedirect();
  renderLinks();
  renderProfile();
  renderShare();
  renderSecurity();
  renderStats();
  renderOwnQuote();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];

function selectTab(tab, focus = false) {
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute('aria-selected', String(on));
    other.tabIndex = on ? 0 : -1;
    byId(other.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  // Stats are fetched when first looked at, not with the page.
  if (tab.id === 'tab-stats' && !stats) loadStats();
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const rtl = document.documentElement.dir === 'rtl';
    if (step) {
      e.preventDefault();
      selectTab(tabs[(i + (rtl ? -step : step) + tabs.length) % tabs.length], true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      selectTab(tabs[0], true);
    } else if (e.key === 'End') {
      e.preventDefault();
      selectTab(tabs[tabs.length - 1], true);
    }
  });
});

// ---------------------------------------------------------------------------
// Redirect
//
// The switch opens the address field; saving it turns the redirect on.
// Switching off a redirect that is on saves straight away.
// ---------------------------------------------------------------------------

let redirectOpen = false;

function renderRedirect() {
  const on = Boolean(page.redirectUrl);
  const form = byId('redirectForm');
  byId('redirectToggle').checked = on || redirectOpen;
  form.hidden = !(on || redirectOpen);
  if (on && document.activeElement !== byId('redirectUrl')) byId('redirectUrl').value = page.redirectUrl;
  byId('redirectState').textContent = on ? translate('redirect.on', { url: page.redirectUrl.replace(/^https?:\/\//, '') }) : translate('redirect.off');
  byId('redirectSave').querySelector('span').textContent = translate(on ? 'redirect.update' : 'redirect.save');
  byId('redirectLinksNote').hidden = !on;
}

byId('redirectToggle').addEventListener('change', (e) => {
  byId('redirectError').textContent = '';
  if (e.target.checked) {
    redirectOpen = true;
    renderRedirect();
    byId('redirectUrl').focus();
    return;
  }
  redirectOpen = false;
  if (!page.redirectUrl) return renderRedirect();
  withBusy(byId('redirectSave'), byId('redirectError'), async () => {
    try {
      const data = await api('/api/me/page', { method: 'PATCH', body: { redirectUrl: '' } });
      setPage(data.page);
      toast(translate('redirect.turned-off'));
    } catch (error) {
      renderRedirect();
      throw error;
    }
  });
});

byId('redirectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('redirectSave'), byId('redirectError'), async () => {
    const data = await api('/api/me/page', { method: 'PATCH', body: { redirectUrl: byId('redirectUrl').value } });
    redirectOpen = false;
    byId('redirectUrl').blur();
    setPage(data.page);
    toast(translate('redirect.turned-on'));
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function renderLinks() {
  renderLinkCap();
  const list = byId('linkList');
  list.replaceChildren();
  byId('linksEmpty').hidden = page.links.length > 0;
  const movable = page.links.filter((l) => !l.removed);

  page.links.forEach((link) => {
    const index = movable.indexOf(link);
    const up = createElement('button', {
      class: 'icon-btn small', type: 'button', 'aria-label': translate('link.move-up', { title: link.title }),
      disabled: link.removed || index <= 0, onclick: () => move(link, -1),
    });
    up.innerHTML = icon('arrow-up');
    const down = createElement('button', {
      class: 'icon-btn small', type: 'button', 'aria-label': translate('link.move-down', { title: link.title }),
      disabled: link.removed || index < 0 || index >= movable.length - 1, onclick: () => move(link, 1),
    });
    down.innerHTML = icon('arrow-down');

    const title = createElement('div', { class: 'title' }, [iconNode(link.icon), createElement('span', { text: link.title })]);
    if (link.removed) title.append(createElement('span', { class: 'badge danger', text: translate('link.removed') }));
    else if (!link.isActive) title.append(createElement('span', { class: 'badge', text: translate('link.hidden') }));

    const meta = createElement('div', { class: 'meta' }, [
      title,
      createElement('div', { class: 'url', text: link.url }),
      createElement('div', { class: 'stats', text: link.removed ? translate('link.removed-reason', { reason: link.removedReason || translate('link.removed-no-reason') }) : translate('link.clicks', { count: link.clicks, n: formatNumber(link.clicks) }) }),
    ]);

    const controls = createElement('div', { class: 'controls' });
    if (!link.removed) {
      const toggle = createElement('label', { class: 'switch', title: translate('link.show') });
      const box = createElement('input', { type: 'checkbox', 'aria-label': translate('link.show-named', { title: link.title }) });
      box.checked = link.isActive;
      box.addEventListener('change', () => saveLink({ id: link.id, isActive: box.checked }, 'PATCH'));
      toggle.append(box, createElement('span', { class: 'track', 'aria-hidden': 'true' }));
      const edit = createElement('button', { class: 'icon-btn small', type: 'button', 'aria-label': translate('link.edit-named', { title: link.title }), onclick: () => openLinkModal(link) });
      edit.innerHTML = icon('edit');
      const remove = createElement('button', { class: 'icon-btn small', type: 'button', 'aria-label': translate('link.delete-named', { title: link.title }), onclick: () => deleteLink(link) });
      remove.innerHTML = icon('trash');
      controls.append(toggle, edit, remove);
    }

    list.append(createElement('li', { class: `edit-link${link.isActive && !link.removed ? '' : ' off'}` }, [
      createElement('div', { class: 'order' }, [up, down]),
      meta,
      controls,
    ]));
  });
}

// Every answer from /api/me/links is the whole list, and the limit with it.
function takeLinks(data) {
  page.links = data.links;
  if (data.linkCap) page.linkCap = data.linkCap;
}

// A refusal for being at the limit says what the limit is now, which may be
// lower than when the editor loaded.
function noteLimit(error) {
  if (error?.code === 'too_many_links' && page.linkCap && Number.isInteger(error.detail?.limit)) {
    page.linkCap.limit = error.detail.limit;
    renderLinks();
  }
}

async function saveLink(body, method) {
  try {
    takeLinks(await api('/api/me/links', { method, body }));
    renderLinks();
    return true;
  } catch (error) {
    toast(errorText(error));
    renderLinks();
    return false;
  }
}

async function move(link, delta) {
  const movable = page.links.filter((l) => !l.removed);
  const from = movable.indexOf(link);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= movable.length) return;
  movable.splice(to, 0, movable.splice(from, 1)[0]);
  const ids = [...movable, ...page.links.filter((l) => l.removed)].map((l) => l.id);
  if (await saveLink({ action: 'reorder', ids }, 'POST')) {
    // Keep focus on the same control of the moved link, so moving twice is
    // two key presses rather than a hunt.
    const row = [...byId('linkList').children][page.links.findIndex((l) => l.id === link.id)];
    const target = row?.querySelectorAll('.order .icon-btn')[delta < 0 ? 0 : 1];
    (target && !target.disabled ? target : row?.querySelector('.icon-btn:not([disabled])'))?.focus();
  }
}

function deleteLink(link) {
  if (!window.confirm(translate('link.delete-confirm', { title: link.title }))) return;
  saveLink({ id: link.id }, 'DELETE').then((ok) => { if (ok) toast(translate('link.deleted')); });
}

// The add and edit dialog.
//
// A link is either a platform link (pick the service, type the username or
// ID, and the start of the address is filled in) or any other web address.
// The icon follows the platform or the address until the owner picks one.
let editing = null;
let chosenIcon = 'link';
let iconTouched = false;
let platform = null;
let format = null;
let autoTitle = '';

function buildLinkTypes() {
  const select = byId('linkType');
  select.replaceChildren(createElement('option', { value: '', text: translate('link.type-custom') }));
  for (const category of PLATFORM_CATEGORIES) {
    const group = createElement('optgroup', { label: translate(`link.category-${category}`) });
    for (const p of PLATFORMS.filter((x) => x.category === category)) {
      group.append(createElement('option', { value: p.id, text: platformName(p) }));
    }
    select.append(group);
  }
}

function renderIconPicker() {
  const picker = byId('iconPicker');
  picker.replaceChildren();
  for (const [category, names] of ICON_CATEGORIES) {
    const heading = createElement('p', { class: 'icon-category', id: `icons-${category}`, text: translate(`icon.category-${category}`) });
    const grid = createElement('div', { class: 'icon-picker', role: 'group', 'aria-labelledby': `icons-${category}` });
    for (const name of names) {
      const brand = PLATFORMS.find((p) => p.icon === name && brandTitle(name));
      const label = brand ? platformName(brand) : brandTitle(name) || translate(`icon.${name}`);
      const b = createElement('button', { type: 'button', 'aria-pressed': String(name === chosenIcon), 'aria-label': label, title: label });
      b.innerHTML = icon(name);
      b.addEventListener('click', () => {
        chosenIcon = name;
        iconTouched = true;
        renderIconPicker();
        picker.querySelector('[aria-pressed="true"]')?.focus();
      });
      grid.append(b);
    }
    picker.append(heading, grid);
  }
  // Keep the chosen icon in view inside the scrolling box, without moving
  // the dialog itself.
  const chosen = picker.querySelector('[aria-pressed="true"]');
  if (chosen) picker.scrollTop = chosen.offsetTop - picker.offsetTop - picker.clientHeight / 2 + chosen.offsetHeight / 2;
}

function setIconFromLink() {
  if (iconTouched) return;
  if (platform) chosenIcon = platform.icon;
  else {
    const matched = matchPlatform(byId('linkUrl').value);
    chosenIcon = matched ? matched.platform.icon : guessIcon(byId('linkUrl').value);
  }
  renderIconPicker();
}

// The username field's start, end, example and the address it makes.
function renderPlatformFields() {
  const isPlatform = Boolean(platform);
  byId('linkPlatformFields').hidden = !isPlatform;
  byId('linkUrlField').hidden = isPlatform;
  if (!isPlatform) return;

  const formatSelect = byId('linkFormat');
  formatSelect.replaceChildren(...platform.formats.map((x) => createElement('option', { value: x.id, text: translate(`link.format-${x.id}`) })));
  formatSelect.value = format.id;
  byId('linkFormatField').hidden = platform.formats.length < 2;
  // mailto: means nothing to most people, so an email address shows no start.
  byId('linkPrefix').textContent = format.prefix.replace(/^(https:\/\/(www\.)?|mailto:)/, '');
  byId('linkSuffix').textContent = format.suffix;
  byId('linkSuffix').hidden = !format.suffix;
  byId('linkUsernameLabel').setAttribute('data-i18n', format.label);
  byId('linkUsernameLabel').textContent = translate(format.label);
  byId('linkUsername').inputMode = format.inputmode;
  byId('linkUsername').placeholder = format.example;
  byId('linkUsernameHint').textContent = translate('link.username-hint', { example: format.example });
  byId('linkFormatNote').hidden = !format.note;
  byId('linkFormatNote').textContent = format.note ? translate(format.note) : '';
  updateUrlPreview();
}

function updateUrlPreview() {
  if (!platform) return;
  const username = cleanUsername(format, byId('linkUsername').value);
  const preview = byId('linkUrlPreview');
  if (!username) {
    preview.textContent = '';
    return;
  }
  preview.textContent = usernameOk(format, username)
    ? translate('link.will-open', { url: buildUrl(format, username) })
    : translate(format.invalid, { platform: platformName(platform) });
  preview.classList.toggle('bad', !usernameOk(format, username));
}

function choosePlatform(id, { keepUsername = false } = {}) {
  const previousName = platform ? platformName(platform) : '';
  platform = platformById(id);
  format = platform ? platform.formats[0] : null;
  if (!keepUsername) byId('linkUsername').value = '';
  // Fill the title with the platform's name, unless the owner wrote their own.
  const title = byId('linkTitle');
  if (platform && (!title.value || title.value === previousName || title.value === autoTitle)) {
    title.value = platformName(platform);
    autoTitle = platformName(platform);
  }
  renderPlatformFields();
  setIconFromLink();
}

function openLinkModal(link = null) {
  editing = link;
  buildLinkTypes();
  byId('linkModalTitle').textContent = translate(link ? 'link.edit-title' : 'link.add-title');
  byId('linkTitle').value = link ? link.title : '';
  byId('linkUrl').value = link ? link.url : '';
  byId('linkUsername').value = '';
  chosenIcon = link ? link.icon : 'link';
  iconTouched = Boolean(link);
  autoTitle = '';
  byId('linkError').textContent = '';

  // An existing link to a known platform opens as that platform, with its
  // username, so changing it means typing only the name again.
  const matched = link ? matchPlatform(link.url) : null;
  platform = matched ? matched.platform : null;
  format = matched ? matched.format : null;
  byId('linkType').value = platform ? platform.id : '';
  if (matched) byId('linkUsername').value = matched.username;
  renderPlatformFields();
  renderIconPicker();
  openModal('linkModal', { initialFocus: byId('linkType') });
}

byId('addLink').addEventListener('click', () => openLinkModal());
byId('linkType').addEventListener('change', (e) => choosePlatform(e.target.value));
byId('linkFormat').addEventListener('change', (e) => {
  format = platform.formats.find((x) => x.id === e.target.value) || platform.formats[0];
  renderPlatformFields();
});
byId('linkUsername').addEventListener('input', updateUrlPreview);
// A whole address pasted into the username field is cut down to the name.
byId('linkUsername').addEventListener('change', () => {
  if (platform) byId('linkUsername').value = cleanUsername(format, byId('linkUsername').value);
  updateUrlPreview();
});
byId('linkUrl').addEventListener('input', setIconFromLink);

byId('linkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = byId('linkUrl').value;
  if (platform) {
    const username = cleanUsername(format, byId('linkUsername').value);
    if (!usernameOk(format, username)) {
      byId('linkError').textContent = translate(format.invalid, { platform: platformName(platform) });
      byId('linkUsername').focus();
      return;
    }
    url = buildUrl(format, username);
  }
  const title = byId('linkTitle').value.trim() || (platform ? platformName(platform) : '');
  withBusy(byId('linkSave'), byId('linkError'), async () => {
    const body = { title, url, icon: chosenIcon };
    let data;
    try {
      data = editing
        ? await api('/api/me/links', { method: 'PATCH', body: { id: editing.id, ...body } })
        : await post('/api/me/links', body);
    } catch (error) {
      noteLimit(error);
      throw error;
    }
    takeLinks(data);
    renderLinks();
    closeModal('linkModal');
    toast(translate(editing ? 'link.saved' : 'link.added'));
  });
});

// ---------------------------------------------------------------------------
// Link limit
//
// A page can have up to page.linkCap.limit links; ones the GFTV team removed
// do not count. If an admin lowers the limit below what the page has, the
// links all stay, and Add link is off until the page is under it again. The
// owner can ask for more, one request at a time, and sees the answer here.
// ---------------------------------------------------------------------------

// The most any page can be given (MAX_LINKS in api/_lib/validate.js).
const MAX_LINK_CAP = 200;

function linksInUse() {
  return page.links.filter((l) => !l.removed).length;
}

// A decline can come with a smaller raise (granted), which reads differently.
function capRequestText(r) {
  const key = r.status === 'declined' && r.granted ? 'compromise' : r.status;
  const text = translate(`link-cap.status-${key}`, {
    requested: formatNumber(r.requested),
    granted: formatNumber(r.granted ?? 0),
    when: formatDate(r.sentAt),
  });
  return r.note ? `${text} ${translate('link-cap.note', { note: r.note })}` : text;
}

function renderLinkCap() {
  const cap = page.linkCap;
  const box = byId('capRequestBox');
  if (!cap) {
    byId('linkCapUsage').textContent = '';
    byId('linkCapNotice').textContent = '';
    byId('addLink').disabled = false;
    box.hidden = true;
    return;
  }
  const used = linksInUse();
  const numbers = { count: cap.limit, used: formatNumber(used), limit: formatNumber(cap.limit) };
  byId('linkCapUsage').textContent = translate('link-cap.usage', numbers);
  byId('linkCapNotice').textContent = used > cap.limit ? translate('link-cap.over', numbers) : used === cap.limit ? translate('link-cap.full') : '';
  byId('addLink').disabled = used >= cap.limit;

  const request = page.linkCapRequest;
  const pending = request?.status === 'pending';
  const atMost = cap.limit >= MAX_LINK_CAP;
  box.hidden = atMost && !request;
  const status = byId('capRequestStatus');
  status.classList.toggle('ok', request?.status === 'approved');
  status.classList.toggle('warn', request?.status === 'declined' && !request.granted);
  status.textContent = request ? capRequestText(request) : '';
  byId('capRequestForm').hidden = pending || atMost;
  byId('capWithdrawRow').hidden = !pending;
  byId('capRequested').min = String(Math.min(cap.limit + 1, MAX_LINK_CAP));
  byId('capReasonCount').textContent = translate('field.bio-count', { used: [...byId('capReason').value].length, max: 500 });
}

function takeCap(data) {
  page.linkCap = data.linkCap;
  page.linkCapRequest = data.request;
  renderLinks();
}

byId('capReason').addEventListener('input', renderLinkCap);
byId('capRequestForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('capRequestSend'), byId('capRequestError'), async () => {
    takeCap(await post('/api/me/link-cap', { requested: byId('capRequested').value, reason: byId('capReason').value }));
    byId('capRequested').value = '';
    byId('capReason').value = '';
    renderLinkCap();
    toast(translate('link-cap.sent'));
  });
});
byId('capRequestWithdraw').addEventListener('click', () => {
  if (!window.confirm(translate('link-cap.withdraw-confirm'))) return;
  withBusy(byId('capRequestWithdraw'), byId('capRequestError'), async () => {
    takeCap(await api('/api/me/link-cap', { method: 'DELETE', body: {} }));
    toast(translate('link-cap.withdrawn'));
  });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function renderProfile() {
  if (document.activeElement !== byId('displayName')) byId('displayName').value = page.displayName;
  if (document.activeElement !== byId('bio')) byId('bio').value = page.bio;
  byId('displayName').placeholder = page.slug;
  updateBioCount();
  fillAvatar(byId('avatarPreview'), page.avatarUrl, page.displayName || page.slug);
  byId('avatarRemove').hidden = !page.avatarUrl;
  byId('avatarPickLabel').textContent = translate(page.avatarUrl ? 'avatar.change' : 'avatar.upload');
}

// Picking a file opens the picture editor (js/avatar-composer.js), where it
// is framed, optionally cut out, and only then uploaded.
byId('avatarFile').addEventListener('change', async () => {
  const input = byId('avatarFile');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  byId('avatarError').textContent = '';
  try {
    await editAvatar(file, async (image) => {
      const data = await post('/api/me/avatar', { image });
      page = data.page;
      renderProfile();
      toast(translate('avatar.updated'));
    });
  } catch (error) {
    byId('avatarError').textContent = errorText(error);
  }
});

byId('avatarRemove').addEventListener('click', () => {
  withBusy(byId('avatarRemove'), byId('avatarError'), async () => {
    const data = await api('/api/me/avatar', { method: 'DELETE', body: {} });
    page = data.page;
    renderProfile();
    toast(translate('avatar.removed'));
  });
});

// The owner's testimonial for the home page (api/me/testimonial.js): send,
// see whether staff put it up, withdraw.
let ownQuote = null;

function renderOwnQuote() {
  const status = byId('ownQuoteStatus');
  status.hidden = !ownQuote;
  status.classList.toggle('ok', ownQuote?.status === 'approved');
  status.classList.toggle('warn', ownQuote?.status === 'declined');
  if (ownQuote) status.textContent = translate(`testimonial.status-${ownQuote.status}`, { quote: ownQuote.quote });
  byId('ownQuoteWithdraw').hidden = !ownQuote;
  byId('ownQuoteSend').querySelector('span:last-child').textContent = translate(ownQuote ? 'testimonial.replace' : 'testimonial.send');
  byId('ownQuoteCount').textContent = translate('field.bio-count', { used: [...byId('ownQuote').value].length, max: 280 });
}

async function loadOwnQuote() {
  try {
    ownQuote = (await api('/api/me/testimonial')).testimonial;
  } catch {
    ownQuote = null;
  }
  renderOwnQuote();
}

byId('ownQuote').addEventListener('input', renderOwnQuote);
byId('ownQuoteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('ownQuoteSend'), byId('ownQuoteError'), async () => {
    const data = await post('/api/me/testimonial', { quote: byId('ownQuote').value, consent: byId('ownQuoteConsent').checked });
    ownQuote = data.testimonial;
    byId('ownQuote').value = '';
    byId('ownQuoteConsent').checked = false;
    renderOwnQuote();
    toast(translate('testimonial.sent'));
  });
});
byId('ownQuoteWithdraw').addEventListener('click', () => {
  if (!window.confirm(translate('testimonial.withdraw-confirm'))) return;
  withBusy(byId('ownQuoteWithdraw'), byId('ownQuoteError'), async () => {
    ownQuote = (await api('/api/me/testimonial', { method: 'DELETE', body: {} })).testimonial;
    renderOwnQuote();
    toast(translate('testimonial.withdrawn'));
  });
});

function updateBioCount() {
  byId('bioCount').textContent = translate('field.bio-count', { used: [...byId('bio').value].length, max: 512 });
}
byId('bio').addEventListener('input', updateBioCount);

byId('profileForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('profileSave'), byId('profileError'), async () => {
    const data = await api('/api/me/page', { method: 'PATCH', body: { displayName: byId('displayName').value, bio: byId('bio').value } });
    page = data.page;
    renderProfile();
    toast(translate('common.saved'));
  });
});

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

function renderShare() {
  byId('shareQr').innerHTML = qrSvg(pageUrl(), translate('share.qr-label', { slug: page.slug }));
  byId('shareNative').hidden = typeof navigator.share !== 'function';
}

byId('shareCopy').addEventListener('click', () => copyText(pageUrl()));
byId('shareDownload').addEventListener('click', () => downloadQr(pageUrl(), `onelink-${page.slug}-qr.png`));
byId('shareNative').addEventListener('click', () => {
  navigator.share({ title: page.displayName || page.slug, url: pageUrl() }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

let stats = null;
let statsDays = 30;
let statsSeries = 'visits';

async function loadStats() {
  const tiles = byId('statsTiles');
  tiles.setAttribute('aria-busy', 'true');
  if (!stats) tiles.replaceChildren(...Array.from({ length: 4 }, () => createElement('div', { class: 'skeleton delayed stat-tile', 'aria-hidden': 'true' })));
  try {
    stats = await api(`/api/me/stats?days=${statsDays}`);
    renderStats();
  } catch (error) {
    toast(errorText(error));
  } finally {
    tiles.removeAttribute('aria-busy');
  }
}

function countryName(code) {
  if (code === 'XX') return translate('stats.unknown');
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

// words: the value is a name (a country), not a number, so it is set smaller
// and wraps between words rather than through them.
function tile(label, value, note, { words = false } = {}) {
  return createElement('div', { class: 'stat-tile' }, [
    createElement('div', { class: words ? 'value words' : 'value', text: value }),
    createElement('div', { class: 'label', text: label }),
    note ? createElement('div', { class: 'note', text: note }) : null,
  ]);
}

// A name is never split inside a word. It wraps only between words; when a
// word is still wider than its tile, the text steps down in size, and if the
// smallest size is still too wide the tile takes the whole row. Run again on
// every render, which a resize triggers.
const FIT_MIN = 0.7; // of the starting size
function fitWords(value) {
  const tile = value.closest('.stat-tile');
  const grid = tile.parentElement;
  grid.querySelectorAll('.stat-tile.wide').forEach((x) => x.classList.remove('wide'));
  value.style.fontSize = '';
  const start = parseFloat(getComputedStyle(value).fontSize);
  const overflows = () => value.scrollWidth > value.clientWidth + 1;
  const shrink = () => {
    for (let scale = 1; overflows() && scale > FIT_MIN; ) {
      scale = Math.max(FIT_MIN, scale - 0.05);
      value.style.fontSize = `${start * scale}px`;
    }
  };
  shrink();
  if (!overflows()) return;
  tile.classList.add('wide');
  // In two columns the tile before it would be left alone in its row, so it
  // takes the whole row too.
  if (getComputedStyle(grid).gridTemplateColumns.split(' ').length === 2) tile.previousElementSibling?.classList.add('wide');
  value.style.fontSize = '';
  shrink();
}
// The site font can arrive after the first render and is wider than the
// fallback, so fit again once it has.
document.fonts?.ready.then(() => byId('statsTiles').querySelectorAll('.value.words').forEach(fitWords));

function renderStats() {
  document.querySelectorAll('#statsPeriod [data-days]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === statsDays)));
  document.querySelectorAll('#statsSeries [data-series]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.series === statsSeries)));
  if (!stats || !page) return;
  const { totals } = stats;
  const rate = totals.visits > 0 ? `${Math.round((totals.clicks / totals.visits) * 100)}%` : '–';
  const topCountry = stats.countries.find((c) => c.key !== 'XX');
  const topSource = stats.referrers.find((r) => r.key);
  byId('statsTiles').replaceChildren(
    tile(translate('stats.visits'), formatNumber(totals.visits)),
    tile(translate('stats.clicks'), formatNumber(totals.clicks)),
    tile(translate('stats.click-rate'), rate, translate('stats.click-rate-note')),
    tile(translate('stats.top-country'), topCountry ? countryName(topCountry.key) : '–', topSource ? translate('stats.top-source', { site: topSource.key }) : null, { words: Boolean(topCountry) }),
  );
  byId('statsTiles').querySelectorAll('.value.words').forEach(fitWords);

  const series = statsSeries;
  const title = translate(`stats.chart-${series}`, { days: statsDays });
  byId('statsChartTitle').textContent = title;
  drawColumns(byId('statsChart'), stats.daily.map((d) => ({ day: d.day, value: d[series] })), {
    label: title,
    caption: title,
    describe: (p) => translate(`stats.tip-${series}`, { day: dayLabel(p.day, { weekday: 'short', day: 'numeric', month: 'short' }), count: p.value, n: formatNumber(p.value) }),
  });

  fillBarList(byId('statsCountries'), stats.countries.map((c) => ({ label: countryName(c.key), value: c.hits })), translate('stats.none'));
  fillBarList(byId('statsReferrers'), stats.referrers.map((r) => ({ label: r.key || translate('stats.direct'), value: r.hits })), translate('stats.none'));
  fillBarList(byId('statsDevices'), stats.devices.map((d) => ({ label: translate(`stats.device-${d.key}`), value: d.hits })), translate('stats.none'));
  const linked = page.links.filter((l) => !l.removed && l.clicks > 0).sort((a, b) => b.clicks - a.clicks).slice(0, 5);
  fillBarList(byId('statsLinks'), linked.map((l) => ({ label: l.title, value: l.clicks })), translate('stats.none'));
}

byId('statsPeriod').addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]');
  if (!b || Number(b.dataset.days) === statsDays) return;
  statsDays = Number(b.dataset.days);
  renderStats();
  loadStats();
});
byId('statsSeries').addEventListener('click', (e) => {
  const b = e.target.closest('[data-series]');
  if (!b) return;
  statsSeries = b.dataset.series;
  renderStats();
});
// Columns are laid out for the chart's width, so a resize redraws them.
new ResizeObserver(() => { if (stats && !byId('panel-stats').hidden) renderStats(); }).observe(byId('statsChart'));

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function renderSecurity() {
  const s = page.security;
  const passkeyCount = s.passkeys.length;
  const factors = (s.totp ? 1 : 0) + passkeyCount;

  byId('totpState').textContent = translate(s.totp ? 'security.on' : 'security.off');
  byId('totpAdd').hidden = s.totp;
  byId('totpRemove').hidden = !s.totp;
  byId('totpRemove').disabled = factors <= 1;
  byId('totpRemove').title = factors <= 1 ? translate('security.last-factor') : '';

  byId('passkeyState').textContent = translate('security.passkey-count', { count: passkeyCount, n: formatNumber(passkeyCount) });
  byId('passkeyAdd').disabled = !passkeysSupported();
  byId('passkeyList').replaceChildren(...s.passkeys.map((key, n) => {
    const remove = createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', disabled: factors <= 1, title: factors <= 1 ? translate('security.last-factor') : undefined });
    remove.textContent = translate('common.remove');
    remove.addEventListener('click', () => askPassword((password) => post('/api/me/security', { action: 'passkey-remove', id: key.id, password }), () => toast(translate('security.passkey-removed'))));
    return createElement('li', {}, [
      createElement('div', {}, [
        createElement('div', { text: key.label || translate('security.passkey-n', { n: n + 1 }) }),
        createElement('small', { text: key.lastUsedAt ? translate('security.last-used', { when: formatDate(key.lastUsedAt) }) : translate('security.added', { when: formatDate(key.createdAt) }) }),
      ]),
      remove,
    ]);
  }));

  byId('codesState').textContent = translate('security.codes-left', { count: s.backupCodesLeft, n: formatNumber(s.backupCodesLeft) });
  byId('codesState').classList.toggle('warn', s.backupCodesLeft <= 2);

  byId('telegramSection').hidden = !s.telegramAvailable && !s.telegram.linked;
  byId('telegramState').textContent = s.telegram.linked
    ? (s.telegram.username ? translate('telegram.linked-as', { username: s.telegram.username }) : translate('telegram.linked'))
    : translate('telegram.not-linked');
  byId('telegramLink').hidden = s.telegram.linked || !s.telegramAvailable;
  byId('telegramUnlink').hidden = !s.telegram.linked;

  byId('keepLiveState').textContent = page.dormantFrom
    ? translate('security.keep-live-until', { date: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(new Date(page.dormantFrom)) })
    : '';

  renderRename();
}

// ---------------------------------------------------------------------------
// Page name
// ---------------------------------------------------------------------------

const longDate = (iso) => new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(new Date(iso));

function renderRename() {
  const rename = page.rename;
  // Hidden until the server can keep the old name held (migration 016).
  byId('renameSection').hidden = !rename || !rename.available;
  if (!rename || !rename.available) return;
  byId('renameState').textContent = `links.gftv.asia/${page.slug}`;
  byId('renameOpen').disabled = Boolean(rename.nextAt);
  const notes = [];
  if (rename.previous) notes.push(translate('rename.previous', { slug: rename.previous.slug, date: longDate(rename.previous.heldUntil) }));
  if (rename.nextAt) notes.push(translate('rename.next', { date: longDate(rename.nextAt) }));
  byId('renameNote').textContent = notes.join(' ');
  byId('renameNote').hidden = notes.length === 0;
}

const renameCheck = wireSlugCheck(byId('renameSlug'), byId('renameStatus'), {
  current: () => page && page.slug,
  reviewKey: 'rename.review',
  reviewTone: 'warn',
});

byId('renameOpen').addEventListener('click', () => {
  byId('renameSlug').value = '';
  byId('renameStatus').replaceChildren();
  byId('renameStatus').className = 'field-status';
  byId('renamePassword').value = '';
  byId('renameError').textContent = '';
  openModal('renameModal', { initialFocus: byId('renameSlug') });
});

byId('renameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = byId('renameError');
  const slug = normaliseSlugInput(byId('renameSlug').value);
  if (!slug) return void (error.textContent = translate('slug.invalid'));
  if (slug === page.slug) return void (error.textContent = translate('error.slug_same'));
  const known = renameCheck();
  // A name that needs approval hides the page until then: say so once more.
  if (known && known.slug === slug && known.review && !window.confirm(translate('rename.review-confirm', { slug }))) return;
  withBusy(byId('renameSubmit'), error, async () => {
    const data = await post('/api/me/security', { action: 'rename', slug, password: byId('renamePassword').value });
    closeModal('renameModal');
    setPage(data.page);
    toast(translate(data.review ? 'rename.done-review' : 'rename.done', { slug: data.page.slug }));
  });
});

// Ask for the password, then run fn(password). A wrong password keeps the
// dialog open with the error; success closes it and hands the answer on.
let pending = null;
function askPassword(fn, then) {
  pending = { fn, then };
  byId('confirmPassword').value = '';
  byId('passwordError').textContent = '';
  openModal('passwordModal', { initialFocus: byId('confirmPassword') });
}

byId('passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pending) return;
  const { fn, then } = pending;
  withBusy(byId('passwordSubmit'), byId('passwordError'), async () => {
    const data = await fn(byId('confirmPassword').value);
    pending = null;
    closeModal('passwordModal');
    if (data && data.page) setPage(data.page);
    if (then) await then(data);
  });
});

// Authenticator app
let totpChallenge = null;
byId('totpAdd').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'totp-start', password }),
  (data) => {
    totpChallenge = data.challenge;
    byId('totpQr').innerHTML = qrSvg(data.uri, translate('totp.qr-label'));
    byId('totpSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
    byId('totpCode').value = '';
    byId('totpError').textContent = '';
    openModal('totpModal', { initialFocus: byId('totpCode') });
  }
));
byId('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('totpSubmit'), byId('totpError'), async () => {
    const data = await post('/api/me/security', { action: 'totp-finish', challenge: totpChallenge, code: byId('totpCode').value });
    closeModal('totpModal');
    setPage(data.page);
    toast(translate('security.totp-added'));
  });
});
byId('totpRemove').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'totp-remove', password }),
  () => toast(translate('security.totp-removed'))
));

// Passkeys
byId('passkeyAdd').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'passkey-options', password }),
  async ({ options }) => {
    const button = byId('passkeyAdd');
    setBusy(button, true);
    try {
      const response = await createPasskey(options);
      const data = await post('/api/me/security', { action: 'passkey-finish', response });
      setPage(data.page);
      toast(translate('security.passkey-added'));
    } catch (error) {
      toast(errorText({ code: passkeyErrorCode(error) }));
    } finally {
      setBusy(button, false);
    }
  }
));

// Backup codes
byId('codesRegenerate').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'backup-regenerate', password }),
  (data) => {
    showCodes(byId('backupCodes'), data.backupCodes, { copyButton: byId('codesCopy'), downloadButton: byId('codesDownload'), slug: page.slug });
    openModal('codesModal');
  }
));

// Telegram
byId('telegramLink').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'telegram-link', password }),
  (data) => {
    byId('telegramOpen').href = data.url;
    openModal('telegramModal', { initialFocus: byId('telegramOpen') });
  }
));
byId('telegramDone').addEventListener('click', async () => {
  const data = await api('/api/me/page').catch(() => null);
  if (data) setPage(data.page);
  closeModal('telegramModal');
  toast(translate(page.security.telegram.linked ? 'telegram.now-linked' : 'telegram.not-yet'));
});
byId('telegramUnlink').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'telegram-unlink', password }),
  () => toast(translate('telegram.unlinked'))
));

// Password and devices
byId('passwordChange').addEventListener('click', () => {
  ['currentPassword', 'changeNewPassword', 'changeNewPasswordConfirm'].forEach((id) => { byId(id).value = ''; });
  byId('changePasswordError').textContent = '';
  openModal('changePasswordModal', { initialFocus: byId('currentPassword') });
});
byId('changePasswordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = byId('changePasswordError');
  const newPassword = byId('changeNewPassword').value;
  if ([...newPassword].length < 10) return void (error.textContent = translate('error.password_too_short'));
  if (newPassword !== byId('changeNewPasswordConfirm').value) return void (error.textContent = translate('error.password_mismatch'));
  withBusy(byId('changePasswordSubmit'), error, async () => {
    const data = await post('/api/me/security', { action: 'password-change', password: byId('currentPassword').value, newPassword });
    closeModal('changePasswordModal');
    setPage(data.page);
    toast(translate('security.password-changed'));
  });
});
byId('sessionsEnd').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'sessions-end-others', password }),
  () => toast(translate('security.signed-out-others'))
));

// Delete
byId('pageDelete').addEventListener('click', () => {
  byId('deleteConfirmLabel').textContent = translate('security.delete-type', { slug: page.slug });
  byId('deleteConfirmSlug').value = '';
  byId('deletePassword').value = '';
  byId('deleteError').textContent = '';
  openModal('deleteModal', { initialFocus: byId('deleteConfirmSlug') });
});
byId('deleteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('deleteSubmit'), byId('deleteError'), async () => {
    await post('/api/me/security', { action: 'delete-page', confirmSlug: byId('deleteConfirmSlug').value, password: byId('deletePassword').value });
    window.location.replace('/');
  });
});

// Sign out
byId('signOut').addEventListener('click', async () => {
  await post('/api/auth/session', { action: 'logout' }).catch(() => {});
  window.location.replace('/');
});

onChange(render);
load();
