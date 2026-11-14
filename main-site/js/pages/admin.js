// The staff dashboard: sign in with a GFTV account, then moderate.

import '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { openModal, closeModal, withBusy, toast, createElement, formatNumber, formatDate, errorText, setBusy } from '../ui.js';
import { icon, iconNode } from '../icons.js';
import { passkeysSupported, createPasskey, usePasskey, passkeyErrorCode } from '../passkeys.js';
import { fillAvatar } from '../avatar.js';
import { openRegexMaker } from '../regex-maker.js';

const byId = (id) => document.getElementById(id);
let staff = null;

function show(name) {
  byId('adminLoading').hidden = name !== 'loading';
  byId('staffLogin').hidden = name !== 'login';
  byId('dashboard').hidden = name !== 'dashboard';
  byId('staffSignOut').hidden = name !== 'dashboard';
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

let challenge = null;
let method = null;

// The password step. On success it shows only the second factors this
// account can use here, and picks the first of them.
byId('staffPasswordForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('staffPasswordSubmit'), byId('staffPasswordError'), async () => {
    const data = await post('/api/admin/auth', { action: 'login', identifier: byId('staffIdentifier').value, password: byId('staffPassword').value });
    challenge = data.challenge;
    byId('staffPassword').value = '';
    // A passkey also needs a browser that supports them.
    let passkeyUsable = data.methods.passkey;
    if (passkeyUsable) {
      passkeyUsable = passkeysSupported();
    }
    const usable = { totp: data.methods.totp, passkey: passkeyUsable, backup: data.methods.backup };
    document.querySelectorAll('#staffMethods [data-method]').forEach((button) => { button.hidden = !usable[button.dataset.method]; });
    byId('staffPasswordForm').hidden = true;
    byId('staffCodeForm').hidden = false;
    let firstMethod;
    if (usable.totp) {
      firstMethod = 'totp';
    } else if (usable.passkey) {
      firstMethod = 'passkey';
    } else {
      firstMethod = 'backup';
    }
    pickMethod(firstMethod);
  });
});

// Switches the code form to one second factor: a code field for an
// authenticator or backup code, or the passkey button.
function pickMethod(name) {
  method = name;
  document.querySelectorAll('#staffMethods [data-method]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.method === name)));
  byId('staffCodeField').hidden = name === 'passkey';
  byId('staffCodeSubmitRow').hidden = name === 'passkey';
  byId('staffPasskeyRow').hidden = name !== 'passkey';
  let labelKey;
  if (name === 'backup') {
    labelKey = 'field.backup-code';
  } else {
    labelKey = 'field.code';
  }
  byId('staffCodeLabel').textContent = translate(labelKey);
  const input = byId('staffCode');
  input.value = '';
  if (name === 'totp') {
    input.inputMode = 'numeric';
  } else {
    input.inputMode = 'text';
  }
  if (name !== 'passkey') {
    input.focus();
  }
}
document.querySelectorAll('#staffMethods [data-method]').forEach((button) => button.addEventListener('click', () => pickMethod(button.dataset.method)));

function backToPassword(error) {
  if (error.code !== 'challenge_expired') {
    return;
  }
  byId('staffCodeForm').hidden = true;
  byId('staffPasswordForm').hidden = false;
  byId('staffPasswordError').textContent = translate('error.challenge_expired');
}

byId('staffCodeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('staffCodeSubmit'), byId('staffCodeError'), async () => {
    try {
      const data = await post('/api/admin/auth', { action: 'verify', challenge, method, code: byId('staffCode').value });
      enter(data.staff);
    } catch (error) {
      backToPassword(error);
      throw error;
    }
  });
});

byId('staffPasskeyUse').addEventListener('click', () => {
  withBusy(byId('staffPasskeyUse'), byId('staffCodeError'), async () => {
    try {
      const { options } = await post('/api/admin/auth', { action: 'verify', challenge, method: 'passkey-options' });
      let response;
      try {
        response = await usePasskey(options);
      } catch (cause) {
        throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
      }
      const data = await post('/api/admin/auth', { action: 'verify', challenge, method: 'passkey', response });
      enter(data.staff);
    } catch (error) {
      backToPassword(error);
      throw error;
    }
  });
});

byId('staffSignOut').addEventListener('click', async () => {
  await post('/api/admin/auth', { action: 'logout' }).catch(() => {});
  window.location.reload();
});

// Any 401 later on means the session ended or the role was taken away.
function guardSession(error) {
  if (error.status === 401) {
    toast(translate('error.signed_out'));
    show('login');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dashboard shell
// ---------------------------------------------------------------------------

const tabs = [...document.querySelectorAll('#dashboard [role="tab"]')];
const loaders = {};

function selectTab(tab, focus = false) {
  for (const other of tabs) {
    const isSelected = other === tab;
    other.setAttribute('aria-selected', String(isSelected));
    if (isSelected) {
      other.tabIndex = 0;
    } else {
      other.tabIndex = -1;
    }
    byId(other.getAttribute('aria-controls')).hidden = !isSelected;
  }
  if (focus) {
    tab.focus();
  }
  // Each loader is a function, so this runs the tab's loader when it has one.
  const name = tab.id.replace('atab-', '');
  if (loaders[name]) {
    loaders[name]();
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab));
  // The arrow keys move between the visible tabs, wrapping at either end.
  tab.addEventListener('keydown', (event) => {
    const visible = tabs.filter((candidate) => !candidate.hidden);
    const position = visible.indexOf(tab);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step) {
      event.preventDefault();
      selectTab(visible[(position + step + visible.length) % visible.length], true);
    }
  });
});

function enter(user) {
  staff = user;
  let staffName = user.username;
  if (user.displayName) {
    staffName = user.displayName;
  }
  byId('staffWho').textContent = translate('admin.signed-in-as', { name: staffName, role: translate(`admin.role-${user.role}`) });
  document.querySelectorAll('[data-admin-only]').forEach((element) => { element.hidden = user.role !== 'admin'; });
  show('dashboard');
  selectTab(tabs[0]);
}

// Before sign-in staff is null, and this returns that null (read as false).
const isAdmin = () => {
  if (!staff) {
    return staff;
  }
  return staff.role === 'admin';
};

// The controls under a paged list: previous, the range shown, and next.
// Nothing when everything fits on one page.
function pager(container, data, go) {
  container.replaceChildren();
  if (data.total <= data.pageSize) {
    return;
  }
  const from = data.offset + 1;
  const to = Math.min(data.offset + data.pageSize, data.total);
  const previous = createElement('button', { class: 'btn btn-small', type: 'button', disabled: data.offset === 0, onclick: () => go(Math.max(0, data.offset - data.pageSize)) }, [translate('admin.previous')]);
  const next = createElement('button', { class: 'btn btn-small', type: 'button', disabled: to >= data.total, onclick: () => go(data.offset + data.pageSize) }, [translate('admin.next')]);
  container.append(previous, createElement('span', { text: translate('admin.range', { from: formatNumber(from), to: formatNumber(to), total: formatNumber(data.total) }) }), next);
}

function loading(list) {
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(createElement('li', { class: 'list-loading delayed', 'aria-hidden': 'true' }, [createElement('div', { class: 'skeleton' }), createElement('div', { class: 'skeleton' })]));
}

function fill(list, rows, emptyKey) {
  list.removeAttribute('aria-busy');
  let items;
  if (rows.length) {
    items = rows;
  } else {
    items = [createElement('li', { class: 'empty-state', text: translate(emptyKey) })];
  }
  list.replaceChildren(...items);
}

function badge(text, tone = '') {
  return createElement('span', { class: `badge ${tone}`.trim(), text });
}

function actionButton(labelKey, iconName, onclick, tone = '') {
  const button = createElement('button', { class: `btn btn-small ${tone}`.trim(), type: 'button', onclick });
  button.append(iconNode(iconName), createElement('span', { text: translate(labelKey) }));
  return button;
}

function statusBadge(status) {
  let tone;
  if (status === 'banned') {
    tone = 'danger';
  } else if (status === 'active') {
    tone = 'ok';
  } else {
    tone = 'warn';
  }
  return badge(translate(`status.${status}`), tone);
}

// The status, plus what keeps a live page from showing. Each badge that does
// not apply is null, which createElement skips.
function pageBadges(page) {
  let reviewTag = null;
  if (page.awaitingReview) {
    reviewTag = badge(translate('status.review'), 'warn');
  }
  let quarantineTag = null;
  if (page.quarantined) {
    quarantineTag = badge(translate('status.quarantined'), 'danger');
  }
  let dormantTag = null;
  if (page.dormant) {
    dormantTag = badge(translate('status.dormant'), 'warn');
  }
  let redirectTag = null;
  if (page.redirectUrl) {
    redirectTag = badge(translate('admin.redirects'));
  }
  let teamTag = null;
  if (page.team) {
    let teamLabel;
    if (page.team.role) {
      teamLabel = translate('admin.team-badge-role', { role: page.team.role });
    } else {
      teamLabel = translate('team.label');
    }
    teamTag = badge(teamLabel, 'ok');
  }
  return [
    statusBadge(page.status),
    reviewTag,
    quarantineTag,
    dormantTag,
    redirectTag,
    teamTag,
  ];
}

// Admins mark a page as someone on the GFTV team, which puts a ring and a
// tick on its picture. The role is optional and shows beside the mark.
function teamActions(page, after) {
  if (!isAdmin() || page.status !== 'active') {
    return [];
  }
  // Adding the mark and changing the role share one dialog, which starts
  // with the current role (empty when there is none).
  const ask = (titleKey) => {
    let initialRole = '';
    if (page.team && page.team.role) {
      initialRole = page.team.role;
    }
    askReason({
      title: translate(titleKey, { slug: page.slug }),
      body: translate('admin.team-verify-body'),
      required: false,
      label: translate('admin.team-role'),
      maxlength: 40,
      initial: initialRole,
      run: async (role) => {
        await post('/api/admin/pages', { action: 'verify', id: page.id, role });
        toast(translate('admin.team-verified', { slug: page.slug }));
        after();
      },
    });
  };
  if (!page.team) {
    return [actionButton('admin.team-verify', 'shield', () => ask('admin.team-verify-title'), 'btn-primary')];
  }
  return [
    actionButton('admin.team-change-role', 'edit', () => ask('admin.team-change-title')),
    actionButton('admin.team-unverify', 'close', () => askReason({
      title: translate('admin.team-unverify-title', { slug: page.slug }),
      body: translate('admin.team-unverify-body'),
      required: false,
      hideText: true,
      run: async () => {
        await post('/api/admin/pages', { action: 'unverify', id: page.id });
        toast(translate('admin.team-unverified', { slug: page.slug }));
        after();
      },
    }), 'btn-danger'),
  ];
}

// Any staff member can end a quarantine once they have looked.
function releaseAction(page, after) {
  if (!page.quarantined) {
    return null;
  }
  return actionButton('admin.release', 'check', async () => {
    try {
      await post('/api/admin/pages', { action: 'release', id: page.id });
      toast(translate('admin.released', { slug: page.slug }));
      after();
    } catch (error) {
      if (!guardSession(error)) {
        toast(errorText(error));
      }
    }
  }, 'btn-primary');
}

// Any staff member can let a name on the review list go live.
function approveAction(page, after) {
  if (!page.awaitingReview || page.status === 'banned') {
    return null;
  }
  return actionButton('admin.approve', 'check', async () => {
    try {
      await post('/api/admin/pages', { action: 'approve', id: page.id });
      toast(translate('admin.approved', { slug: page.slug }));
      after();
    } catch (error) {
      if (!guardSession(error)) {
        toast(errorText(error));
      }
    }
  }, 'btn-primary');
}

// The shared "give a reason" dialog. confirm, when given, is a page name the
// staff member has to type before an action that cannot be undone.
let reasonAction = null;
// label, maxlength and initial reuse it for a short note such as a team
// role; hideText leaves only the confirm button.
function askReason({ title, body = '', required = true, showRemove = false, confirm = null, label = null, maxlength = 500, initial = '', hideText = false, run }) {
  reasonAction = { run, required, confirm };
  byId('reasonTitle').textContent = title;
  byId('reasonBody').textContent = body;
  byId('reasonText').value = initial;
  byId('reasonText').maxLength = maxlength;
  // A short note (60 characters or fewer) gets a one-line field.
  let rows;
  if (maxlength <= 60) {
    rows = 1;
  } else {
    rows = 3;
  }
  byId('reasonText').rows = rows;
  byId('reasonText').classList.toggle('single-line', maxlength <= 60);
  byId('reasonTextRow').hidden = hideText;
  byId('reasonError').textContent = '';
  byId('reasonRemoveRow').hidden = !showRemove;
  byId('reasonRemoveLink').checked = false;
  byId('reasonConfirmRow').hidden = !confirm;
  byId('reasonConfirm').value = '';
  if (confirm) {
    byId('reasonConfirmLabel').textContent = translate('admin.delete-confirm', { slug: confirm });
  }
  let labelText = label;
  if (!labelText) {
    if (required) {
      labelText = translate('field.reason');
    } else {
      labelText = translate('field.note');
    }
  }
  byId('reasonLabel').textContent = labelText;
  let initialFocus;
  if (hideText) {
    initialFocus = byId('reasonSubmit');
  } else {
    initialFocus = byId('reasonText');
  }
  openModal('reasonModal', { initialFocus });
}
byId('reasonForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!reasonAction) {
    return;
  }
  const text = byId('reasonText').value.trim();
  if (reasonAction.required && !text) {
    byId('reasonError').textContent = translate('error.reason_required');
    return;
  }
  if (reasonAction.confirm && byId('reasonConfirm').value.trim().toLowerCase() !== reasonAction.confirm) {
    byId('reasonError').textContent = translate('admin.delete-mismatch');
    return;
  }
  withBusy(byId('reasonSubmit'), byId('reasonError'), async () => {
    await reasonAction.run(text, byId('reasonRemoveLink').checked);
    closeModal('reasonModal');
  });
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

// The count cards. A card with a tab is a button that opens it, setting the
// pages filter first when it names one; the rest are plain numbers.
loaders.overview = async () => {
  const grid = byId('stats');
  grid.setAttribute('aria-busy', 'true');
  grid.replaceChildren(...Array.from({ length: 6 }, () => createElement('div', { class: 'skeleton delayed stat', 'aria-hidden': 'true' }, [createElement('div', { class: 'value', text: ' ' }), createElement('div', { class: 'label', text: ' ' })])));
  try {
    const { counts } = await api('/api/admin/overview');
    // [count, label, tab to open, page status filter to set first]
    const items = [
      ['openReports', 'admin.stat-open-reports', 'reports'],
      ['awaitingReview', 'admin.stat-review', 'pages', 'review'],
      ['quarantined', 'admin.stat-quarantined', 'pages', 'quarantined'],
      ['pendingTestimonials', 'admin.stat-testimonials', 'testimonials'],
      // Left out before migration 013.
      ['linkCapRequests', 'admin.stat-link-caps', 'caps'],
      ['active', 'admin.stat-active'],
      ['pending', 'admin.stat-pending'],
      ['banned', 'admin.stat-banned'],
      ['links', 'admin.stat-links'],
      ['removed', 'admin.stat-removed'],
    ];
    grid.replaceChildren(...items.filter(([key]) => counts[key] !== undefined).map(([key, label, tab, status]) => {
      // An undefined type is left off the element.
      let tagName = 'div';
      let buttonType;
      if (tab) {
        tagName = 'button';
        buttonType = 'button';
      }
      const card = createElement(tagName, { class: 'glass-card stat', type: buttonType }, [
        createElement('div', { class: 'value', text: formatNumber(counts[key]) }),
        createElement('div', { class: 'label', text: translate(label) }),
      ]);
      if (tab) {
        card.addEventListener('click', () => {
          if (status) {
            byId('pageStatus').value = status;
          }
          selectTab(byId(`atab-${tab}`), true);
        });
      }
      return card;
    }));
    grid.removeAttribute('aria-busy');
  } catch (error) {
    if (!guardSession(error)) {
      grid.replaceChildren(createElement('p', { class: 'callout danger', text: errorText(error) }));
    }
  }
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

let reportOffset = 0;
loaders.reports = async (offset = reportOffset) => {
  reportOffset = offset;
  const list = byId('reportList');
  loading(list);
  try {
    const data = await api(`/api/admin/reports?status=${encodeURIComponent(byId('reportStatus').value)}&offset=${offset}`);
    fill(list, data.reports.map(reportRow), 'admin.empty-reports');
    pager(byId('reportPager'), data, loaders.reports);
  } catch (error) {
    if (!guardSession(error)) {
      fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-reports');
    }
  }
};
byId('reportStatus').addEventListener('change', () => loaders.reports(0));

// One report: what it is about, its tags, and the actions. Open reports can
// be resolved (removing the link, if it is still up) or dismissed.
function reportRow(report) {
  let target;
  if (report.link) {
    target = translate('admin.report-on-link', { title: report.link.title });
  } else {
    target = translate('admin.report-on-page');
  }
  let reasonTone;
  if (report.reason === 'scam' || report.reason === 'malware') {
    reasonTone = 'danger';
  } else {
    reasonTone = 'warn';
  }
  let pageStatusTag = null;
  if (report.pageStatus) {
    pageStatusTag = statusBadge(report.pageStatus);
  }
  let linkRemovedTag = null;
  if (report.link && report.link.removed) {
    linkRemovedTag = badge(translate('admin.link-removed'), 'danger');
  }
  const tags = createElement('div', { class: 'tags' }, [
    badge(translate(`report.reason-${report.reason}`), reasonTone),
    pageStatusTag,
    linkRemovedTag,
  ]);
  let linkAddress = null;
  if (report.link) {
    linkAddress = createElement('div', { class: 'secondary', text: report.link.url });
  }
  let detailsBlock = null;
  if (report.details) {
    detailsBlock = createElement('pre', { text: report.details });
  }
  let resolutionNote = null;
  if (report.resolutionNote) {
    resolutionNote = createElement('div', { class: 'secondary', text: translate('admin.note', { note: report.resolutionNote }) });
  }
  const info = createElement('div', {}, [
    createElement('div', { class: 'primary' }, [createElement('a', { class: 'text-link', href: `/${report.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${report.slug}` }), ` · ${target}`]),
    linkAddress,
    createElement('div', { class: 'secondary', text: formatDate(report.createdAt) }),
    detailsBlock,
    resolutionNote,
    tags,
  ]);
  const actions = createElement('div', { class: 'row-actions' });
  if (report.status === 'open') {
    actions.append(
      actionButton('admin.resolve', 'check', () => {
        // Offer to remove the link only while it is still up.
        let canRemoveLink = false;
        if (report.link && !report.link.removed) {
          canRemoveLink = true;
        }
        askReason({
          title: translate('admin.resolve-title'),
          body: translate('admin.resolve-body'),
          required: false,
          showRemove: canRemoveLink,
          run: async (note, removeLink) => {
            await post('/api/admin/reports', { action: 'resolve', id: report.id, note, removeLink });
            toast(translate('admin.done'));
            loaders.reports();
          },
        });
      }, 'btn-primary'),
      actionButton('admin.dismiss', 'close', () => askReason({
        title: translate('admin.dismiss-title'),
        required: false,
        run: async (note) => {
          await post('/api/admin/reports', { action: 'dismiss', id: report.id, note });
          toast(translate('admin.done'));
          loaders.reports();
        },
      })),
    );
  }
  actions.append(actionButton('admin.view-page', 'eye', () => openPage(report.pageId)));
  const remove = deleteReportAction(report, () => loaders.reports());
  if (remove) {
    actions.append(remove);
  }
  return createElement('li', { class: 'data-row' }, [info, actions]);
}

// Admins can delete a report outright, after a confirmation; the audit log
// keeps what it said.
function deleteReportAction(report, after) {
  if (!isAdmin()) {
    return null;
  }
  return actionButton('admin.delete-report', 'trash', async () => {
    if (!window.confirm(translate('admin.delete-report-confirm'))) {
      return;
    }
    try {
      await post('/api/admin/reports', { action: 'delete', id: report.id });
      toast(translate('admin.report-deleted'));
      after();
    } catch (error) {
      if (!guardSession(error)) {
        toast(errorText(error));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

let pageOffset = 0;
loaders.pages = async (offset = pageOffset) => {
  pageOffset = offset;
  const list = byId('pageList');
  loading(list);
  try {
    const query = encodeURIComponent(byId('pageQuery').value.trim());
    const status = encodeURIComponent(byId('pageStatus').value);
    const data = await api(`/api/admin/pages?q=${query}&status=${status}&offset=${offset}`);
    fill(list, data.pages.map(pageRow), 'admin.empty-pages');
    pager(byId('pagePager'), data, loaders.pages);
  } catch (error) {
    if (!guardSession(error)) {
      fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-pages');
    }
  }
};
byId('pageSearch').addEventListener('submit', (event) => { event.preventDefault(); loaders.pages(0); });
byId('pageStatus').addEventListener('change', () => loaders.pages(0));

// Admins can ban a page (a reason is required) or lift its ban.
function banActions(page, after) {
  if (!isAdmin()) {
    return [];
  }
  if (page.status === 'banned') {
    return [actionButton('admin.unban', 'restore', () => askReason({
      title: translate('admin.unban-title', { slug: page.slug }),
      required: false,
      run: async () => {
        await post('/api/admin/pages', { action: 'unban', id: page.id });
        toast(translate('admin.done'));
        after();
      },
    }))];
  }
  return [actionButton('admin.ban', 'ban', () => askReason({
    title: translate('admin.ban-title', { slug: page.slug }),
    body: translate('admin.ban-body'),
    run: async (reason) => {
      await post('/api/admin/pages', { action: 'ban', id: page.id, reason });
      toast(translate('admin.done'));
      after();
    },
  }), 'btn-danger')];
}

// Deleting frees the name for anyone to register, so it asks for the name to
// be typed as well as a reason.
function deleteAction(page) {
  if (!isAdmin()) {
    return null;
  }
  return actionButton('admin.delete-page', 'trash', () => askReason({
    title: translate('admin.delete-title', { slug: page.slug }),
    body: translate('admin.delete-body', { slug: page.slug }),
    confirm: page.slug,
    run: async (reason) => {
      await post('/api/admin/pages', { action: 'delete', id: page.id, reason, confirmSlug: page.slug });
      // The reason dialog first, so focus goes back past the page's dialog.
      closeModal('reasonModal');
      closeModal('pageModal');
      toast(translate('admin.deleted', { slug: page.slug }));
      if (loaders.pages) {
        loaders.pages();
      }
    },
  }), 'btn-danger');
}

// After a change made in a page's dialog: the lists that may show that page.
function refreshLists() {
  if (loaders.pages) {
    loaders.pages();
  }
  if (loaders.team) {
    loaders.team();
  }
}

// One page in the pages list: its address and name, what is notable about
// it, its badges and counts, and the actions.
function pageRow(page) {
  // An empty string still goes in, as an empty text node.
  let nameSuffix = '';
  if (page.displayName) {
    nameSuffix = ` · ${page.displayName}`;
  }
  let renamedFrom = null;
  if (page.renamedFrom) {
    renamedFrom = createElement('div', { class: 'secondary', text: translate('admin.renamed-from', { slug: page.renamedFrom.slug, when: formatDate(page.renamedFrom.at) }) });
  }
  let banReason = null;
  if (page.banReason) {
    banReason = createElement('div', { class: 'secondary', text: translate('admin.ban-reason', { reason: page.banReason }) });
  }
  let redirect = null;
  if (page.redirectUrl) {
    redirect = createElement('div', { class: 'secondary', text: translate('admin.redirects-to', { url: page.redirectUrl }) });
  }
  let quarantineReason = null;
  if (page.quarantineReason) {
    quarantineReason = createElement('div', { class: 'secondary', text: translate('admin.quarantine-reason', { reason: page.quarantineReason }) });
  }
  let reportCountTag = null;
  if (page.reportCount) {
    reportCountTag = badge(translate('admin.report-count', { count: page.reportCount, n: formatNumber(page.reportCount) }), 'warn');
  }
  let telegramTag = null;
  if (page.telegramLinked) {
    telegramTag = badge(translate('factor.telegram'));
  }
  const info = createElement('div', {}, [
    createElement('div', { class: 'primary' }, [createElement('a', { class: 'text-link', href: `/${page.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${page.slug}` }), nameSuffix]),
    createElement('div', { class: 'secondary', text: translate('admin.created', { when: formatDate(page.createdAt) }) }),
    renamedFrom,
    banReason,
    redirect,
    quarantineReason,
    createElement('div', { class: 'tags' }, [
      ...pageBadges(page),
      badge(translate('admin.link-count', { count: page.linkCount, n: formatNumber(page.linkCount) })),
      reportCountTag,
      telegramTag,
    ]),
  ]);
  return createElement('li', { class: 'data-row' }, [
    info,
    createElement('div', { class: 'row-actions' }, [approveAction(page, () => loaders.pages()), releaseAction(page, () => loaders.pages()), actionButton('admin.view-page', 'eye', () => openPage(page.id)), ...banActions(page, () => loaders.pages())].filter(Boolean)),
  ]);
}

// ---------------------------------------------------------------------------
// Team (admins only): who has the GFTV team mark, adding someone by page
// name, and changing or removing a role, in one place as the team grows.
// ---------------------------------------------------------------------------

let teamOffset = 0;
// One page of the team list, with its count in the heading. A search with no
// match has its own empty message.
loaders.team = async (offset = teamOffset) => {
  if (!isAdmin()) {
    return;
  }
  teamOffset = offset;
  const list = byId('adminTeamList');
  loading(list);
  try {
    const query = encodeURIComponent(byId('teamQuery').value.trim());
    const data = await api(`/api/admin/pages?status=team&q=${query}&offset=${offset}`);
    byId('adminTeamTitle').textContent = translate('admin.team-list-count', { count: data.total, n: formatNumber(data.total) });
    let emptyKey;
    if (query) {
      emptyKey = 'admin.team-empty-search';
    } else {
      emptyKey = 'admin.team-empty';
    }
    fill(list, data.pages.map(teamRow), emptyKey);
    pager(byId('adminTeamPager'), data, loaders.team);
  } catch (error) {
    if (!guardSession(error)) {
      fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.team-empty');
    }
  }
};

// One person on the team: their picture with the tick, address, name, role
// and since when, and the team actions.
function teamRow(page) {
  const avatar = createElement('div', { class: 'avatar small', 'aria-hidden': 'true' });
  let avatarName = page.slug;
  if (page.displayName) {
    avatarName = page.displayName;
  }
  fillAvatar(avatar, page.avatarUrl, avatarName);
  const tick = createElement('span', { class: 'team-tick', 'aria-hidden': 'true' }, [iconNode('check')]);
  // The name only when it says more than the address. An empty string still
  // goes in, as an empty text node.
  let nameSuffix = '';
  if (page.displayName && page.displayName !== page.slug) {
    nameSuffix = ` · ${page.displayName}`;
  }
  let roleText = page.team.role;
  if (!roleText) {
    roleText = translate('admin.team-no-role');
  }
  return createElement('li', { class: 'data-row team-row' }, [
    createElement('div', { class: 'team-row-who' }, [
      createElement('div', { class: 'avatar-wrap small team', 'aria-hidden': 'true' }, [avatar, tick]),
      createElement('div', {}, [
        createElement('div', { class: 'primary' }, [createElement('a', { class: 'text-link', href: `/${page.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${page.slug}` }), nameSuffix]),
        createElement('div', { class: 'secondary', text: [roleText, translate('admin.team-since-short', { when: formatDate(page.team.verifiedAt) })].join(' · ') }),
      ]),
    ]),
    createElement('div', { class: 'row-actions' }, [...teamActions(page, () => loaders.team()), actionButton('admin.view-page', 'eye', () => openPage(page.id))]),
  ]);
}

// The page name as typed, or pasted as an address: "augy", "/augy",
// "links.gftv.asia/augy" and "https://links.gftv.asia/augy/" are all augy.
function teamSlugFrom(input) {
  let typed = '';
  if (input) {
    typed = input;
  }
  return String(typed).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www\.)?links\.gftv\.asia/, '').replace(/^\/+|\/+$/g, '');
}

byId('teamAdd').addEventListener('submit', (event) => {
  event.preventDefault();
  const slug = teamSlugFrom(byId('teamAddSlug').value);
  byId('teamAddError').textContent = '';
  if (!slug) {
    byId('teamAddError').textContent = translate('admin.team-slug-required');
    byId('teamAddSlug').focus();
    return;
  }
  withBusy(byId('teamAddSubmit'), byId('teamAddError'), async () => {
    await post('/api/admin/pages', { action: 'verify', slug, role: byId('teamAddRole').value });
    toast(translate('admin.team-verified', { slug }));
    byId('teamAddSlug').value = '';
    byId('teamAddRole').value = '';
    byId('teamQuery').value = '';
    loaders.team(0);
    if (loaders.pages) {
      loaders.pages();
    }
  });
});
byId('teamSearch').addEventListener('submit', (event) => { event.preventDefault(); loaders.team(0); });

// The page's dialog: its picture, details, badges and actions, then its
// links (with the link limit) and its reports. Every change made from here
// draws the dialog again.
async function openPage(id) {
  const body = byId('pageModalBody');
  byId('pageModalTitle').textContent = translate('common.loading');
  body.replaceChildren(createElement('div', { class: 'skeleton delayed u-h-14', 'aria-hidden': 'true' }));
  openModal('pageModal');
  try {
    const data = await api(`/api/admin/pages?id=${encodeURIComponent(id)}`);
    const page = data.page;
    byId('pageModalTitle').textContent = `/${page.slug}`;
    const refresh = () => openPage(id);
    const avatar = createElement('div', { class: 'avatar admin-avatar', 'aria-hidden': 'true' });
    let avatarName = page.slug;
    if (page.displayName) {
      avatarName = page.displayName;
    }
    fillAvatar(avatar, page.avatarUrl, avatarName);
    // Any staff member can take a picture down, the way they can a link.
    let removeAvatar = null;
    if (page.avatarUrl) {
      removeAvatar = actionButton('admin.remove-avatar', 'trash', () => askReason({
        title: translate('admin.remove-avatar-title', { slug: page.slug }),
        body: translate('admin.remove-avatar-body'),
        run: async (reason) => {
          await post('/api/admin/pages', { action: 'remove-avatar', id: page.id, reason });
          toast(translate('admin.done'));
          refresh();
        },
      }), 'btn-danger');
    }
    let bio = null;
    if (page.bio) {
      bio = createElement('pre', { text: page.bio });
    }
    let renamedFrom = null;
    if (page.renamedFrom) {
      renamedFrom = createElement('p', { class: 'small', text: translate('admin.renamed-from', { slug: page.renamedFrom.slug, when: formatDate(page.renamedFrom.at) }) });
    }
    let redirect = null;
    if (page.redirectUrl) {
      redirect = createElement('p', { class: 'small', text: translate('admin.redirects-to', { url: page.redirectUrl }) });
    }
    let quarantineReason = null;
    if (page.quarantineReason) {
      quarantineReason = createElement('p', { class: 'callout danger', text: translate('admin.quarantine-reason', { reason: page.quarantineReason }) });
    }
    let banReason = null;
    if (page.banReason) {
      banReason = createElement('p', { class: 'callout danger', text: translate('admin.ban-reason', { reason: page.banReason }) });
    }
    let teamSince = null;
    if (page.team) {
      teamSince = createElement('p', { class: 'callout ok', text: translate('admin.team-since', { when: formatDate(page.team.verifiedAt) }) });
    }
    // The link limit, when the server sends one: how many links the page
    // uses of its own limit or the default. Admins can change it.
    let linkCapRow = null;
    if (data.linkCap) {
      let capKey;
      if (data.linkCap.custom) {
        capKey = 'admin.caps-page-own';
      } else {
        capKey = 'admin.caps-page-default';
      }
      const capText = createElement('p', { class: 'small u-m-0', text: translate(capKey, { used: formatNumber(data.linkCap.used), limit: formatNumber(data.linkCap.limit) }) });
      let changeCap = null;
      if (isAdmin()) {
        changeCap = actionButton('admin.caps-change', 'edit', () => changePageCap({ id: page.id, slug: page.slug, limit: data.linkCap.limit }, data.linkCap.defaultCap, refresh));
      }
      linkCapRow = createElement('div', { class: 'row between' }, [
        capText,
        changeCap,
      ]);
    }
    let linkItems;
    if (data.links.length) {
      linkItems = data.links.map((link) => linkRow(link, refresh));
    } else {
      linkItems = [createElement('li', { class: 'empty-state', text: translate('admin.empty-links') })];
    }
    let reportItems;
    if (data.reports.length) {
      reportItems = data.reports.map((report) => {
        let detailsBlock = null;
        if (report.details) {
          detailsBlock = createElement('pre', { text: report.details });
        }
        return createElement('li', { class: 'data-row' }, [createElement('div', {}, [
          createElement('div', { class: 'primary', text: `${translate(`report.reason-${report.reason}`)} · ${translate(`admin.report-${report.status}`)}` }),
          createElement('div', { class: 'secondary', text: formatDate(report.createdAt) }),
          detailsBlock,
        ]), createElement('div', { class: 'row-actions' }, [deleteReportAction(report, () => {
          refresh();
          if (loaders.reports) {
            loaders.reports();
          }
        })].filter(Boolean))]);
      });
    } else {
      reportItems = [createElement('li', { class: 'empty-state', text: translate('admin.empty-reports') })];
    }
    body.replaceChildren(...[
      createElement('div', { class: 'row admin-avatar-row' }, [avatar, removeAvatar]),
      createElement('p', { class: 'muted small', text: [page.displayName, translate('admin.created', { when: formatDate(page.createdAt) })].filter(Boolean).join(' · ') }),
      bio,
      createElement('div', { class: 'tags row u-mt-05' }, pageBadges(page).filter(Boolean)),
      renamedFrom,
      redirect,
      quarantineReason,
      banReason,
      teamSince,
      createElement('div', { class: 'actions inline' }, [approveAction(page, () => { refresh(); refreshLists(); }), releaseAction(page, () => { refresh(); refreshLists(); }), ...teamActions(page, () => { refresh(); refreshLists(); }), ...banActions(page, () => { refresh(); refreshLists(); }), deleteAction(page)].filter(Boolean)),
      createElement('p', { class: 'modal-section-label', text: translate('admin.tab-links') }),
      linkCapRow,
      createElement('ul', { class: 'data-list' }, linkItems),
      createElement('p', { class: 'modal-section-label', text: translate('admin.tab-reports') }),
      createElement('ul', { class: 'data-list' }, reportItems),
    ].filter(Boolean));
  } catch (error) {
    if (guardSession(error)) {
      closeModal('pageModal');
    } else {
      body.replaceChildren(createElement('p', { class: 'callout danger', text: errorText(error) }));
    }
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

let linkOffset = 0;
loaders.links = async (offset = linkOffset) => {
  linkOffset = offset;
  const list = byId('adminLinkList');
  loading(list);
  try {
    const query = encodeURIComponent(byId('linkQuery').value.trim());
    const state = encodeURIComponent(byId('linkState').value);
    const data = await api(`/api/admin/links?q=${query}&state=${state}&offset=${offset}`);
    fill(list, data.links.map((link) => linkRow(link, () => loaders.links())), 'admin.empty-links');
    pager(byId('linkPager'), data, loaders.links);
  } catch (error) {
    if (!guardSession(error)) {
      fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-links');
    }
  }
};
byId('linkSearch').addEventListener('submit', (event) => { event.preventDefault(); loaders.links(0); });
byId('linkState').addEventListener('change', () => loaders.links(0));

// One link, in the links tab or a page's dialog: its title, page, address and
// state, with remove (or restore) and open.
function linkRow(link, after) {
  // An empty string still goes in, as an empty text node.
  let pageSuffix = '';
  if (link.slug) {
    pageSuffix = ` · /${link.slug}`;
  }
  let removedReason = null;
  if (link.removedReason) {
    removedReason = createElement('div', { class: 'secondary', text: translate('admin.removed-reason', { reason: link.removedReason }) });
  }
  // Removed, or else shown or hidden by its owner.
  let stateTag;
  if (link.removedAt) {
    stateTag = badge(translate('admin.link-removed'), 'danger');
  } else {
    let stateKey;
    let stateTone;
    if (link.isActive) {
      stateKey = 'admin.link-shown';
      stateTone = 'ok';
    } else {
      stateKey = 'admin.link-hidden';
      stateTone = '';
    }
    stateTag = badge(translate(stateKey), stateTone);
  }
  const info = createElement('div', {}, [
    createElement('div', { class: 'primary' }, [iconNode(link.icon), ' ', link.title, pageSuffix]),
    createElement('div', { class: 'secondary', text: link.url }),
    removedReason,
    createElement('div', { class: 'tags' }, [
      stateTag,
      badge(translate('link.clicks', { count: link.clicks, n: formatNumber(link.clicks) })),
    ]),
  ]);
  const actions = createElement('div', { class: 'row-actions' });
  if (link.removedAt) {
    actions.append(actionButton('admin.restore', 'restore', () => askReason({
      title: translate('admin.restore-title'),
      required: false,
      run: async () => {
        await post('/api/admin/links', { action: 'restore', id: link.id });
        toast(translate('admin.done'));
        after();
      },
    })));
  } else {
    actions.append(actionButton('admin.remove', 'trash', () => askReason({
      title: translate('admin.remove-title'),
      body: translate('admin.remove-body'),
      run: async (reason) => {
        await post('/api/admin/links', { action: 'remove', id: link.id, reason });
        toast(translate('admin.done'));
        after();
      },
    }), 'btn-danger'));
  }
  const open = createElement('a', { class: 'btn btn-small btn-quiet', href: link.url, target: '_blank', rel: 'noopener noreferrer nofollow', 'aria-label': translate('admin.open-link') });
  open.innerHTML = icon('external');
  actions.append(open);
  return createElement('li', { class: 'data-row' }, [info, actions]);
}

// ---------------------------------------------------------------------------
// Block lists (admin)
// ---------------------------------------------------------------------------

// Patterns are removed by id, names and domains by their value.
function blockRows(items, kind) {
  return items.map((item) => {
    // Entries with an id (patterns) show in a fixed-width font.
    let monoClass = '';
    if (item.id) {
      monoClass = ' mono';
    }
    let scopeTags = null;
    if (item.appliesTo) {
      scopeTags = createElement('div', { class: 'tags' }, [badge(translate(`admin.scope-${item.appliesTo}`))]);
    }
    return createElement('li', { class: 'data-row' }, [
      createElement('div', {}, [
        createElement('div', { class: `primary${monoClass}`, text: item.value }),
        createElement('div', { class: 'secondary', text: [item.reason, formatDate(item.createdAt)].filter(Boolean).join(' · ') }),
        scopeTags,
      ]),
      createElement('div', { class: 'row-actions' }, [actionButton('common.remove', 'trash', async () => {
        try {
          let body;
          if (item.id) {
            body = { action: `remove-${kind}`, id: item.id };
          } else {
            body = { action: `remove-${kind}`, value: item.value };
          }
          renderBlocks(await post('/api/admin/blocklist', body));
        } catch (error) {
          toast(errorText(error));
        }
      })]),
    ]);
  });
}

// The threat list's status line: turned off, not built yet, or how many
// domains it holds and when it was built.
function renderThreatList(info) {
  const line = byId('threatListInfo');
  // Hidden when there is no list or it is turned off.
  let refreshHidden = true;
  if (info) {
    refreshHidden = info.off;
  }
  byId('threatListRefresh').hidden = refreshHidden;
  if (!info || info.off) {
    line.textContent = translate('admin.threat-off');
    return;
  }
  // The server counts each category (harmful, gambling, adult, shortener).
  let categories = {};
  if (info.categories) {
    categories = info.categories;
  }
  const total = Object.values(categories).reduce((sum, count) => sum + count, 0);
  if (info.builtAt) {
    line.textContent = translate('admin.threat-info', { count: total, n: formatNumber(total), when: formatDate(info.builtAt), days: info.refreshDays });
  } else {
    line.textContent = translate('admin.threat-none');
  }
}

// Connections flagged for addresses the lists refused: unflag, or ban the
// connection.
function flaggedRows(items) {
  return items.map((item) => {
    let pageNote = null;
    if (item.slug) {
      pageNote = translate('admin.flagged-page', { slug: item.slug });
    }
    return createElement('li', { class: 'data-row' }, [
      createElement('div', {}, [
        createElement('div', { class: 'primary mono', text: item.id }),
        createElement('div', { class: 'secondary', text: [
          translate('admin.flagged-attempts', { count: item.attempts, n: formatNumber(item.attempts) }),
          translate('admin.flagged-since', { when: formatDate(item.since) }),
          pageNote,
        ].filter(Boolean).join(' · ') }),
      ]),
      createElement('div', { class: 'row-actions' }, [
        actionButton('admin.unflag', 'check', async () => {
          try {
            renderBlocks(await post('/api/admin/blocklist', { action: 'unflag-connection', id: item.id }));
            toast(translate('admin.unflagged'));
          } catch (error) {
            toast(errorText(error));
          }
        }),
        actionButton('admin.ban-connection', 'ban', () => askReason({
          title: translate('admin.ban-connection-title', { id: item.id }),
          body: translate('admin.ban-connection-body'),
          run: async (reason) => {
            renderBlocks(await post('/api/admin/blocklist', { action: 'ban-connection', id: item.id, reason }));
            toast(translate('admin.connection-banned'));
          },
        }), 'btn-danger'),
      ]),
    ]);
  });
}

// Devices banned with a connection, seen on one that is not (guards.js).
function flaggedDeviceRows(items) {
  return items.map((item) => {
    let pageNote = null;
    if (item.slug) {
      pageNote = translate('admin.flagged-page', { slug: item.slug });
    }
    return createElement('li', { class: 'data-row' }, [
      createElement('div', {}, [
        createElement('div', { class: 'primary mono', text: translate('admin.flagged-device', { device: item.device, connection: item.connection }) }),
        createElement('div', { class: 'secondary', text: [
          translate('admin.flagged-device-requests', { count: item.requests, n: formatNumber(item.requests) }),
          translate('admin.flagged-since', { when: formatDate(item.since) }),
          pageNote,
        ].filter(Boolean).join(' · ') }),
      ]),
      createElement('div', { class: 'row-actions' }, [
        actionButton('admin.unflag', 'check', async () => {
          try {
            renderBlocks(await post('/api/admin/blocklist', { action: 'unflag-visitor', id: item.id }));
            toast(translate('admin.device-unflagged'));
          } catch (error) {
            toast(errorText(error));
          }
        }),
        actionButton('admin.ban-connection', 'ban', () => askReason({
          title: translate('admin.ban-connection-title', { id: item.connection }),
          body: translate('admin.ban-connection-body'),
          run: async (reason) => {
            renderBlocks(await post('/api/admin/blocklist', { action: 'ban-visitor', id: item.id, reason }));
            toast(translate('admin.connection-banned'));
          },
        }), 'btn-danger'),
      ]),
    ]);
  });
}

// Banned connections: when and why, the pages and devices that went with
// them, and who banned them (staff or the automatic rules).
function bannedRows(items) {
  return items.map((item) => {
    let bannedPages = null;
    if (item.slugs.length) {
      bannedPages = createElement('div', { class: 'secondary', text: translate('admin.banned-pages', { pages: item.slugs.map((slug) => `/${slug}`).join(', ') }) });
    }
    let bannedDevices = null;
    if (item.devices) {
      bannedDevices = createElement('div', { class: 'secondary', text: translate('admin.banned-devices', { count: item.devices, n: formatNumber(item.devices) }) });
    }
    let bannedByKey;
    if (item.byStaff) {
      bannedByKey = 'admin.banned-by-staff';
    } else {
      bannedByKey = 'admin.banned-auto';
    }
    return createElement('li', { class: 'data-row' }, [
      createElement('div', {}, [
        createElement('div', { class: 'primary mono', text: item.id }),
        createElement('div', { class: 'secondary', text: [item.reason, formatDate(item.since)].filter(Boolean).join(' · ') }),
        bannedPages,
        bannedDevices,
        createElement('div', { class: 'tags' }, [badge(translate(bannedByKey))]),
      ]),
      createElement('div', { class: 'row-actions' }, [actionButton('admin.unban-connection', 'check', async () => {
        try {
          renderBlocks(await post('/api/admin/blocklist', { action: 'unban-connection', id: item.id }));
          toast(translate('admin.connection-unbanned'));
        } catch (error) {
          toast(errorText(error));
        }
      })]),
    ]);
  });
}

// Each block list shows five at a time with its own pager, and keeps its
// place when an entry is added or removed (or steps back a page when its
// last entry goes).
const BLOCKS_PER_PAGE = 5;
const blockOffsets = {};

function fillPaged(listId, pagerId, rows, emptyKey) {
  const total = rows.length;
  let offset = 0;
  if (blockOffsets[listId]) {
    offset = blockOffsets[listId];
  }
  // Past the end (its last entry went): step back to the last page.
  if (offset >= total) {
    offset = Math.max(0, Math.floor((total - 1) / BLOCKS_PER_PAGE) * BLOCKS_PER_PAGE);
  }
  blockOffsets[listId] = offset;
  fill(byId(listId), rows.slice(offset, offset + BLOCKS_PER_PAGE), emptyKey);
  pager(byId(pagerId), { total, offset, pageSize: BLOCKS_PER_PAGE }, (next) => {
    blockOffsets[listId] = next;
    fillPaged(listId, pagerId, rows, emptyKey);
  });
}

// Draws every block list from one blocklist answer. A list missing from the
// answer (null or undefined) counts as empty.
function renderBlocks(data) {
  let flagged = data.flagged;
  if (flagged === null || flagged === undefined) {
    flagged = [];
  }
  let flaggedVisitors = data.flaggedVisitors;
  if (flaggedVisitors === null || flaggedVisitors === undefined) {
    flaggedVisitors = [];
  }
  let banned = data.banned;
  if (banned === null || banned === undefined) {
    banned = [];
  }
  let allowed = data.allowed;
  if (allowed === null || allowed === undefined) {
    allowed = [];
  }
  fillPaged('flaggedList', 'flaggedPager', flaggedRows(flagged), 'admin.empty-flagged');
  fillPaged('flaggedDeviceList', 'flaggedDevicePager', flaggedDeviceRows(flaggedVisitors), 'admin.empty-flagged-devices');
  fillPaged('bannedList', 'bannedPager', bannedRows(banned), 'admin.empty-banned');
  fillPaged('slugBlockList', 'slugBlockPager', blockRows(data.slugs, 'slug'), 'admin.empty-blocks');
  fillPaged('domainBlockList', 'domainBlockPager', blockRows(data.domains, 'domain'), 'admin.empty-blocks');
  fillPaged('allowedBlockList', 'allowedBlockPager', blockRows(allowed, 'allowed'), 'admin.empty-allowed');
  fillPaged('patternBlockList', 'patternBlockPager', blockRows(data.patterns, 'pattern'), 'admin.empty-blocks');
  fillPaged('reviewBlockList', 'reviewBlockPager', blockRows(data.reviews, 'review'), 'admin.empty-blocks');
  renderThreatList(data.threatList);
}

loaders.blocks = async () => {
  if (!isAdmin()) {
    return;
  }
  for (const id of ['slugBlockList', 'domainBlockList', 'allowedBlockList', 'patternBlockList', 'reviewBlockList', 'flaggedList', 'flaggedDeviceList', 'bannedList']) {
    loading(byId(id));
  }
  try {
    renderBlocks(await api('/api/admin/blocklist'));
  } catch (error) {
    if (!guardSession(error)) {
      toast(errorText(error));
    }
  }
};

// The five add forms work the same way. The fields are cleared only once the
// server has taken the entry.
for (const [formId, kind] of [['slugBlockForm', 'slug'], ['domainBlockForm', 'domain'], ['allowedBlockForm', 'allowed'], ['patternBlockForm', 'pattern'], ['reviewBlockForm', 'review']]) {
  byId(formId).addEventListener('submit', (event) => {
    event.preventDefault();
    const button = byId(formId).querySelector('button[type="submit"]');
    withBusy(button, null, async () => {
      const value = byId(`${kind}BlockValue`).value;
      const reason = byId(`${kind}BlockReason`).value;
      // Only patterns say what they apply to; the others leave it undefined.
      let appliesTo;
      if (kind === 'pattern') {
        appliesTo = byId('patternBlockScope').value;
      }
      try {
        renderBlocks(await post('/api/admin/blocklist', { action: `add-${kind}`, value, reason, appliesTo }));
      } catch (error) {
        toast(errorText(error));
        return;
      }
      byId(`${kind}BlockValue`).value = '';
      byId(`${kind}BlockReason`).value = '';
      toast(translate('admin.done'));
    });
  });
}

// The pattern helper fills the field it was opened from.
byId('patternBlockHelp').addEventListener('click', () => {
  let scope;
  if (byId('patternBlockScope').value === 'names') {
    scope = 'names';
  } else {
    scope = 'links';
  }
  openRegexMaker(scope, (pattern) => { byId('patternBlockValue').value = pattern; byId('patternBlockValue').focus(); });
});
byId('reviewBlockHelp').addEventListener('click', () => {
  openRegexMaker('names', (pattern) => { byId('reviewBlockValue').value = pattern; byId('reviewBlockValue').focus(); });
});

// Fetching and indexing two million domains takes a little while.
byId('threatListRefresh').addEventListener('click', () => {
  withBusy(byId('threatListRefresh'), null, async () => {
    try {
      renderBlocks(await post('/api/admin/blocklist', { action: 'refresh-threat-list' }));
      toast(translate('admin.threat-refreshed'));
    } catch (error) {
      toast(errorText(error));
    }
  });
});

// ---------------------------------------------------------------------------
// Testimonials (admin)
// ---------------------------------------------------------------------------

// Owners' testimonials wait at the top for any staff member to approve or
// decline; the published list below is arranged by admins only.
function renderTestimonials(all) {
  const send = async (item, body) => {
    try {
      renderTestimonials((await post('/api/admin/testimonials', { id: item.id, ...body })).testimonials);
    } catch (error) {
      if (!guardSession(error)) {
        toast(errorText(error));
      }
    }
  };
  const pending = all.filter((testimonial) => testimonial.status === 'pending');
  fill(byId('testimonialPending'), pending.map((item) => {
    // The author links to their page when it is known.
    let author;
    if (item.pageSlug) {
      author = createElement('a', { class: 'text-link', href: `/${item.pageSlug}`, target: '_blank', rel: 'noopener noreferrer', text: `${item.author} · /${item.pageSlug}` });
    } else {
      author = item.author;
    }
    return createElement('li', { class: 'data-row' }, [
      createElement('div', {}, [
        createElement('div', { class: 'primary', text: `“${item.quote}”` }),
        createElement('div', { class: 'secondary' }, [
          author,
          ` · ${formatDate(item.createdAt)}`,
        ]),
      ]),
      createElement('div', { class: 'row-actions' }, [
        actionButton('admin.approve', 'check', () => send(item, { action: 'approve' }), 'btn-primary'),
        actionButton('admin.decline', 'close', () => send(item, { action: 'decline' })),
      ]),
    ]);
  }), 'admin.empty-pending-testimonials');
  const list = all.filter((testimonial) => testimonial.status !== 'pending');
  fill(byId('testimonialList'), list.map((item, index) => {
    const act = (body) => send(item, body);
    const moveUpButton = createElement('button', { class: 'icon-btn small', type: 'button', 'aria-label': translate('admin.move-up'), disabled: index === 0, onclick: () => act({ action: 'move', delta: -1 }) });
    moveUpButton.innerHTML = icon('arrow-up');
    const moveDownButton = createElement('button', { class: 'icon-btn small', type: 'button', 'aria-label': translate('admin.move-down'), disabled: index === list.length - 1, onclick: () => act({ action: 'move', delta: 1 }) });
    moveDownButton.innerHTML = icon('arrow-down');
    // A hidden testimonial's row is dimmed.
    let offClass;
    if (item.isVisible) {
      offClass = '';
    } else {
      offClass = ' off';
    }
    let pagePath = null;
    if (item.pageSlug) {
      pagePath = `/${item.pageSlug}`;
    }
    let declinedTag = null;
    if (item.status === 'declined') {
      declinedTag = badge(translate('admin.declined'), 'danger');
    }
    let hiddenTag = null;
    if (!item.isVisible) {
      hiddenTag = badge(translate('admin.hidden'));
    }
    let ownerTag = null;
    if (item.sentByOwner) {
      ownerTag = badge(translate('admin.sent-by-owner'));
    }
    // Arranging the published list is for admins; editors see it as it is.
    let rowActions = null;
    if (isAdmin()) {
      let toggleKey;
      let toggleIcon;
      if (item.isVisible) {
        toggleKey = 'admin.hide';
        toggleIcon = 'eye-off';
      } else {
        toggleKey = 'admin.show';
        toggleIcon = 'eye';
      }
      rowActions = createElement('div', { class: 'row-actions' }, [
        moveUpButton,
        moveDownButton,
        actionButton(toggleKey, toggleIcon, () => act({ action: 'update', isVisible: !item.isVisible })),
        actionButton('common.remove', 'trash', () => {
          if (window.confirm(translate('admin.testimonial-remove-confirm', { author: item.author }))) {
            act({ action: 'remove' });
          }
        }),
      ]);
    }
    return createElement('li', { class: `data-row${offClass}` }, [
      createElement('div', {}, [
        createElement('div', { class: 'primary', text: `“${item.quote}”` }),
        createElement('div', { class: 'secondary', text: [item.author, pagePath].filter(Boolean).join(' · ') }),
        createElement('div', { class: 'tags' }, [
          declinedTag,
          hiddenTag,
          ownerTag,
        ]),
      ]),
      rowActions,
    ]);
  }), 'admin.empty-testimonials');
}

loaders.testimonials = async () => {
  loading(byId('testimonialPending'));
  loading(byId('testimonialList'));
  try {
    renderTestimonials((await api('/api/admin/testimonials')).testimonials);
  } catch (error) {
    if (!guardSession(error)) {
      toast(errorText(error));
    }
  }
};

byId('testimonialForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('testimonialAdd'), byId('testimonialError'), async () => {
    const data = await post('/api/admin/testimonials', {
      action: 'add',
      quote: byId('testimonialQuote').value,
      author: byId('testimonialAuthor').value,
      pageSlug: byId('testimonialPage').value,
    });
    renderTestimonials(data.testimonials);
    ['testimonialQuote', 'testimonialAuthor', 'testimonialPage'].forEach((id) => { byId(id).value = ''; });
    toast(translate('admin.done'));
  });
});

// ---------------------------------------------------------------------------
// Link limits
//
// Owners' requests for more, which any staff member answers; and, for admins,
// the default every page follows and the pages with a limit of their own.
// Lowering a limit never deletes links.
// ---------------------------------------------------------------------------

let caps = null;
let capAction = null;

// The number dialog, for answering a request and setting a page's limit.
// useDefault, when given, is the default limit, offered as a way back to it.
// min and max bound the number; optional lets it be left empty (a decline
// without a smaller raise); askNumber: false hides it altogether.
function askCap({ title, body, value = '', label = 'admin.caps-limit', min = 1, max = null, optional = false, askNumber = true, note = false, useDefault = null, run }) {
  // The highest number allowed: max when given, else the server's ceiling,
  // else 200.
  let top = max;
  if ((top === null || top === undefined) && caps) {
    top = caps.maxCap;
  }
  if (top === null || top === undefined) {
    top = 200;
  }
  capAction = { run, useDefault, min, max: top, optional, askNumber };
  byId('capTitle').textContent = title;
  byId('capBody').textContent = body;
  byId('capValueRow').hidden = !askNumber;
  byId('capValueLabel').textContent = translate(label);
  byId('capValue').min = String(min);
  byId('capValue').max = String(top);
  // A 0 is shown as 0; only null or undefined leaves the field empty.
  let shownValue = value;
  if (shownValue === null || shownValue === undefined) {
    shownValue = '';
  }
  byId('capValue').value = shownValue;
  byId('capValue').disabled = false;
  byId('capUseDefaultRow').hidden = useDefault === null;
  byId('capUseDefault').checked = false;
  if (useDefault !== null) {
    byId('capUseDefaultLabel').textContent = translate('admin.caps-use-default', { limit: formatNumber(useDefault) });
  }
  byId('capNoteRow').hidden = !note;
  byId('capNote').value = '';
  byId('capError').textContent = '';
  // Focus the number, else the note, else nothing in particular.
  let initialFocus;
  if (askNumber) {
    initialFocus = byId('capValue');
  } else if (note) {
    initialFocus = byId('capNote');
  } else {
    initialFocus = null;
  }
  openModal('capModal', { initialFocus });
}
byId('capUseDefault').addEventListener('change', (event) => { byId('capValue').disabled = event.target.checked; });
// Checks the number (unless none is to be sent) and runs the dialog's action
// with it, or with null for no number.
byId('capForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!capAction) {
    return;
  }
  const { min, max, optional, askNumber } = capAction;
  let backToDefault = false;
  if (capAction.useDefault !== null) {
    backToDefault = byId('capUseDefault').checked;
  }
  let value;
  if (askNumber) {
    value = byId('capValue').value.trim();
  } else {
    value = '';
  }
  // No number: back to the default, no number asked, or an optional one left
  // empty.
  let none = false;
  if (backToDefault || !askNumber || (optional && value === '')) {
    none = true;
  }
  if (!none && (!/^\d{1,4}$/.test(value) || Number(value) < min || Number(value) > max)) {
    byId('capError').textContent = translate('error.cap_grant_range', { min: formatNumber(min), max: formatNumber(max) });
    return;
  }
  withBusy(byId('capSubmit'), byId('capError'), async () => {
    let cap;
    if (none) {
      cap = null;
    } else {
      cap = Number(value);
    }
    await capAction.run(cap, byId('capNote').value.trim());
    closeModal('capModal');
    toast(translate('admin.done'));
  });
});

function pageLink(slug, displayName) {
  // An empty string still goes in, as an empty text node.
  let nameSuffix = '';
  if (displayName) {
    nameSuffix = ` · ${displayName}`;
  }
  return createElement('div', { class: 'primary' }, [
    createElement('a', { class: 'text-link', href: `/${slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${slug}` }),
    nameSuffix,
  ]);
}

async function sendCaps(body) {
  renderCaps(await post('/api/admin/link-caps', body));
}

function changePageCap(page, defaultCap, after = null) {
  askCap({
    title: translate('admin.caps-page-title', { slug: page.slug }),
    body: translate('admin.caps-page-body'),
    value: page.limit,
    useDefault: defaultCap,
    run: async (cap) => {
      await sendCaps({ action: 'set-page', id: page.id, cap });
      if (after) {
        after();
      }
    },
  });
}

// Any staff member answers requests. Approving gives more than the page has
// now: up to what was asked (editors) or the ceiling (admins). Declining can
// come with a smaller raise, between the two.
function capRequestRow(request) {
  const numbers = { requested: formatNumber(request.requested), used: formatNumber(request.used), limit: formatNumber(request.limit) };
  let approveMax;
  if (isAdmin()) {
    if (caps) {
      approveMax = caps.maxCap;
    }
    if (approveMax === null || approveMax === undefined) {
      approveMax = 200;
    }
  } else {
    approveMax = request.requested;
  }
  const compromise = { min: request.limit + 1, max: request.requested - 1 };
  return createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      pageLink(request.slug, request.displayName),
      createElement('div', { class: 'secondary', text: translate('admin.caps-wants', numbers) }),
      createElement('pre', { text: request.reason }),
      createElement('div', { class: 'secondary', text: formatDate(request.createdAt) }),
    ]),
    createElement('div', { class: 'row-actions' }, [
      actionButton('admin.approve', 'check', () => askCap({
        title: translate('admin.caps-approve-title', { slug: request.slug }),
        body: translate('admin.caps-approve-body', { ...numbers, min: formatNumber(request.limit + 1), max: formatNumber(approveMax) }),
        value: request.requested,
        min: request.limit + 1,
        max: approveMax,
        note: true,
        run: (cap, note) => sendCaps({ action: 'approve', id: request.id, cap, note }),
      }), 'btn-primary'),
      actionButton('admin.decline', 'close', () => {
        // A smaller raise is offered only when there is room for one.
        const canCompromise = compromise.min <= compromise.max;
        let declineBody;
        if (canCompromise) {
          declineBody = translate('admin.caps-decline-compromise-body', { ...numbers, min: formatNumber(compromise.min), max: formatNumber(compromise.max) });
        } else {
          declineBody = translate('admin.caps-decline-body');
        }
        askCap({
          title: translate('admin.caps-decline-title', { slug: request.slug }),
          body: declineBody,
          label: 'admin.caps-compromise',
          min: compromise.min,
          max: compromise.max,
          optional: true,
          askNumber: canCompromise,
          note: true,
          run: (cap, note) => sendCaps({ action: 'decline', id: request.id, cap, note }),
        });
      }),
    ]),
  ]);
}

// A page with a limit of its own, tagged when it holds more links than that.
function capCustomRow(page) {
  let overTag = null;
  if (page.used > page.limit) {
    overTag = createElement('div', { class: 'tags' }, [badge(translate('admin.caps-over'), 'warn')]);
  }
  return createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      pageLink(page.slug, page.displayName),
      createElement('div', { class: 'secondary', text: translate('admin.caps-uses', { used: formatNumber(page.used), limit: formatNumber(page.limit) }) }),
      overTag,
    ]),
    createElement('div', { class: 'row-actions' }, [actionButton('admin.caps-change', 'edit', () => {
      // The default as it is when the button is pressed, or null.
      let defaultCap = null;
      if (caps && caps.defaultCap !== null && caps.defaultCap !== undefined) {
        defaultCap = caps.defaultCap;
      }
      changePageCap(page, defaultCap);
    })]),
  ]);
}

function renderCaps(data) {
  caps = data;
  const input = byId('capDefault');
  input.max = String(data.maxCap);
  // Don't overwrite the default while it is being typed.
  if (document.activeElement !== input) {
    input.value = String(data.defaultCap);
  }
  fill(byId('capRequestList'), data.pending.map(capRequestRow), 'admin.caps-empty-requests');
  // Admins only: editors are not sent it.
  if (data.custom) {
    fill(byId('capCustomList'), data.custom.map(capCustomRow), 'admin.caps-empty-custom');
  }
}

loaders.caps = async () => {
  loading(byId('capRequestList'));
  if (isAdmin()) {
    loading(byId('capCustomList'));
  }
  try {
    renderCaps(await api('/api/admin/link-caps'));
  } catch (error) {
    if (!guardSession(error)) {
      toast(errorText(error));
    }
  }
};

byId('capDefaultForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('capDefaultSave'), byId('capDefaultError'), async () => {
    await sendCaps({ action: 'set-default', cap: byId('capDefault').value.trim() });
    toast(translate('admin.done'));
  });
});

// ---------------------------------------------------------------------------
// Audit log (admin)
// ---------------------------------------------------------------------------

let auditOffset = 0;
// One page of the audit log, filtered by action. Each entry shows what was
// done, when, by whom, and its details when it has any.
loaders.audit = async (offset = auditOffset) => {
  if (!isAdmin()) {
    return;
  }
  auditOffset = offset;
  const list = byId('auditList');
  loading(list);
  try {
    const data = await api(`/api/admin/audit?action=${encodeURIComponent(byId('auditFilter').value)}&offset=${offset}`);
    fill(list, data.entries.map((entry) => {
      let actor;
      if (entry.actorType === 'staff') {
        // The staff member's name, else their id, else a question mark.
        let actorName = '?';
        if (entry.actorName) {
          actorName = entry.actorName;
        } else if (entry.actorId) {
          actorName = entry.actorId;
        }
        actor = translate('admin.actor-staff', { name: actorName });
      } else {
        actor = translate(`admin.actor-${entry.actorType}`);
      }
      let detailFields = {};
      if (entry.details) {
        detailFields = entry.details;
      }
      let details = '';
      if (Object.keys(detailFields).length) {
        details = JSON.stringify(entry.details, null, 2);
      }
      let detailsBlock = null;
      if (details) {
        detailsBlock = createElement('pre', { text: details });
      }
      return createElement('li', { class: 'data-row' }, [createElement('div', {}, [
        createElement('div', { class: 'primary', text: entry.action }),
        createElement('div', { class: 'secondary', text: `${formatDate(entry.createdAt)} · ${actor}` }),
        detailsBlock,
      ])]);
    }), 'admin.empty-audit');
    pager(byId('auditPager'), data, loaders.audit);
  } catch (error) {
    if (!guardSession(error)) {
      toast(errorText(error));
    }
  }
};
byId('auditFilter').addEventListener('change', () => loaders.audit(0));

// ---------------------------------------------------------------------------
// Staff passkeys
// ---------------------------------------------------------------------------

// The staff member's own passkeys: name (or a number), when last used (or
// added), and a remove button that asks for the password again.
function renderStaffPasskeys(passkeys) {
  const list = byId('staffPasskeyList');
  let items;
  if (passkeys.length) {
    items = passkeys.map((passkey, index) => {
      const remove = createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', text: translate('common.remove') });
      remove.addEventListener('click', () => askPassword(
        (password) => post('/api/admin/passkeys', { action: 'remove', id: passkey.id, password }),
        (data) => renderStaffPasskeys(data.passkeys)
      ));
      let name = passkey.label;
      if (!name) {
        name = translate('security.passkey-n', { n: index + 1 });
      }
      let lastUse;
      if (passkey.lastUsedAt) {
        lastUse = translate('security.last-used', { when: formatDate(passkey.lastUsedAt) });
      } else {
        lastUse = translate('security.added', { when: formatDate(passkey.createdAt) });
      }
      return createElement('li', {}, [
        createElement('div', {}, [
          createElement('div', { text: name }),
          createElement('small', { text: lastUse }),
        ]),
        remove,
      ]);
    });
  } else {
    items = [createElement('li', { class: 'empty-state', text: translate('admin.no-passkeys') })];
  }
  list.replaceChildren(...items);
}

loaders.account = async () => {
  byId('staffPasskeyAdd').disabled = !passkeysSupported();
  try {
    renderStaffPasskeys((await api('/api/admin/passkeys')).passkeys);
  } catch (error) {
    if (!guardSession(error)) {
      toast(errorText(error));
    }
  }
};

// The password dialog in front of a passkey change. sendWithPassword sends
// the change with the password; then, when given, takes the answer.
let pending = null;
function askPassword(sendWithPassword, then) {
  pending = { fn: sendWithPassword, then };
  byId('confirmPassword').value = '';
  byId('passwordError').textContent = '';
  byId('passwordModalTitle').textContent = translate('confirm.title');
  openModal('passwordModal', { initialFocus: byId('confirmPassword') });
}
byId('passwordForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!pending) {
    return;
  }
  const { fn: sendWithPassword, then } = pending;
  withBusy(byId('passwordSubmit'), byId('passwordError'), async () => {
    const data = await sendWithPassword(byId('confirmPassword').value);
    pending = null;
    closeModal('passwordModal');
    if (then) {
      await then(data);
    }
  });
});

byId('staffPasskeyAdd').addEventListener('click', () => askPassword(
  (password) => post('/api/admin/passkeys', { action: 'options', password }),
  async ({ options }) => {
    const button = byId('staffPasskeyAdd');
    setBusy(button, true);
    try {
      const response = await createPasskey(options);
      renderStaffPasskeys((await post('/api/admin/passkeys', { action: 'finish', response })).passkeys);
      toast(translate('security.passkey-added'));
    } catch (error) {
      toast(errorText({ code: passkeyErrorCode(error) }));
    } finally {
      setBusy(button, false);
    }
  }
));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// A language change redraws what was translated in code: the signed-in line,
// the open tab and the code form's label.
onChange(() => {
  if (staff) {
    let staffName = staff.username;
    if (staff.displayName) {
      staffName = staff.displayName;
    }
    byId('staffWho').textContent = translate('admin.signed-in-as', { name: staffName, role: translate(`admin.role-${staff.role}`) });
    const current = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    if (current) {
      selectTab(current);
    }
  }
  if (method) {
    pickMethod(method);
  }
});

api('/api/admin/auth')
  .then((data) => enter(data.staff))
  .catch(() => show('login'));
