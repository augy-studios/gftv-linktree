// The page editor: links (or a redirect), profile, sharing, stats and security.

import '../app.js';
import { t, onChange, getLocale } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { openModal, closeModal, withBusy, toast, copyText, el, formatNumber, formatDate, errorText, setBusy } from '../ui.js';
import { icon, iconNode, ICON_CATEGORIES, brandTitle, guessIcon } from '../icons.js';
import { PLATFORMS, PLATFORM_CATEGORIES, platformById, matchPlatform, cleanUsername, buildUrl, usernameOk } from '../platforms.js';
import { qrSvg, downloadQr } from '../qr.js';
import { showCodes } from '../codes.js';
import { passkeysSupported, createPasskey, passkeyErrorCode } from '../passkeys.js';
import { fillAvatar } from '../avatar.js';
import { editAvatar } from '../avatar-composer.js';
import { drawColumns, fillBarList, dayLabel } from '../insights.js';

const $ = (id) => document.getElementById(id);
let page = null;

// What a platform is called in the current language (platforms.js).
const platformName = (p) => t(`platform.${p.id}`);

function pageUrl() {
  return `${window.location.origin}/${page.slug}`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function view(name) {
  $('editorLoading').hidden = name !== 'loading';
  $('editorSignedOut').hidden = name !== 'signedOut';
  $('editorBanned').hidden = name !== 'banned';
  $('editorReady').hidden = name !== 'ready';
  $('signOut').hidden = name !== 'ready';
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
  $('pageUrl').textContent = url.replace(/^https?:\/\//, '');
  $('pageUrl').href = url;
  $('viewPage').href = url;
  $('reviewNotice').hidden = !page.awaitingReview;
  $('quarantineNotice').hidden = !page.quarantined;
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
    $(other.getAttribute('aria-controls')).hidden = !on;
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
  const form = $('redirectForm');
  $('redirectToggle').checked = on || redirectOpen;
  form.hidden = !(on || redirectOpen);
  if (on && document.activeElement !== $('redirectUrl')) $('redirectUrl').value = page.redirectUrl;
  $('redirectState').textContent = on ? t('redirect.on', { url: page.redirectUrl.replace(/^https?:\/\//, '') }) : t('redirect.off');
  $('redirectSave').querySelector('span').textContent = t(on ? 'redirect.update' : 'redirect.save');
  $('redirectLinksNote').hidden = !on;
}

$('redirectToggle').addEventListener('change', (e) => {
  $('redirectError').textContent = '';
  if (e.target.checked) {
    redirectOpen = true;
    renderRedirect();
    $('redirectUrl').focus();
    return;
  }
  redirectOpen = false;
  if (!page.redirectUrl) return renderRedirect();
  withBusy($('redirectSave'), $('redirectError'), async () => {
    try {
      const data = await api('/api/me/page', { method: 'PATCH', body: { redirectUrl: '' } });
      setPage(data.page);
      toast(t('redirect.turned-off'));
    } catch (error) {
      renderRedirect();
      throw error;
    }
  });
});

$('redirectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('redirectSave'), $('redirectError'), async () => {
    const data = await api('/api/me/page', { method: 'PATCH', body: { redirectUrl: $('redirectUrl').value } });
    redirectOpen = false;
    $('redirectUrl').blur();
    setPage(data.page);
    toast(t('redirect.turned-on'));
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function renderLinks() {
  const list = $('linkList');
  list.replaceChildren();
  $('linksEmpty').hidden = page.links.length > 0;
  const movable = page.links.filter((l) => !l.removed);

  page.links.forEach((link) => {
    const index = movable.indexOf(link);
    const up = el('button', {
      class: 'icon-btn small', type: 'button', 'aria-label': t('link.move-up', { title: link.title }),
      disabled: link.removed || index <= 0, onclick: () => move(link, -1),
    });
    up.innerHTML = icon('arrow-up');
    const down = el('button', {
      class: 'icon-btn small', type: 'button', 'aria-label': t('link.move-down', { title: link.title }),
      disabled: link.removed || index < 0 || index >= movable.length - 1, onclick: () => move(link, 1),
    });
    down.innerHTML = icon('arrow-down');

    const title = el('div', { class: 'title' }, [iconNode(link.icon), el('span', { text: link.title })]);
    if (link.removed) title.append(el('span', { class: 'badge danger', text: t('link.removed') }));
    else if (!link.isActive) title.append(el('span', { class: 'badge', text: t('link.hidden') }));

    const meta = el('div', { class: 'meta' }, [
      title,
      el('div', { class: 'url', text: link.url }),
      el('div', { class: 'stats', text: link.removed ? t('link.removed-reason', { reason: link.removedReason || t('link.removed-no-reason') }) : t('link.clicks', { count: link.clicks, n: formatNumber(link.clicks) }) }),
    ]);

    const controls = el('div', { class: 'controls' });
    if (!link.removed) {
      const toggle = el('label', { class: 'switch', title: t('link.show') });
      const box = el('input', { type: 'checkbox', 'aria-label': t('link.show-named', { title: link.title }) });
      box.checked = link.isActive;
      box.addEventListener('change', () => saveLink({ id: link.id, isActive: box.checked }, 'PATCH'));
      toggle.append(box, el('span', { class: 'track', 'aria-hidden': 'true' }));
      const edit = el('button', { class: 'icon-btn small', type: 'button', 'aria-label': t('link.edit-named', { title: link.title }), onclick: () => openLinkModal(link) });
      edit.innerHTML = icon('edit');
      const remove = el('button', { class: 'icon-btn small', type: 'button', 'aria-label': t('link.delete-named', { title: link.title }), onclick: () => deleteLink(link) });
      remove.innerHTML = icon('trash');
      controls.append(toggle, edit, remove);
    }

    list.append(el('li', { class: `edit-link${link.isActive && !link.removed ? '' : ' off'}` }, [
      el('div', { class: 'order' }, [up, down]),
      meta,
      controls,
    ]));
  });
}

async function saveLink(body, method) {
  try {
    const data = await api('/api/me/links', { method, body });
    page.links = data.links;
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
    const row = [...$('linkList').children][page.links.findIndex((l) => l.id === link.id)];
    const target = row?.querySelectorAll('.order .icon-btn')[delta < 0 ? 0 : 1];
    (target && !target.disabled ? target : row?.querySelector('.icon-btn:not([disabled])'))?.focus();
  }
}

function deleteLink(link) {
  if (!window.confirm(t('link.delete-confirm', { title: link.title }))) return;
  saveLink({ id: link.id }, 'DELETE').then((ok) => { if (ok) toast(t('link.deleted')); });
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
  const select = $('linkType');
  select.replaceChildren(el('option', { value: '', text: t('link.type-custom') }));
  for (const category of PLATFORM_CATEGORIES) {
    const group = el('optgroup', { label: t(`link.category-${category}`) });
    for (const p of PLATFORMS.filter((x) => x.category === category)) {
      group.append(el('option', { value: p.id, text: platformName(p) }));
    }
    select.append(group);
  }
}

function renderIconPicker() {
  const picker = $('iconPicker');
  picker.replaceChildren();
  for (const [category, names] of ICON_CATEGORIES) {
    const heading = el('p', { class: 'icon-category', id: `icons-${category}`, text: t(`icon.category-${category}`) });
    const grid = el('div', { class: 'icon-picker', role: 'group', 'aria-labelledby': `icons-${category}` });
    for (const name of names) {
      const brand = PLATFORMS.find((p) => p.icon === name && brandTitle(name));
      const label = brand ? platformName(brand) : brandTitle(name) || t(`icon.${name}`);
      const b = el('button', { type: 'button', 'aria-pressed': String(name === chosenIcon), 'aria-label': label, title: label });
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
    const matched = matchPlatform($('linkUrl').value);
    chosenIcon = matched ? matched.platform.icon : guessIcon($('linkUrl').value);
  }
  renderIconPicker();
}

// The username field's start, end, example and the address it makes.
function renderPlatformFields() {
  const isPlatform = Boolean(platform);
  $('linkPlatformFields').hidden = !isPlatform;
  $('linkUrlField').hidden = isPlatform;
  if (!isPlatform) return;

  const formatSelect = $('linkFormat');
  formatSelect.replaceChildren(...platform.formats.map((x) => el('option', { value: x.id, text: t(`link.format-${x.id}`) })));
  formatSelect.value = format.id;
  $('linkFormatField').hidden = platform.formats.length < 2;
  $('linkPrefix').textContent = format.prefix.replace(/^https:\/\/(www\.)?/, '');
  $('linkSuffix').textContent = format.suffix;
  $('linkSuffix').hidden = !format.suffix;
  $('linkUsername').placeholder = format.example;
  $('linkUsernameHint').textContent = t('link.username-hint', { example: format.example });
  $('linkFormatNote').hidden = !format.note;
  $('linkFormatNote').textContent = format.note ? t(format.note) : '';
  updateUrlPreview();
}

function updateUrlPreview() {
  if (!platform) return;
  const username = cleanUsername(format, $('linkUsername').value);
  const preview = $('linkUrlPreview');
  if (!username) {
    preview.textContent = '';
    return;
  }
  preview.textContent = usernameOk(format, username)
    ? t('link.will-open', { url: buildUrl(format, username) })
    : t('link.username-invalid', { platform: platformName(platform) });
  preview.classList.toggle('bad', !usernameOk(format, username));
}

function choosePlatform(id, { keepUsername = false } = {}) {
  const previousName = platform ? platformName(platform) : '';
  platform = platformById(id);
  format = platform ? platform.formats[0] : null;
  if (!keepUsername) $('linkUsername').value = '';
  // Fill the title with the platform's name, unless the owner wrote their own.
  const title = $('linkTitle');
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
  $('linkModalTitle').textContent = t(link ? 'link.edit-title' : 'link.add-title');
  $('linkTitle').value = link ? link.title : '';
  $('linkUrl').value = link ? link.url : '';
  $('linkUsername').value = '';
  chosenIcon = link ? link.icon : 'link';
  iconTouched = Boolean(link);
  autoTitle = '';
  $('linkError').textContent = '';

  // An existing link to a known platform opens as that platform, with its
  // username, so changing it means typing only the name again.
  const matched = link ? matchPlatform(link.url) : null;
  platform = matched ? matched.platform : null;
  format = matched ? matched.format : null;
  $('linkType').value = platform ? platform.id : '';
  if (matched) $('linkUsername').value = matched.username;
  renderPlatformFields();
  renderIconPicker();
  openModal('linkModal', { initialFocus: $('linkType') });
}

$('addLink').addEventListener('click', () => openLinkModal());
$('linkType').addEventListener('change', (e) => choosePlatform(e.target.value));
$('linkFormat').addEventListener('change', (e) => {
  format = platform.formats.find((x) => x.id === e.target.value) || platform.formats[0];
  renderPlatformFields();
});
$('linkUsername').addEventListener('input', updateUrlPreview);
// A whole address pasted into the username field is cut down to the name.
$('linkUsername').addEventListener('change', () => {
  if (platform) $('linkUsername').value = cleanUsername(format, $('linkUsername').value);
  updateUrlPreview();
});
$('linkUrl').addEventListener('input', setIconFromLink);

$('linkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = $('linkUrl').value;
  if (platform) {
    const username = cleanUsername(format, $('linkUsername').value);
    if (!usernameOk(format, username)) {
      $('linkError').textContent = t('link.username-invalid', { platform: platformName(platform) });
      $('linkUsername').focus();
      return;
    }
    url = buildUrl(format, username);
  }
  const title = $('linkTitle').value.trim() || (platform ? platformName(platform) : '');
  withBusy($('linkSave'), $('linkError'), async () => {
    const body = { title, url, icon: chosenIcon };
    const data = editing
      ? await api('/api/me/links', { method: 'PATCH', body: { id: editing.id, ...body } })
      : await post('/api/me/links', body);
    page.links = data.links;
    renderLinks();
    closeModal('linkModal');
    toast(t(editing ? 'link.saved' : 'link.added'));
  });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function renderProfile() {
  if (document.activeElement !== $('displayName')) $('displayName').value = page.displayName;
  if (document.activeElement !== $('bio')) $('bio').value = page.bio;
  $('displayName').placeholder = page.slug;
  updateBioCount();
  fillAvatar($('avatarPreview'), page.avatarUrl, page.displayName || page.slug);
  $('avatarRemove').hidden = !page.avatarUrl;
  $('avatarPickLabel').textContent = t(page.avatarUrl ? 'avatar.change' : 'avatar.upload');
}

// Picking a file opens the picture editor (js/avatar-composer.js), where it
// is framed, optionally cut out, and only then uploaded.
$('avatarFile').addEventListener('change', async () => {
  const input = $('avatarFile');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  $('avatarError').textContent = '';
  try {
    await editAvatar(file, async (image) => {
      const data = await post('/api/me/avatar', { image });
      page = data.page;
      renderProfile();
      toast(t('avatar.updated'));
    });
  } catch (error) {
    $('avatarError').textContent = errorText(error);
  }
});

$('avatarRemove').addEventListener('click', () => {
  withBusy($('avatarRemove'), $('avatarError'), async () => {
    const data = await api('/api/me/avatar', { method: 'DELETE', body: {} });
    page = data.page;
    renderProfile();
    toast(t('avatar.removed'));
  });
});

// The owner's testimonial for the home page (api/me/testimonial.js): send,
// see whether staff put it up, withdraw.
let ownQuote = null;

function renderOwnQuote() {
  const status = $('ownQuoteStatus');
  status.hidden = !ownQuote;
  status.classList.toggle('ok', ownQuote?.status === 'approved');
  status.classList.toggle('warn', ownQuote?.status === 'declined');
  if (ownQuote) status.textContent = t(`testimonial.status-${ownQuote.status}`, { quote: ownQuote.quote });
  $('ownQuoteWithdraw').hidden = !ownQuote;
  $('ownQuoteSend').querySelector('span:last-child').textContent = t(ownQuote ? 'testimonial.replace' : 'testimonial.send');
  $('ownQuoteCount').textContent = t('field.bio-count', { used: [...$('ownQuote').value].length, max: 280 });
}

async function loadOwnQuote() {
  try {
    ownQuote = (await api('/api/me/testimonial')).testimonial;
  } catch {
    ownQuote = null;
  }
  renderOwnQuote();
}

$('ownQuote').addEventListener('input', renderOwnQuote);
$('ownQuoteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('ownQuoteSend'), $('ownQuoteError'), async () => {
    const data = await post('/api/me/testimonial', { quote: $('ownQuote').value, consent: $('ownQuoteConsent').checked });
    ownQuote = data.testimonial;
    $('ownQuote').value = '';
    $('ownQuoteConsent').checked = false;
    renderOwnQuote();
    toast(t('testimonial.sent'));
  });
});
$('ownQuoteWithdraw').addEventListener('click', () => {
  if (!window.confirm(t('testimonial.withdraw-confirm'))) return;
  withBusy($('ownQuoteWithdraw'), $('ownQuoteError'), async () => {
    ownQuote = (await api('/api/me/testimonial', { method: 'DELETE', body: {} })).testimonial;
    renderOwnQuote();
    toast(t('testimonial.withdrawn'));
  });
});

function updateBioCount() {
  $('bioCount').textContent = t('field.bio-count', { used: [...$('bio').value].length, max: 512 });
}
$('bio').addEventListener('input', updateBioCount);

$('profileForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('profileSave'), $('profileError'), async () => {
    const data = await api('/api/me/page', { method: 'PATCH', body: { displayName: $('displayName').value, bio: $('bio').value } });
    page = data.page;
    renderProfile();
    toast(t('common.saved'));
  });
});

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

function renderShare() {
  $('shareQr').innerHTML = qrSvg(pageUrl(), t('share.qr-label', { slug: page.slug }));
  $('shareNative').hidden = typeof navigator.share !== 'function';
}

$('shareCopy').addEventListener('click', () => copyText(pageUrl()));
$('shareDownload').addEventListener('click', () => downloadQr(pageUrl(), `onelink-${page.slug}-qr.png`));
$('shareNative').addEventListener('click', () => {
  navigator.share({ title: page.displayName || page.slug, url: pageUrl() }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

let stats = null;
let statsDays = 30;
let statsSeries = 'visits';

async function loadStats() {
  const tiles = $('statsTiles');
  tiles.setAttribute('aria-busy', 'true');
  if (!stats) tiles.replaceChildren(...Array.from({ length: 4 }, () => el('div', { class: 'skeleton delayed stat-tile', 'aria-hidden': 'true' })));
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
  if (code === 'XX') return t('stats.unknown');
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

function tile(label, value, note) {
  return el('div', { class: 'stat-tile' }, [
    el('div', { class: 'value', text: value }),
    el('div', { class: 'label', text: label }),
    note ? el('div', { class: 'note', text: note }) : null,
  ]);
}

function renderStats() {
  document.querySelectorAll('#statsPeriod [data-days]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === statsDays)));
  document.querySelectorAll('#statsSeries [data-series]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.series === statsSeries)));
  if (!stats || !page) return;
  const { totals } = stats;
  const rate = totals.visits > 0 ? `${Math.round((totals.clicks / totals.visits) * 100)}%` : '–';
  const topCountry = stats.countries.find((c) => c.key !== 'XX');
  const topSource = stats.referrers.find((r) => r.key);
  $('statsTiles').replaceChildren(
    tile(t('stats.visits'), formatNumber(totals.visits)),
    tile(t('stats.clicks'), formatNumber(totals.clicks)),
    tile(t('stats.click-rate'), rate, t('stats.click-rate-note')),
    tile(t('stats.top-country'), topCountry ? countryName(topCountry.key) : '–', topSource ? t('stats.top-source', { site: topSource.key }) : null),
  );

  const series = statsSeries;
  const title = t(`stats.chart-${series}`, { days: statsDays });
  $('statsChartTitle').textContent = title;
  drawColumns($('statsChart'), stats.daily.map((d) => ({ day: d.day, value: d[series] })), {
    label: title,
    caption: title,
    describe: (p) => t(`stats.tip-${series}`, { day: dayLabel(p.day, { weekday: 'short', day: 'numeric', month: 'short' }), count: p.value, n: formatNumber(p.value) }),
  });

  fillBarList($('statsCountries'), stats.countries.map((c) => ({ label: countryName(c.key), value: c.hits })), t('stats.none'));
  fillBarList($('statsReferrers'), stats.referrers.map((r) => ({ label: r.key || t('stats.direct'), value: r.hits })), t('stats.none'));
  fillBarList($('statsDevices'), stats.devices.map((d) => ({ label: t(`stats.device-${d.key}`), value: d.hits })), t('stats.none'));
  const linked = page.links.filter((l) => !l.removed && l.clicks > 0).sort((a, b) => b.clicks - a.clicks).slice(0, 5);
  fillBarList($('statsLinks'), linked.map((l) => ({ label: l.title, value: l.clicks })), t('stats.none'));
}

$('statsPeriod').addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]');
  if (!b || Number(b.dataset.days) === statsDays) return;
  statsDays = Number(b.dataset.days);
  renderStats();
  loadStats();
});
$('statsSeries').addEventListener('click', (e) => {
  const b = e.target.closest('[data-series]');
  if (!b) return;
  statsSeries = b.dataset.series;
  renderStats();
});
// Columns are laid out for the chart's width, so a resize redraws them.
new ResizeObserver(() => { if (stats && !$('panel-stats').hidden) renderStats(); }).observe($('statsChart'));

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function renderSecurity() {
  const s = page.security;
  const passkeyCount = s.passkeys.length;
  const factors = (s.totp ? 1 : 0) + passkeyCount;

  $('totpState').textContent = t(s.totp ? 'security.on' : 'security.off');
  $('totpAdd').hidden = s.totp;
  $('totpRemove').hidden = !s.totp;
  $('totpRemove').disabled = factors <= 1;
  $('totpRemove').title = factors <= 1 ? t('security.last-factor') : '';

  $('passkeyState').textContent = t('security.passkey-count', { count: passkeyCount, n: formatNumber(passkeyCount) });
  $('passkeyAdd').disabled = !passkeysSupported();
  $('passkeyList').replaceChildren(...s.passkeys.map((key, n) => {
    const remove = el('button', { class: 'btn btn-small btn-quiet', type: 'button', disabled: factors <= 1, title: factors <= 1 ? t('security.last-factor') : undefined });
    remove.textContent = t('common.remove');
    remove.addEventListener('click', () => askPassword((password) => post('/api/me/security', { action: 'passkey-remove', id: key.id, password }), () => toast(t('security.passkey-removed'))));
    return el('li', {}, [
      el('div', {}, [
        el('div', { text: key.label || t('security.passkey-n', { n: n + 1 }) }),
        el('small', { text: key.lastUsedAt ? t('security.last-used', { when: formatDate(key.lastUsedAt) }) : t('security.added', { when: formatDate(key.createdAt) }) }),
      ]),
      remove,
    ]);
  }));

  $('codesState').textContent = t('security.codes-left', { count: s.backupCodesLeft, n: formatNumber(s.backupCodesLeft) });
  $('codesState').classList.toggle('warn', s.backupCodesLeft <= 2);

  $('telegramSection').hidden = !s.telegramAvailable && !s.telegram.linked;
  $('telegramState').textContent = s.telegram.linked
    ? (s.telegram.username ? t('telegram.linked-as', { username: s.telegram.username }) : t('telegram.linked'))
    : t('telegram.not-linked');
  $('telegramLink').hidden = s.telegram.linked || !s.telegramAvailable;
  $('telegramUnlink').hidden = !s.telegram.linked;

  $('keepLiveState').textContent = page.dormantFrom
    ? t('security.keep-live-until', { date: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(new Date(page.dormantFrom)) })
    : '';
}

// Ask for the password, then run fn(password). A wrong password keeps the
// dialog open with the error; success closes it and hands the answer on.
let pending = null;
function askPassword(fn, then) {
  pending = { fn, then };
  $('confirmPassword').value = '';
  $('passwordError').textContent = '';
  openModal('passwordModal', { initialFocus: $('confirmPassword') });
}

$('passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pending) return;
  const { fn, then } = pending;
  withBusy($('passwordSubmit'), $('passwordError'), async () => {
    const data = await fn($('confirmPassword').value);
    pending = null;
    closeModal('passwordModal');
    if (data && data.page) setPage(data.page);
    if (then) await then(data);
  });
});

// Authenticator app
let totpChallenge = null;
$('totpAdd').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'totp-start', password }),
  (data) => {
    totpChallenge = data.challenge;
    $('totpQr').innerHTML = qrSvg(data.uri, t('totp.qr-label'));
    $('totpSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
    $('totpCode').value = '';
    $('totpError').textContent = '';
    openModal('totpModal', { initialFocus: $('totpCode') });
  }
));
$('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('totpSubmit'), $('totpError'), async () => {
    const data = await post('/api/me/security', { action: 'totp-finish', challenge: totpChallenge, code: $('totpCode').value });
    closeModal('totpModal');
    setPage(data.page);
    toast(t('security.totp-added'));
  });
});
$('totpRemove').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'totp-remove', password }),
  () => toast(t('security.totp-removed'))
));

// Passkeys
$('passkeyAdd').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'passkey-options', password }),
  async ({ options }) => {
    const button = $('passkeyAdd');
    setBusy(button, true);
    try {
      const response = await createPasskey(options);
      const data = await post('/api/me/security', { action: 'passkey-finish', response });
      setPage(data.page);
      toast(t('security.passkey-added'));
    } catch (error) {
      toast(errorText({ code: passkeyErrorCode(error) }));
    } finally {
      setBusy(button, false);
    }
  }
));

// Backup codes
$('codesRegenerate').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'backup-regenerate', password }),
  (data) => {
    showCodes($('backupCodes'), data.backupCodes, { copyButton: $('codesCopy'), downloadButton: $('codesDownload'), slug: page.slug });
    openModal('codesModal');
  }
));

// Telegram
$('telegramLink').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'telegram-link', password }),
  (data) => {
    $('telegramOpen').href = data.url;
    openModal('telegramModal', { initialFocus: $('telegramOpen') });
  }
));
$('telegramDone').addEventListener('click', async () => {
  const data = await api('/api/me/page').catch(() => null);
  if (data) setPage(data.page);
  closeModal('telegramModal');
  toast(t(page.security.telegram.linked ? 'telegram.now-linked' : 'telegram.not-yet'));
});
$('telegramUnlink').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'telegram-unlink', password }),
  () => toast(t('telegram.unlinked'))
));

// Password and devices
$('passwordChange').addEventListener('click', () => {
  ['currentPassword', 'changeNewPassword', 'changeNewPasswordConfirm'].forEach((id) => { $(id).value = ''; });
  $('changePasswordError').textContent = '';
  openModal('changePasswordModal', { initialFocus: $('currentPassword') });
});
$('changePasswordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = $('changePasswordError');
  const newPassword = $('changeNewPassword').value;
  if ([...newPassword].length < 10) return void (error.textContent = t('error.password_too_short'));
  if (newPassword !== $('changeNewPasswordConfirm').value) return void (error.textContent = t('error.password_mismatch'));
  withBusy($('changePasswordSubmit'), error, async () => {
    const data = await post('/api/me/security', { action: 'password-change', password: $('currentPassword').value, newPassword });
    closeModal('changePasswordModal');
    setPage(data.page);
    toast(t('security.password-changed'));
  });
});
$('sessionsEnd').addEventListener('click', () => askPassword(
  (password) => post('/api/me/security', { action: 'sessions-end-others', password }),
  () => toast(t('security.signed-out-others'))
));

// Delete
$('pageDelete').addEventListener('click', () => {
  $('deleteConfirmLabel').textContent = t('security.delete-type', { slug: page.slug });
  $('deleteConfirmSlug').value = '';
  $('deletePassword').value = '';
  $('deleteError').textContent = '';
  openModal('deleteModal', { initialFocus: $('deleteConfirmSlug') });
});
$('deleteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('deleteSubmit'), $('deleteError'), async () => {
    await post('/api/me/security', { action: 'delete-page', confirmSlug: $('deleteConfirmSlug').value, password: $('deletePassword').value });
    window.location.replace('/');
  });
});

// Sign out
$('signOut').addEventListener('click', async () => {
  await post('/api/auth/session', { action: 'logout' }).catch(() => {});
  window.location.replace('/');
});

onChange(render);
load();
