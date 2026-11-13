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
const platformName = (entry) => translate(`platform.${entry.id}`);

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
    if (error.code === 'page_banned') {
      view('banned');
    } else if (error.status === 401) {
      view('signedOut');
    } else {
      view('signedOut');
      toast(errorText(error));
    }
  }
}

function setPage(next) {
  if (next) {
    page = next;
  }
  render();
}

function render() {
  if (!page) {
    return;
  }
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
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    if (selected) {
      other.tabIndex = 0;
    } else {
      other.tabIndex = -1;
    }
    byId(other.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) {
    tab.focus();
  }
  // Stats are fetched when first looked at, not with the page.
  if (tab.id === 'tab-stats' && !stats) {
    loadStats();
  }
}

// The arrow keys move to the next or previous tab (the other way round in a
// right-to-left language), wrapping at the ends; Home and End go to the
// first and last.
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const rtl = document.documentElement.dir === 'rtl';
    if (step) {
      event.preventDefault();
      let direction;
      if (rtl) {
        direction = -step;
      } else {
        direction = step;
      }
      selectTab(tabs[(index + direction + tabs.length) % tabs.length], true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectTab(tabs[0], true);
    } else if (event.key === 'End') {
      event.preventDefault();
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
  let showForm = on;
  if (!on) {
    showForm = redirectOpen;
  }
  byId('redirectToggle').checked = showForm;
  form.hidden = !showForm;
  if (on && document.activeElement !== byId('redirectUrl')) {
    byId('redirectUrl').value = page.redirectUrl;
  }
  let stateText;
  if (on) {
    stateText = translate('redirect.on', { url: page.redirectUrl.replace(/^https?:\/\//, '') });
  } else {
    stateText = translate('redirect.off');
  }
  byId('redirectState').textContent = stateText;
  let saveKey;
  if (on) {
    saveKey = 'redirect.update';
  } else {
    saveKey = 'redirect.save';
  }
  byId('redirectSave').querySelector('span').textContent = translate(saveKey);
  byId('redirectLinksNote').hidden = !on;
}

byId('redirectToggle').addEventListener('change', (event) => {
  byId('redirectError').textContent = '';
  if (event.target.checked) {
    redirectOpen = true;
    renderRedirect();
    byId('redirectUrl').focus();
    return;
  }
  redirectOpen = false;
  if (!page.redirectUrl) {
    return renderRedirect();
  }
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

byId('redirectForm').addEventListener('submit', (event) => {
  event.preventDefault();
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

// One row per link: move up and down (links the GFTV team removed stay at
// the end and cannot move), its icon, title, address and clicks or the
// reason it was removed, and the show switch, edit and delete.
function renderLinks() {
  renderLinkCap();
  const list = byId('linkList');
  list.replaceChildren();
  byId('linksEmpty').hidden = page.links.length > 0;
  const movable = page.links.filter((link) => !link.removed);

  page.links.forEach((link) => {
    const index = movable.indexOf(link);
    let upDisabled = link.removed;
    if (!upDisabled) {
      upDisabled = index <= 0;
    }
    const up = createElement('button', {
      class: 'icon-btn small', type: 'button', 'aria-label': translate('link.move-up', { title: link.title }),
      disabled: upDisabled, onclick: () => move(link, -1),
    });
    up.innerHTML = icon('arrow-up');
    let downDisabled = link.removed;
    if (!downDisabled) {
      downDisabled = index < 0;
    }
    if (!downDisabled) {
      downDisabled = index >= movable.length - 1;
    }
    const down = createElement('button', {
      class: 'icon-btn small', type: 'button', 'aria-label': translate('link.move-down', { title: link.title }),
      disabled: downDisabled, onclick: () => move(link, 1),
    });
    down.innerHTML = icon('arrow-down');

    const title = createElement('div', { class: 'title' }, [iconNode(link.icon), createElement('span', { text: link.title })]);
    if (link.removed) {
      title.append(createElement('span', { class: 'badge danger', text: translate('link.removed') }));
    } else if (!link.isActive) {
      title.append(createElement('span', { class: 'badge', text: translate('link.hidden') }));
    }

    let statsText;
    if (link.removed) {
      let reason = link.removedReason;
      if (!reason) {
        reason = translate('link.removed-no-reason');
      }
      statsText = translate('link.removed-reason', { reason });
    } else {
      statsText = translate('link.clicks', { count: link.clicks, n: formatNumber(link.clicks) });
    }
    const meta = createElement('div', { class: 'meta' }, [
      title,
      createElement('div', { class: 'url', text: link.url }),
      createElement('div', { class: 'stats', text: statsText }),
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

    // A hidden or removed link's row is dimmed.
    let offClass;
    if (link.isActive && !link.removed) {
      offClass = '';
    } else {
      offClass = ' off';
    }
    list.append(createElement('li', { class: `edit-link${offClass}` }, [
      createElement('div', { class: 'order' }, [up, down]),
      meta,
      controls,
    ]));
  });
}

// Every answer from /api/me/links is the whole list, and the limit with it.
function takeLinks(data) {
  page.links = data.links;
  if (data.linkCap) {
    page.linkCap = data.linkCap;
  }
}

// A refusal for being at the limit says what the limit is now, which may be
// lower than when the editor loaded.
function noteLimit(error) {
  if (error !== null && error !== undefined
    && error.code === 'too_many_links'
    && page.linkCap
    && error.detail !== null && error.detail !== undefined
    && Number.isInteger(error.detail.limit)) {
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
  const movable = page.links.filter((other) => !other.removed);
  const from = movable.indexOf(link);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= movable.length) {
    return;
  }
  movable.splice(to, 0, movable.splice(from, 1)[0]);
  const ids = [...movable, ...page.links.filter((other) => other.removed)].map((other) => other.id);
  if (await saveLink({ action: 'reorder', ids }, 'POST')) {
    // Keep focus on the same control of the moved link, so moving twice is
    // two key presses rather than a hunt. When that arrow is now disabled
    // (the link reached the top or bottom), the row's first enabled button
    // takes it.
    const row = [...byId('linkList').children][page.links.findIndex((other) => other.id === link.id)];
    let target;
    if (row !== null && row !== undefined) {
      let arrowIndex;
      if (delta < 0) {
        arrowIndex = 0;
      } else {
        arrowIndex = 1;
      }
      target = row.querySelectorAll('.order .icon-btn')[arrowIndex];
    }
    let focusTarget;
    if (target && !target.disabled) {
      focusTarget = target;
    } else if (row !== null && row !== undefined) {
      focusTarget = row.querySelector('.icon-btn:not([disabled])');
    }
    if (focusTarget !== null && focusTarget !== undefined) {
      focusTarget.focus();
    }
  }
}

function deleteLink(link) {
  if (!window.confirm(translate('link.delete-confirm', { title: link.title }))) {
    return;
  }
  saveLink({ id: link.id }, 'DELETE').then((saved) => {
    if (saved) {
      toast(translate('link.deleted'));
    }
  });
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
    for (const entry of PLATFORMS.filter((item) => item.category === category)) {
      group.append(createElement('option', { value: entry.id, text: platformName(entry) }));
    }
    select.append(group);
  }
}

// Every icon, grouped by category, with the chosen one pressed. A service
// logo is labelled with the service's name.
function renderIconPicker() {
  const picker = byId('iconPicker');
  picker.replaceChildren();
  for (const [category, names] of ICON_CATEGORIES) {
    const heading = createElement('p', { class: 'icon-category', id: `icons-${category}`, text: translate(`icon.category-${category}`) });
    const grid = createElement('div', { class: 'icon-picker', role: 'group', 'aria-labelledby': `icons-${category}` });
    for (const name of names) {
      const brand = PLATFORMS.find((entry) => {
        if (entry.icon === name && brandTitle(name)) {
          return true;
        }
        return false;
      });
      let label;
      if (brand) {
        label = platformName(brand);
      } else {
        label = brandTitle(name);
        if (!label) {
          label = translate(`icon.${name}`);
        }
      }
      const button = createElement('button', { type: 'button', 'aria-pressed': String(name === chosenIcon), 'aria-label': label, title: label });
      button.innerHTML = icon(name);
      button.addEventListener('click', () => {
        chosenIcon = name;
        iconTouched = true;
        renderIconPicker();
        const pressed = picker.querySelector('[aria-pressed="true"]');
        if (pressed !== null && pressed !== undefined) {
          pressed.focus();
        }
      });
      grid.append(button);
    }
    picker.append(heading, grid);
  }
  // Keep the chosen icon in view inside the scrolling box, without moving
  // the dialog itself.
  const chosen = picker.querySelector('[aria-pressed="true"]');
  if (chosen) {
    picker.scrollTop = chosen.offsetTop - picker.offsetTop - picker.clientHeight / 2 + chosen.offsetHeight / 2;
  }
}

function setIconFromLink() {
  if (iconTouched) {
    return;
  }
  if (platform) {
    chosenIcon = platform.icon;
  } else {
    const matched = matchPlatform(byId('linkUrl').value);
    if (matched) {
      chosenIcon = matched.platform.icon;
    } else {
      chosenIcon = guessIcon(byId('linkUrl').value);
    }
  }
  renderIconPicker();
}

// The username field's start, end, example and the address it makes.
function renderPlatformFields() {
  const isPlatform = Boolean(platform);
  byId('linkPlatformFields').hidden = !isPlatform;
  byId('linkUrlField').hidden = isPlatform;
  if (!isPlatform) {
    return;
  }

  const formatSelect = byId('linkFormat');
  formatSelect.replaceChildren(...platform.formats.map((formatOption) => createElement('option', { value: formatOption.id, text: translate(`link.format-${formatOption.id}`) })));
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
  let noteText;
  if (format.note) {
    noteText = translate(format.note);
  } else {
    noteText = '';
  }
  byId('linkFormatNote').textContent = noteText;
  updateUrlPreview();
}

function updateUrlPreview() {
  if (!platform) {
    return;
  }
  const username = cleanUsername(format, byId('linkUsername').value);
  const preview = byId('linkUrlPreview');
  if (!username) {
    preview.textContent = '';
    return;
  }
  if (usernameOk(format, username)) {
    preview.textContent = translate('link.will-open', { url: buildUrl(format, username) });
  } else {
    preview.textContent = translate(format.invalid, { platform: platformName(platform) });
  }
  preview.classList.toggle('bad', !usernameOk(format, username));
}

// The owner picked a link type: a platform (by id) or a custom address.
function choosePlatform(id, { keepUsername = false } = {}) {
  let previousName;
  if (platform) {
    previousName = platformName(platform);
  } else {
    previousName = '';
  }
  platform = platformById(id);
  if (platform) {
    format = platform.formats[0];
  } else {
    format = null;
  }
  if (!keepUsername) {
    byId('linkUsername').value = '';
  }
  // Fill the title with the platform's name, unless the owner wrote their own.
  const title = byId('linkTitle');
  if (platform && (!title.value || title.value === previousName || title.value === autoTitle)) {
    title.value = platformName(platform);
    autoTitle = platformName(platform);
  }
  renderPlatformFields();
  setIconFromLink();
}

// Open the dialog empty to add a link, or filled in to edit one.
function openLinkModal(link = null) {
  editing = link;
  buildLinkTypes();
  let titleKey;
  if (link) {
    titleKey = 'link.edit-title';
  } else {
    titleKey = 'link.add-title';
  }
  byId('linkModalTitle').textContent = translate(titleKey);
  let titleValue;
  if (link) {
    titleValue = link.title;
  } else {
    titleValue = '';
  }
  byId('linkTitle').value = titleValue;
  let urlValue;
  if (link) {
    urlValue = link.url;
  } else {
    urlValue = '';
  }
  byId('linkUrl').value = urlValue;
  byId('linkUsername').value = '';
  if (link) {
    chosenIcon = link.icon;
  } else {
    chosenIcon = 'link';
  }
  iconTouched = Boolean(link);
  autoTitle = '';
  byId('linkError').textContent = '';

  // An existing link to a known platform opens as that platform, with its
  // username, so changing it means typing only the name again.
  let matched;
  if (link) {
    matched = matchPlatform(link.url);
  } else {
    matched = null;
  }
  if (matched) {
    platform = matched.platform;
  } else {
    platform = null;
  }
  if (matched) {
    format = matched.format;
  } else {
    format = null;
  }
  let typeValue;
  if (platform) {
    typeValue = platform.id;
  } else {
    typeValue = '';
  }
  byId('linkType').value = typeValue;
  if (matched) {
    byId('linkUsername').value = matched.username;
  }
  renderPlatformFields();
  renderIconPicker();
  openModal('linkModal', { initialFocus: byId('linkType') });
}

byId('addLink').addEventListener('click', () => openLinkModal());
byId('linkType').addEventListener('change', (event) => choosePlatform(event.target.value));
byId('linkFormat').addEventListener('change', (event) => {
  let chosenFormat = platform.formats.find((formatOption) => formatOption.id === event.target.value);
  if (!chosenFormat) {
    chosenFormat = platform.formats[0];
  }
  format = chosenFormat;
  renderPlatformFields();
});
byId('linkUsername').addEventListener('input', updateUrlPreview);
// A whole address pasted into the username field is cut down to the name.
byId('linkUsername').addEventListener('change', () => {
  if (platform) {
    byId('linkUsername').value = cleanUsername(format, byId('linkUsername').value);
  }
  updateUrlPreview();
});
byId('linkUrl').addEventListener('input', setIconFromLink);

// Save the dialog. A platform link's address is built from the username,
// which has to fit the platform's format first. An empty title becomes the
// platform's name.
byId('linkForm').addEventListener('submit', (event) => {
  event.preventDefault();
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
  let title = byId('linkTitle').value.trim();
  if (!title) {
    if (platform) {
      title = platformName(platform);
    } else {
      title = '';
    }
  }
  withBusy(byId('linkSave'), byId('linkError'), async () => {
    const body = { title, url, icon: chosenIcon };
    let data;
    try {
      if (editing) {
        data = await api('/api/me/links', { method: 'PATCH', body: { id: editing.id, ...body } });
      } else {
        data = await post('/api/me/links', body);
      }
    } catch (error) {
      noteLimit(error);
      throw error;
    }
    takeLinks(data);
    renderLinks();
    closeModal('linkModal');
    let doneKey;
    if (editing) {
      doneKey = 'link.saved';
    } else {
      doneKey = 'link.added';
    }
    toast(translate(doneKey));
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
  return page.links.filter((link) => !link.removed).length;
}

// A decline can come with a smaller raise (granted), which reads differently.
function capRequestText(request) {
  let key;
  if (request.status === 'declined' && request.granted) {
    key = 'compromise';
  } else {
    key = request.status;
  }
  let granted = request.granted;
  if (granted === null || granted === undefined) {
    granted = 0;
  }
  const text = translate(`link-cap.status-${key}`, {
    requested: formatNumber(request.requested),
    granted: formatNumber(granted),
    when: formatDate(request.sentAt),
  });
  if (request.note) {
    return `${text} ${translate('link-cap.note', { note: request.note })}`;
  }
  return text;
}

// The limit, how much of it is used, and the request for more: the form to
// ask, or the request waiting for an answer, or the last answer.
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
  let notice;
  if (used > cap.limit) {
    notice = translate('link-cap.over', numbers);
  } else if (used === cap.limit) {
    notice = translate('link-cap.full');
  } else {
    notice = '';
  }
  byId('linkCapNotice').textContent = notice;
  byId('addLink').disabled = used >= cap.limit;

  const request = page.linkCapRequest;
  // The request's status, or undefined when there is no request.
  let requestStatus;
  if (request !== null && request !== undefined) {
    requestStatus = request.status;
  }
  const requestPending = requestStatus === 'pending';
  const atMost = cap.limit >= MAX_LINK_CAP;
  let hideBox = false;
  if (atMost && !request) {
    hideBox = true;
  }
  box.hidden = hideBox;
  const status = byId('capRequestStatus');
  status.classList.toggle('ok', requestStatus === 'approved');
  let declinedOutright = false;
  if (requestStatus === 'declined' && !request.granted) {
    declinedOutright = true;
  }
  status.classList.toggle('warn', declinedOutright);
  if (request) {
    status.textContent = capRequestText(request);
  } else {
    status.textContent = '';
  }
  let hideForm = requestPending;
  if (!requestPending) {
    hideForm = atMost;
  }
  byId('capRequestForm').hidden = hideForm;
  byId('capWithdrawRow').hidden = !requestPending;
  byId('capRequested').min = String(Math.min(cap.limit + 1, MAX_LINK_CAP));
  byId('capReasonCount').textContent = translate('field.bio-count', { used: [...byId('capReason').value].length, max: 500 });
}

function takeCap(data) {
  page.linkCap = data.linkCap;
  page.linkCapRequest = data.request;
  renderLinks();
}

byId('capReason').addEventListener('input', renderLinkCap);
byId('capRequestForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('capRequestSend'), byId('capRequestError'), async () => {
    takeCap(await post('/api/me/link-cap', { requested: byId('capRequested').value, reason: byId('capReason').value }));
    byId('capRequested').value = '';
    byId('capReason').value = '';
    renderLinkCap();
    toast(translate('link-cap.sent'));
  });
});
byId('capRequestWithdraw').addEventListener('click', () => {
  if (!window.confirm(translate('link-cap.withdraw-confirm'))) {
    return;
  }
  withBusy(byId('capRequestWithdraw'), byId('capRequestError'), async () => {
    takeCap(await api('/api/me/link-cap', { method: 'DELETE', body: {} }));
    toast(translate('link-cap.withdrawn'));
  });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

// The name and bio fields (left alone while the owner is typing in them),
// the picture, and its buttons.
function renderProfile() {
  if (document.activeElement !== byId('displayName')) {
    byId('displayName').value = page.displayName;
  }
  if (document.activeElement !== byId('bio')) {
    byId('bio').value = page.bio;
  }
  byId('displayName').placeholder = page.slug;
  updateBioCount();
  let name = page.displayName;
  if (!name) {
    name = page.slug;
  }
  fillAvatar(byId('avatarPreview'), page.avatarUrl, name);
  byId('avatarRemove').hidden = !page.avatarUrl;
  let pickKey;
  if (page.avatarUrl) {
    pickKey = 'avatar.change';
  } else {
    pickKey = 'avatar.upload';
  }
  byId('avatarPickLabel').textContent = translate(pickKey);
}

// Picking a file opens the picture editor (js/avatar-composer.js), where it
// is framed, optionally cut out, and only then uploaded.
byId('avatarFile').addEventListener('change', async () => {
  const input = byId('avatarFile');
  const files = input.files;
  let file = files;
  if (files) {
    file = files[0];
  }
  input.value = '';
  if (!file) {
    return;
  }
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

// The testimonial's status (waiting, up or declined), the send or replace
// button, withdraw, and the length counter.
function renderOwnQuote() {
  const status = byId('ownQuoteStatus');
  status.hidden = !ownQuote;
  // The testimonial's status, or undefined when there is none.
  let quoteStatus;
  if (ownQuote !== null && ownQuote !== undefined) {
    quoteStatus = ownQuote.status;
  }
  status.classList.toggle('ok', quoteStatus === 'approved');
  status.classList.toggle('warn', quoteStatus === 'declined');
  if (ownQuote) {
    status.textContent = translate(`testimonial.status-${ownQuote.status}`, { quote: ownQuote.quote });
  }
  byId('ownQuoteWithdraw').hidden = !ownQuote;
  let sendKey;
  if (ownQuote) {
    sendKey = 'testimonial.replace';
  } else {
    sendKey = 'testimonial.send';
  }
  byId('ownQuoteSend').querySelector('span:last-child').textContent = translate(sendKey);
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
byId('ownQuoteForm').addEventListener('submit', (event) => {
  event.preventDefault();
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
  if (!window.confirm(translate('testimonial.withdraw-confirm'))) {
    return;
  }
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

byId('profileForm').addEventListener('submit', (event) => {
  event.preventDefault();
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
  let title = page.displayName;
  if (!title) {
    title = page.slug;
  }
  navigator.share({ title, url: pageUrl() }).catch(() => {});
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
  if (!stats) {
    tiles.replaceChildren(...Array.from({ length: 4 }, () => createElement('div', { class: 'skeleton delayed stat-tile', 'aria-hidden': 'true' })));
  }
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
  if (code === 'XX') {
    return translate('stats.unknown');
  }
  try {
    const name = new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code);
    if (name) {
      return name;
    }
    return code;
  } catch {
    return code;
  }
}

// words: the value is a name (a country), not a number, so it is set smaller
// and wraps between words rather than through them.
function tile(label, value, note, { words = false } = {}) {
  let valueClass;
  if (words) {
    valueClass = 'value words';
  } else {
    valueClass = 'value';
  }
  const valueElement = createElement('div', { class: valueClass, text: value });
  const labelElement = createElement('div', { class: 'label', text: label });
  let noteElement;
  if (note) {
    noteElement = createElement('div', { class: 'note', text: note });
  } else {
    noteElement = null;
  }
  return createElement('div', { class: 'stat-tile' }, [
    valueElement,
    labelElement,
    noteElement,
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
  grid.querySelectorAll('.stat-tile.wide').forEach((wideTile) => wideTile.classList.remove('wide'));
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
  if (!overflows()) {
    return;
  }
  tile.classList.add('wide');
  // In two columns the tile before it would be left alone in its row, so it
  // takes the whole row too.
  if (getComputedStyle(grid).gridTemplateColumns.split(' ').length === 2) {
    const before = tile.previousElementSibling;
    if (before !== null && before !== undefined) {
      before.classList.add('wide');
    }
  }
  value.style.fontSize = '';
  shrink();
}
// The site font can arrive after the first render and is wider than the
// fallback, so fit again once it has.
const fonts = document.fonts;
if (fonts !== null && fonts !== undefined) {
  fonts.ready.then(() => byId('statsTiles').querySelectorAll('.value.words').forEach(fitWords));
}

// The period and series buttons, the four tiles (visits, clicks, click rate,
// top country with the top source), the daily chart, and the lists of
// countries, sources, devices and the five most clicked links.
function renderStats() {
  document.querySelectorAll('#statsPeriod [data-days]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.days) === statsDays)));
  document.querySelectorAll('#statsSeries [data-series]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.series === statsSeries)));
  if (!stats || !page) {
    return;
  }
  const { totals } = stats;
  let rate;
  if (totals.visits > 0) {
    rate = `${Math.round((totals.clicks / totals.visits) * 100)}%`;
  } else {
    rate = '–';
  }
  const topCountry = stats.countries.find((country) => country.key !== 'XX');
  const topSource = stats.referrers.find((referrer) => referrer.key);
  let topCountryName;
  if (topCountry) {
    topCountryName = countryName(topCountry.key);
  } else {
    topCountryName = '–';
  }
  let topSourceNote;
  if (topSource) {
    topSourceNote = translate('stats.top-source', { site: topSource.key });
  } else {
    topSourceNote = null;
  }
  byId('statsTiles').replaceChildren(
    tile(translate('stats.visits'), formatNumber(totals.visits)),
    tile(translate('stats.clicks'), formatNumber(totals.clicks)),
    tile(translate('stats.click-rate'), rate, translate('stats.click-rate-note')),
    tile(translate('stats.top-country'), topCountryName, topSourceNote, { words: Boolean(topCountry) }),
  );
  byId('statsTiles').querySelectorAll('.value.words').forEach(fitWords);

  const series = statsSeries;
  const title = translate(`stats.chart-${series}`, { days: statsDays });
  byId('statsChartTitle').textContent = title;
  drawColumns(byId('statsChart'), stats.daily.map((entry) => ({ day: entry.day, value: entry[series] })), {
    label: title,
    caption: title,
    describe: (point) => translate(`stats.tip-${series}`, { day: dayLabel(point.day, { weekday: 'short', day: 'numeric', month: 'short' }), count: point.value, n: formatNumber(point.value) }),
  });

  fillBarList(byId('statsCountries'), stats.countries.map((country) => ({ label: countryName(country.key), value: country.hits })), translate('stats.none'));
  fillBarList(byId('statsReferrers'), stats.referrers.map((referrer) => {
    let label = referrer.key;
    if (!label) {
      label = translate('stats.direct');
    }
    return { label, value: referrer.hits };
  }), translate('stats.none'));
  fillBarList(byId('statsDevices'), stats.devices.map((device) => ({ label: translate(`stats.device-${device.key}`), value: device.hits })), translate('stats.none'));
  const linked = page.links.filter((link) => {
    if (!link.removed && link.clicks > 0) {
      return true;
    }
    return false;
  }).sort((first, second) => second.clicks - first.clicks).slice(0, 5);
  fillBarList(byId('statsLinks'), linked.map((link) => ({ label: link.title, value: link.clicks })), translate('stats.none'));
}

byId('statsPeriod').addEventListener('click', (event) => {
  const button = event.target.closest('[data-days]');
  if (!button || Number(button.dataset.days) === statsDays) {
    return;
  }
  statsDays = Number(button.dataset.days);
  renderStats();
  loadStats();
});
byId('statsSeries').addEventListener('click', (event) => {
  const button = event.target.closest('[data-series]');
  if (!button) {
    return;
  }
  statsSeries = button.dataset.series;
  renderStats();
});
// Columns are laid out for the chart's width, so a resize redraws them.
new ResizeObserver(() => {
  if (stats && !byId('panel-stats').hidden) {
    renderStats();
  }
}).observe(byId('statsChart'));

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

// The second factors (authenticator app, passkeys, backup codes), Telegram,
// how long the page stays live, and the page name. The last second factor
// cannot be removed.
function renderSecurity() {
  const security = page.security;
  const passkeyCount = security.passkeys.length;
  let totpCount;
  if (security.totp) {
    totpCount = 1;
  } else {
    totpCount = 0;
  }
  const factors = totpCount + passkeyCount;

  let totpKey;
  if (security.totp) {
    totpKey = 'security.on';
  } else {
    totpKey = 'security.off';
  }
  byId('totpState').textContent = translate(totpKey);
  byId('totpAdd').hidden = security.totp;
  byId('totpRemove').hidden = !security.totp;
  byId('totpRemove').disabled = factors <= 1;
  let totpRemoveTitle;
  if (factors <= 1) {
    totpRemoveTitle = translate('security.last-factor');
  } else {
    totpRemoveTitle = '';
  }
  byId('totpRemove').title = totpRemoveTitle;

  byId('passkeyState').textContent = translate('security.passkey-count', { count: passkeyCount, n: formatNumber(passkeyCount) });
  byId('passkeyAdd').disabled = !passkeysSupported();
  byId('passkeyList').replaceChildren(...security.passkeys.map((key, keyIndex) => {
    let removeTitle;
    if (factors <= 1) {
      removeTitle = translate('security.last-factor');
    } else {
      removeTitle = undefined;
    }
    const remove = createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', disabled: factors <= 1, title: removeTitle });
    remove.textContent = translate('common.remove');
    remove.addEventListener('click', () => askPassword((password) => post('/api/me/security', { action: 'passkey-remove', id: key.id, password }), () => toast(translate('security.passkey-removed'))));
    let keyName = key.label;
    if (!keyName) {
      keyName = translate('security.passkey-n', { n: keyIndex + 1 });
    }
    let usedText;
    if (key.lastUsedAt) {
      usedText = translate('security.last-used', { when: formatDate(key.lastUsedAt) });
    } else {
      usedText = translate('security.added', { when: formatDate(key.createdAt) });
    }
    return createElement('li', {}, [
      createElement('div', {}, [
        createElement('div', { text: keyName }),
        createElement('small', { text: usedText }),
      ]),
      remove,
    ]);
  }));

  byId('codesState').textContent = translate('security.codes-left', { count: security.backupCodesLeft, n: formatNumber(security.backupCodesLeft) });
  byId('codesState').classList.toggle('warn', security.backupCodesLeft <= 2);

  let hideTelegram = false;
  if (!security.telegramAvailable && !security.telegram.linked) {
    hideTelegram = true;
  }
  byId('telegramSection').hidden = hideTelegram;
  let telegramText;
  if (security.telegram.linked) {
    if (security.telegram.username) {
      telegramText = translate('telegram.linked-as', { username: security.telegram.username });
    } else {
      telegramText = translate('telegram.linked');
    }
  } else {
    telegramText = translate('telegram.not-linked');
  }
  byId('telegramState').textContent = telegramText;
  let hideLink = security.telegram.linked;
  if (!hideLink) {
    hideLink = !security.telegramAvailable;
  }
  byId('telegramLink').hidden = hideLink;
  byId('telegramUnlink').hidden = !security.telegram.linked;

  let keepLiveText;
  if (page.dormantFrom) {
    keepLiveText = translate('security.keep-live-until', { date: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(new Date(page.dormantFrom)) });
  } else {
    keepLiveText = '';
  }
  byId('keepLiveState').textContent = keepLiveText;

  renderRename();
}

// ---------------------------------------------------------------------------
// Page name
// ---------------------------------------------------------------------------

const longDate = (iso) => new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(new Date(iso));

// The page name, whether it can be changed yet, and the old name still
// held for the page.
function renderRename() {
  const rename = page.rename;
  // Hidden until the server can keep the old name held (migration 016).
  let hideRename = false;
  if (!rename || !rename.available) {
    hideRename = true;
  }
  byId('renameSection').hidden = hideRename;
  if (!rename || !rename.available) {
    return;
  }
  byId('renameState').textContent = `links.gftv.asia/${page.slug}`;
  byId('renameOpen').disabled = Boolean(rename.nextAt);
  const notes = [];
  if (rename.previous) {
    notes.push(translate('rename.previous', { slug: rename.previous.slug, date: longDate(rename.previous.heldUntil) }));
  }
  if (rename.nextAt) {
    notes.push(translate('rename.next', { date: longDate(rename.nextAt) }));
  }
  byId('renameNote').textContent = notes.join(' ');
  byId('renameNote').hidden = notes.length === 0;
}

const renameCheck = wireSlugCheck(byId('renameSlug'), byId('renameStatus'), {
  current: () => {
    if (page) {
      return page.slug;
    }
    return page;
  },
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

// Change the page name: check the new name here first, then send it with
// the password.
byId('renameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const error = byId('renameError');
  const slug = normaliseSlugInput(byId('renameSlug').value);
  if (!slug) {
    error.textContent = translate('slug.invalid');
    return;
  }
  if (slug === page.slug) {
    error.textContent = translate('error.slug_same');
    return;
  }
  const known = renameCheck();
  // A name that needs approval hides the page until then: say so once more.
  if (known && known.slug === slug && known.review && !window.confirm(translate('rename.review-confirm', { slug }))) {
    return;
  }
  withBusy(byId('renameSubmit'), error, async () => {
    const data = await post('/api/me/security', { action: 'rename', slug, password: byId('renamePassword').value });
    closeModal('renameModal');
    setPage(data.page);
    let doneKey;
    if (data.review) {
      doneKey = 'rename.done-review';
    } else {
      doneKey = 'rename.done';
    }
    toast(translate(doneKey, { slug: data.page.slug }));
  });
});

// Ask for the password, then call run(password). A wrong password keeps the
// dialog open with the error; success closes it and hands the answer on to
// then(answer).
let pending = null;
function askPassword(run, then) {
  pending = { fn: run, then };
  byId('confirmPassword').value = '';
  byId('passwordError').textContent = '';
  openModal('passwordModal', { initialFocus: byId('confirmPassword') });
}

byId('passwordForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!pending) {
    return;
  }
  const run = pending.fn;
  const then = pending.then;
  withBusy(byId('passwordSubmit'), byId('passwordError'), async () => {
    const data = await run(byId('confirmPassword').value);
    pending = null;
    closeModal('passwordModal');
    if (data && data.page) {
      setPage(data.page);
    }
    if (then) {
      await then(data);
    }
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
byId('totpForm').addEventListener('submit', (event) => {
  event.preventDefault();
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
  if (data) {
    setPage(data.page);
  }
  closeModal('telegramModal');
  let linkedKey;
  if (page.security.telegram.linked) {
    linkedKey = 'telegram.now-linked';
  } else {
    linkedKey = 'telegram.not-yet';
  }
  toast(translate(linkedKey));
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
byId('changePasswordForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const error = byId('changePasswordError');
  const newPassword = byId('changeNewPassword').value;
  if ([...newPassword].length < 10) {
    error.textContent = translate('error.password_too_short');
    return;
  }
  if (newPassword !== byId('changeNewPasswordConfirm').value) {
    error.textContent = translate('error.password_mismatch');
    return;
  }
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
byId('deleteForm').addEventListener('submit', (event) => {
  event.preventDefault();
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
