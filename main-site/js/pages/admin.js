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

byId('staffPasswordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('staffPasswordSubmit'), byId('staffPasswordError'), async () => {
    const data = await post('/api/admin/auth', { action: 'login', identifier: byId('staffIdentifier').value, password: byId('staffPassword').value });
    challenge = data.challenge;
    byId('staffPassword').value = '';
    const usable = { totp: data.methods.totp, passkey: data.methods.passkey && passkeysSupported(), backup: data.methods.backup };
    document.querySelectorAll('#staffMethods [data-method]').forEach((b) => { b.hidden = !usable[b.dataset.method]; });
    byId('staffPasswordForm').hidden = true;
    byId('staffCodeForm').hidden = false;
    pickMethod(usable.totp ? 'totp' : usable.passkey ? 'passkey' : 'backup');
  });
});

function pickMethod(name) {
  method = name;
  document.querySelectorAll('#staffMethods [data-method]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.method === name)));
  byId('staffCodeField').hidden = name === 'passkey';
  byId('staffCodeSubmitRow').hidden = name === 'passkey';
  byId('staffPasskeyRow').hidden = name !== 'passkey';
  byId('staffCodeLabel').textContent = translate(name === 'backup' ? 'field.backup-code' : 'field.code');
  const input = byId('staffCode');
  input.value = '';
  input.inputMode = name === 'totp' ? 'numeric' : 'text';
  if (name !== 'passkey') input.focus();
}
document.querySelectorAll('#staffMethods [data-method]').forEach((b) => b.addEventListener('click', () => pickMethod(b.dataset.method)));

function backToPassword(error) {
  if (error.code !== 'challenge_expired') return;
  byId('staffCodeForm').hidden = true;
  byId('staffPasswordForm').hidden = false;
  byId('staffPasswordError').textContent = translate('error.challenge_expired');
}

byId('staffCodeForm').addEventListener('submit', (e) => {
  e.preventDefault();
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
    const on = other === tab;
    other.setAttribute('aria-selected', String(on));
    other.tabIndex = on ? 0 : -1;
    byId(other.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  const name = tab.id.replace('atab-', '');
  loaders[name]?.();
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const visible = tabs.filter((x) => !x.hidden);
    const i = visible.indexOf(tab);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step) {
      e.preventDefault();
      selectTab(visible[(i + step + visible.length) % visible.length], true);
    }
  });
});

function enter(user) {
  staff = user;
  byId('staffWho').textContent = translate('admin.signed-in-as', { name: user.displayName || user.username, role: translate(`admin.role-${user.role}`) });
  document.querySelectorAll('[data-admin-only]').forEach((n) => { n.hidden = user.role !== 'admin'; });
  show('dashboard');
  selectTab(tabs[0]);
}

const isAdmin = () => staff && staff.role === 'admin';

// A paged list: renders rows, an empty state, and previous/next.
function pager(container, data, go) {
  container.replaceChildren();
  if (data.total <= data.pageSize) return;
  const from = data.offset + 1;
  const to = Math.min(data.offset + data.pageSize, data.total);
  const prev = createElement('button', { class: 'btn btn-small', type: 'button', disabled: data.offset === 0, onclick: () => go(Math.max(0, data.offset - data.pageSize)) }, [translate('admin.previous')]);
  const next = createElement('button', { class: 'btn btn-small', type: 'button', disabled: to >= data.total, onclick: () => go(data.offset + data.pageSize) }, [translate('admin.next')]);
  container.append(prev, createElement('span', { text: translate('admin.range', { from: formatNumber(from), to: formatNumber(to), total: formatNumber(data.total) }) }), next);
}

function loading(list) {
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(createElement('li', { class: 'list-loading delayed', 'aria-hidden': 'true' }, [createElement('div', { class: 'skeleton' }), createElement('div', { class: 'skeleton' })]));
}

function fill(list, rows, emptyKey) {
  list.removeAttribute('aria-busy');
  list.replaceChildren(...(rows.length ? rows : [createElement('li', { class: 'empty-state', text: translate(emptyKey) })]));
}

function badge(text, tone = '') {
  return createElement('span', { class: `badge ${tone}`.trim(), text });
}

function actionButton(labelKey, iconName, onclick, tone = '') {
  const b = createElement('button', { class: `btn btn-small ${tone}`.trim(), type: 'button', onclick });
  b.append(iconNode(iconName), createElement('span', { text: translate(labelKey) }));
  return b;
}

function statusBadge(status) {
  return badge(translate(`status.${status}`), status === 'banned' ? 'danger' : status === 'active' ? 'ok' : 'warn');
}

// The status, plus what keeps a live page from showing.
function pageBadges(p) {
  return [
    statusBadge(p.status),
    p.awaitingReview ? badge(translate('status.review'), 'warn') : null,
    p.quarantined ? badge(translate('status.quarantined'), 'danger') : null,
    p.dormant ? badge(translate('status.dormant'), 'warn') : null,
    p.redirectUrl ? badge(translate('admin.redirects')) : null,
    p.team ? badge(p.team.role ? translate('admin.team-badge-role', { role: p.team.role }) : translate('team.label'), 'ok') : null,
  ];
}

// Admins mark a page as someone on the GFTV team, which puts a ring and a
// tick on its picture. The role is optional and shows beside the mark.
function teamActions(p, after) {
  if (!isAdmin() || p.status !== 'active') return [];
  const ask = (titleKey) => askReason({
    title: translate(titleKey, { slug: p.slug }),
    body: translate('admin.team-verify-body'),
    required: false,
    label: translate('admin.team-role'),
    maxlength: 40,
    initial: p.team?.role || '',
    run: async (role) => {
      await post('/api/admin/pages', { action: 'verify', id: p.id, role });
      toast(translate('admin.team-verified', { slug: p.slug }));
      after();
    },
  });
  if (!p.team) return [actionButton('admin.team-verify', 'shield', () => ask('admin.team-verify-title'), 'btn-primary')];
  return [
    actionButton('admin.team-change-role', 'edit', () => ask('admin.team-change-title')),
    actionButton('admin.team-unverify', 'close', () => askReason({
      title: translate('admin.team-unverify-title', { slug: p.slug }),
      body: translate('admin.team-unverify-body'),
      required: false,
      hideText: true,
      run: async () => {
        await post('/api/admin/pages', { action: 'unverify', id: p.id });
        toast(translate('admin.team-unverified', { slug: p.slug }));
        after();
      },
    }), 'btn-danger'),
  ];
}

// Any staff member can end a quarantine once they have looked.
function releaseAction(p, after) {
  if (!p.quarantined) return null;
  return actionButton('admin.release', 'check', async () => {
    try {
      await post('/api/admin/pages', { action: 'release', id: p.id });
      toast(translate('admin.released', { slug: p.slug }));
      after();
    } catch (error) {
      if (!guardSession(error)) toast(errorText(error));
    }
  }, 'btn-primary');
}

// Any staff member can let a name on the review list go live.
function approveAction(p, after) {
  if (!p.awaitingReview || p.status === 'banned') return null;
  return actionButton('admin.approve', 'check', async () => {
    try {
      await post('/api/admin/pages', { action: 'approve', id: p.id });
      toast(translate('admin.approved', { slug: p.slug }));
      after();
    } catch (error) {
      if (!guardSession(error)) toast(errorText(error));
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
  byId('reasonText').rows = maxlength <= 60 ? 1 : 3;
  byId('reasonText').classList.toggle('single-line', maxlength <= 60);
  byId('reasonTextRow').hidden = hideText;
  byId('reasonError').textContent = '';
  byId('reasonRemoveRow').hidden = !showRemove;
  byId('reasonRemoveLink').checked = false;
  byId('reasonConfirmRow').hidden = !confirm;
  byId('reasonConfirm').value = '';
  if (confirm) byId('reasonConfirmLabel').textContent = translate('admin.delete-confirm', { slug: confirm });
  byId('reasonLabel').textContent = label || translate(required ? 'field.reason' : 'field.note');
  openModal('reasonModal', { initialFocus: hideText ? byId('reasonSubmit') : byId('reasonText') });
}
byId('reasonForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!reasonAction) return;
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
      const card = createElement(tab ? 'button' : 'div', { class: 'glass-card stat', type: tab ? 'button' : undefined }, [
        createElement('div', { class: 'value', text: formatNumber(counts[key]) }),
        createElement('div', { class: 'label', text: translate(label) }),
      ]);
      if (tab) {
        card.addEventListener('click', () => {
          if (status) byId('pageStatus').value = status;
          selectTab(byId(`atab-${tab}`), true);
        });
      }
      return card;
    }));
    grid.removeAttribute('aria-busy');
  } catch (error) {
    if (!guardSession(error)) grid.replaceChildren(createElement('p', { class: 'callout danger', text: errorText(error) }));
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
    if (!guardSession(error)) fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-reports');
  }
};
byId('reportStatus').addEventListener('change', () => loaders.reports(0));

function reportRow(r) {
  const target = r.link ? translate('admin.report-on-link', { title: r.link.title }) : translate('admin.report-on-page');
  const tags = createElement('div', { class: 'tags' }, [
    badge(translate(`report.reason-${r.reason}`), r.reason === 'scam' || r.reason === 'malware' ? 'danger' : 'warn'),
    r.pageStatus ? statusBadge(r.pageStatus) : null,
    r.link && r.link.removed ? badge(translate('admin.link-removed'), 'danger') : null,
  ]);
  const info = createElement('div', {}, [
    createElement('div', { class: 'primary' }, [createElement('a', { class: 'text-link', href: `/${r.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${r.slug}` }), ` · ${target}`]),
    r.link ? createElement('div', { class: 'secondary', text: r.link.url }) : null,
    createElement('div', { class: 'secondary', text: formatDate(r.createdAt) }),
    r.details ? createElement('pre', { text: r.details }) : null,
    r.resolutionNote ? createElement('div', { class: 'secondary', text: translate('admin.note', { note: r.resolutionNote }) }) : null,
    tags,
  ]);
  const actions = createElement('div', { class: 'row-actions' });
  if (r.status === 'open') {
    actions.append(
      actionButton('admin.resolve', 'check', () => askReason({
        title: translate('admin.resolve-title'),
        body: translate('admin.resolve-body'),
        required: false,
        showRemove: Boolean(r.link && !r.link.removed),
        run: async (note, removeLink) => {
          await post('/api/admin/reports', { action: 'resolve', id: r.id, note, removeLink });
          toast(translate('admin.done'));
          loaders.reports();
        },
      }), 'btn-primary'),
      actionButton('admin.dismiss', 'close', () => askReason({
        title: translate('admin.dismiss-title'),
        required: false,
        run: async (note) => {
          await post('/api/admin/reports', { action: 'dismiss', id: r.id, note });
          toast(translate('admin.done'));
          loaders.reports();
        },
      })),
    );
  }
  actions.append(actionButton('admin.view-page', 'eye', () => openPage(r.pageId)));
  const remove = deleteReportAction(r, () => loaders.reports());
  if (remove) actions.append(remove);
  return createElement('li', { class: 'data-row' }, [info, actions]);
}

// Admins can delete a report outright, after a confirmation; the audit log
// keeps what it said.
function deleteReportAction(r, after) {
  if (!isAdmin()) return null;
  return actionButton('admin.delete-report', 'trash', async () => {
    if (!window.confirm(translate('admin.delete-report-confirm'))) return;
    try {
      await post('/api/admin/reports', { action: 'delete', id: r.id });
      toast(translate('admin.report-deleted'));
      after();
    } catch (error) {
      if (!guardSession(error)) toast(errorText(error));
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
    const q = encodeURIComponent(byId('pageQuery').value.trim());
    const status = encodeURIComponent(byId('pageStatus').value);
    const data = await api(`/api/admin/pages?q=${q}&status=${status}&offset=${offset}`);
    fill(list, data.pages.map(pageRow), 'admin.empty-pages');
    pager(byId('pagePager'), data, loaders.pages);
  } catch (error) {
    if (!guardSession(error)) fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-pages');
  }
};
byId('pageSearch').addEventListener('submit', (e) => { e.preventDefault(); loaders.pages(0); });
byId('pageStatus').addEventListener('change', () => loaders.pages(0));

function banActions(p, after) {
  if (!isAdmin()) return [];
  if (p.status === 'banned') {
    return [actionButton('admin.unban', 'restore', () => askReason({
      title: translate('admin.unban-title', { slug: p.slug }),
      required: false,
      run: async () => {
        await post('/api/admin/pages', { action: 'unban', id: p.id });
        toast(translate('admin.done'));
        after();
      },
    }))];
  }
  return [actionButton('admin.ban', 'ban', () => askReason({
    title: translate('admin.ban-title', { slug: p.slug }),
    body: translate('admin.ban-body'),
    run: async (reason) => {
      await post('/api/admin/pages', { action: 'ban', id: p.id, reason });
      toast(translate('admin.done'));
      after();
    },
  }), 'btn-danger')];
}

// Deleting frees the name for anyone to register, so it asks for the name to
// be typed as well as a reason.
function deleteAction(p) {
  if (!isAdmin()) return null;
  return actionButton('admin.delete-page', 'trash', () => askReason({
    title: translate('admin.delete-title', { slug: p.slug }),
    body: translate('admin.delete-body', { slug: p.slug }),
    confirm: p.slug,
    run: async (reason) => {
      await post('/api/admin/pages', { action: 'delete', id: p.id, reason, confirmSlug: p.slug });
      // The reason dialog first, so focus goes back past the page's dialog.
      closeModal('reasonModal');
      closeModal('pageModal');
      toast(translate('admin.deleted', { slug: p.slug }));
      loaders.pages?.();
    },
  }), 'btn-danger');
}

// After a change made in a page's dialog: the lists that may show that page.
function refreshLists() {
  loaders.pages?.();
  loaders.team?.();
}

function pageRow(p) {
  const info = createElement('div', {}, [
    createElement('div', { class: 'primary' }, [createElement('a', { class: 'text-link', href: `/${p.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${p.slug}` }), p.displayName ? ` · ${p.displayName}` : '']),
    createElement('div', { class: 'secondary', text: translate('admin.created', { when: formatDate(p.createdAt) }) }),
    p.renamedFrom ? createElement('div', { class: 'secondary', text: translate('admin.renamed-from', { slug: p.renamedFrom.slug, when: formatDate(p.renamedFrom.at) }) }) : null,
    p.banReason ? createElement('div', { class: 'secondary', text: translate('admin.ban-reason', { reason: p.banReason }) }) : null,
    p.redirectUrl ? createElement('div', { class: 'secondary', text: translate('admin.redirects-to', { url: p.redirectUrl }) }) : null,
    p.quarantineReason ? createElement('div', { class: 'secondary', text: translate('admin.quarantine-reason', { reason: p.quarantineReason }) }) : null,
    createElement('div', { class: 'tags' }, [
      ...pageBadges(p),
      badge(translate('admin.link-count', { count: p.linkCount, n: formatNumber(p.linkCount) })),
      p.reportCount ? badge(translate('admin.report-count', { count: p.reportCount, n: formatNumber(p.reportCount) }), 'warn') : null,
      p.telegramLinked ? badge(translate('factor.telegram')) : null,
    ]),
  ]);
  return createElement('li', { class: 'data-row' }, [
    info,
    createElement('div', { class: 'row-actions' }, [approveAction(p, () => loaders.pages()), releaseAction(p, () => loaders.pages()), actionButton('admin.view-page', 'eye', () => openPage(p.id)), ...banActions(p, () => loaders.pages())].filter(Boolean)),
  ]);
}

// ---------------------------------------------------------------------------
// Team (admins only): who has the GFTV team mark, adding someone by page
// name, and changing or removing a role, in one place as the team grows.
// ---------------------------------------------------------------------------

let teamOffset = 0;
loaders.team = async (offset = teamOffset) => {
  if (!isAdmin()) return;
  teamOffset = offset;
  const list = byId('adminTeamList');
  loading(list);
  try {
    const q = encodeURIComponent(byId('teamQuery').value.trim());
    const data = await api(`/api/admin/pages?status=team&q=${q}&offset=${offset}`);
    byId('adminTeamTitle').textContent = translate('admin.team-list-count', { count: data.total, n: formatNumber(data.total) });
    fill(list, data.pages.map(teamRow), q ? 'admin.team-empty-search' : 'admin.team-empty');
    pager(byId('adminTeamPager'), data, loaders.team);
  } catch (error) {
    if (!guardSession(error)) fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.team-empty');
  }
};

function teamRow(p) {
  const avatar = createElement('div', { class: 'avatar small', 'aria-hidden': 'true' });
  fillAvatar(avatar, p.avatarUrl, p.displayName || p.slug);
  const tick = createElement('span', { class: 'team-tick', 'aria-hidden': 'true' }, [iconNode('check')]);
  return createElement('li', { class: 'data-row team-row' }, [
    createElement('div', { class: 'team-row-who' }, [
      createElement('div', { class: 'avatar-wrap small team', 'aria-hidden': 'true' }, [avatar, tick]),
      createElement('div', {}, [
        createElement('div', { class: 'primary' }, [createElement('a', { class: 'text-link', href: `/${p.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${p.slug}` }), p.displayName && p.displayName !== p.slug ? ` · ${p.displayName}` : '']),
        createElement('div', { class: 'secondary', text: [p.team.role || translate('admin.team-no-role'), translate('admin.team-since-short', { when: formatDate(p.team.verifiedAt) })].join(' · ') }),
      ]),
    ]),
    createElement('div', { class: 'row-actions' }, [...teamActions(p, () => loaders.team()), actionButton('admin.view-page', 'eye', () => openPage(p.id))]),
  ]);
}

// The page name as typed, or pasted as an address: "augy", "/augy",
// "links.gftv.asia/augy" and "https://links.gftv.asia/augy/" are all augy.
function teamSlugFrom(input) {
  return String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www\.)?links\.gftv\.asia/, '').replace(/^\/+|\/+$/g, '');
}

byId('teamAdd').addEventListener('submit', (e) => {
  e.preventDefault();
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
    loaders.pages?.();
  });
});
byId('teamSearch').addEventListener('submit', (e) => { e.preventDefault(); loaders.team(0); });

async function openPage(id) {
  const body = byId('pageModalBody');
  byId('pageModalTitle').textContent = translate('common.loading');
  body.replaceChildren(createElement('div', { class: 'skeleton delayed u-h-14', 'aria-hidden': 'true' }));
  openModal('pageModal');
  try {
    const data = await api(`/api/admin/pages?id=${encodeURIComponent(id)}`);
    const p = data.page;
    byId('pageModalTitle').textContent = `/${p.slug}`;
    const refresh = () => openPage(id);
    const avatar = createElement('div', { class: 'avatar admin-avatar', 'aria-hidden': 'true' });
    fillAvatar(avatar, p.avatarUrl, p.displayName || p.slug);
    // Any staff member can take a picture down, the way they can a link.
    const removeAvatar = p.avatarUrl
      ? actionButton('admin.remove-avatar', 'trash', () => askReason({
        title: translate('admin.remove-avatar-title', { slug: p.slug }),
        body: translate('admin.remove-avatar-body'),
        run: async (reason) => {
          await post('/api/admin/pages', { action: 'remove-avatar', id: p.id, reason });
          toast(translate('admin.done'));
          refresh();
        },
      }), 'btn-danger')
      : null;
    body.replaceChildren(...[
      createElement('div', { class: 'row admin-avatar-row' }, [avatar, removeAvatar]),
      createElement('p', { class: 'muted small', text: [p.displayName, translate('admin.created', { when: formatDate(p.createdAt) })].filter(Boolean).join(' · ') }),
      p.bio ? createElement('pre', { text: p.bio }) : null,
      createElement('div', { class: 'tags row u-mt-05' }, pageBadges(p).filter(Boolean)),
      p.renamedFrom ? createElement('p', { class: 'small', text: translate('admin.renamed-from', { slug: p.renamedFrom.slug, when: formatDate(p.renamedFrom.at) }) }) : null,
      p.redirectUrl ? createElement('p', { class: 'small', text: translate('admin.redirects-to', { url: p.redirectUrl }) }) : null,
      p.quarantineReason ? createElement('p', { class: 'callout danger', text: translate('admin.quarantine-reason', { reason: p.quarantineReason }) }) : null,
      p.banReason ? createElement('p', { class: 'callout danger', text: translate('admin.ban-reason', { reason: p.banReason }) }) : null,
      p.team ? createElement('p', { class: 'callout ok', text: translate('admin.team-since', { when: formatDate(p.team.verifiedAt) }) }) : null,
      createElement('div', { class: 'actions inline' }, [approveAction(p, () => { refresh(); refreshLists(); }), releaseAction(p, () => { refresh(); refreshLists(); }), ...teamActions(p, () => { refresh(); refreshLists(); }), ...banActions(p, () => { refresh(); refreshLists(); }), deleteAction(p)].filter(Boolean)),
      createElement('p', { class: 'modal-section-label', text: translate('admin.tab-links') }),
      data.linkCap ? createElement('div', { class: 'row between' }, [
        createElement('p', { class: 'small u-m-0', text: translate(data.linkCap.custom ? 'admin.caps-page-own' : 'admin.caps-page-default', { used: formatNumber(data.linkCap.used), limit: formatNumber(data.linkCap.limit) }) }),
        isAdmin() ? actionButton('admin.caps-change', 'edit', () => changePageCap({ id: p.id, slug: p.slug, limit: data.linkCap.limit }, data.linkCap.defaultCap, refresh)) : null,
      ]) : null,
      createElement('ul', { class: 'data-list' }, data.links.length ? data.links.map((l) => linkRow(l, refresh)) : [createElement('li', { class: 'empty-state', text: translate('admin.empty-links') })]),
      createElement('p', { class: 'modal-section-label', text: translate('admin.tab-reports') }),
      createElement('ul', { class: 'data-list' }, data.reports.length ? data.reports.map((r) => createElement('li', { class: 'data-row' }, [createElement('div', {}, [
        createElement('div', { class: 'primary', text: `${translate(`report.reason-${r.reason}`)} · ${translate(`admin.report-${r.status}`)}` }),
        createElement('div', { class: 'secondary', text: formatDate(r.createdAt) }),
        r.details ? createElement('pre', { text: r.details }) : null,
      ]), createElement('div', { class: 'row-actions' }, [deleteReportAction(r, () => { refresh(); loaders.reports?.(); })].filter(Boolean))])) : [createElement('li', { class: 'empty-state', text: translate('admin.empty-reports') })]),
    ].filter(Boolean));
  } catch (error) {
    if (guardSession(error)) closeModal('pageModal');
    else body.replaceChildren(createElement('p', { class: 'callout danger', text: errorText(error) }));
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
    const q = encodeURIComponent(byId('linkQuery').value.trim());
    const state = encodeURIComponent(byId('linkState').value);
    const data = await api(`/api/admin/links?q=${q}&state=${state}&offset=${offset}`);
    fill(list, data.links.map((l) => linkRow(l, () => loaders.links())), 'admin.empty-links');
    pager(byId('linkPager'), data, loaders.links);
  } catch (error) {
    if (!guardSession(error)) fill(list, [createElement('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-links');
  }
};
byId('linkSearch').addEventListener('submit', (e) => { e.preventDefault(); loaders.links(0); });
byId('linkState').addEventListener('change', () => loaders.links(0));

function linkRow(l, after) {
  const info = createElement('div', {}, [
    createElement('div', { class: 'primary' }, [iconNode(l.icon), ' ', l.title, l.slug ? ` · /${l.slug}` : '']),
    createElement('div', { class: 'secondary', text: l.url }),
    l.removedReason ? createElement('div', { class: 'secondary', text: translate('admin.removed-reason', { reason: l.removedReason }) }) : null,
    createElement('div', { class: 'tags' }, [
      l.removedAt ? badge(translate('admin.link-removed'), 'danger') : badge(translate(l.isActive ? 'admin.link-shown' : 'admin.link-hidden'), l.isActive ? 'ok' : ''),
      badge(translate('link.clicks', { count: l.clicks, n: formatNumber(l.clicks) })),
    ]),
  ]);
  const actions = createElement('div', { class: 'row-actions' });
  if (l.removedAt) {
    actions.append(actionButton('admin.restore', 'restore', () => askReason({
      title: translate('admin.restore-title'),
      required: false,
      run: async () => {
        await post('/api/admin/links', { action: 'restore', id: l.id });
        toast(translate('admin.done'));
        after();
      },
    })));
  } else {
    actions.append(actionButton('admin.remove', 'trash', () => askReason({
      title: translate('admin.remove-title'),
      body: translate('admin.remove-body'),
      run: async (reason) => {
        await post('/api/admin/links', { action: 'remove', id: l.id, reason });
        toast(translate('admin.done'));
        after();
      },
    }), 'btn-danger'));
  }
  const open = createElement('a', { class: 'btn btn-small btn-quiet', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow', 'aria-label': translate('admin.open-link') });
  open.innerHTML = icon('external');
  actions.append(open);
  return createElement('li', { class: 'data-row' }, [info, actions]);
}

// ---------------------------------------------------------------------------
// Block lists (admin)
// ---------------------------------------------------------------------------

// Patterns are removed by id, names and domains by their value.
function blockRows(items, kind) {
  return items.map((item) => createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      createElement('div', { class: `primary${item.id ? ' mono' : ''}`, text: item.value }),
      createElement('div', { class: 'secondary', text: [item.reason, formatDate(item.createdAt)].filter(Boolean).join(' · ') }),
      item.appliesTo ? createElement('div', { class: 'tags' }, [badge(translate(`admin.scope-${item.appliesTo}`))]) : null,
    ]),
    createElement('div', { class: 'row-actions' }, [actionButton('common.remove', 'trash', async () => {
      try {
        const body = item.id ? { action: `remove-${kind}`, id: item.id } : { action: `remove-${kind}`, value: item.value };
        renderBlocks(await post('/api/admin/blocklist', body));
      } catch (error) {
        toast(errorText(error));
      }
    })]),
  ]));
}

function renderThreatList(info) {
  const line = byId('threatListInfo');
  byId('threatListRefresh').hidden = !info || info.off;
  if (!info || info.off) return void (line.textContent = translate('admin.threat-off'));
  // The server counts each category (harmful, gambling, adult, shortener).
  const total = Object.values(info.categories || {}).reduce((sum, n) => sum + n, 0);
  line.textContent = info.builtAt
    ? translate('admin.threat-info', { count: total, n: formatNumber(total), when: formatDate(info.builtAt), days: info.refreshDays })
    : translate('admin.threat-none');
}

function flaggedRows(items) {
  return items.map((item) => createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      createElement('div', { class: 'primary mono', text: item.id }),
      createElement('div', { class: 'secondary', text: [
        translate('admin.flagged-attempts', { count: item.attempts, n: formatNumber(item.attempts) }),
        translate('admin.flagged-since', { when: formatDate(item.since) }),
        item.slug ? translate('admin.flagged-page', { slug: item.slug }) : null,
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
  ]));
}

// Devices banned with a connection, seen on one that is not (guards.js).
function flaggedDeviceRows(items) {
  return items.map((item) => createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      createElement('div', { class: 'primary mono', text: translate('admin.flagged-device', { device: item.device, connection: item.connection }) }),
      createElement('div', { class: 'secondary', text: [
        translate('admin.flagged-device-requests', { count: item.requests, n: formatNumber(item.requests) }),
        translate('admin.flagged-since', { when: formatDate(item.since) }),
        item.slug ? translate('admin.flagged-page', { slug: item.slug }) : null,
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
  ]));
}

function bannedRows(items) {
  return items.map((item) => createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      createElement('div', { class: 'primary mono', text: item.id }),
      createElement('div', { class: 'secondary', text: [item.reason, formatDate(item.since)].filter(Boolean).join(' · ') }),
      item.slugs.length ? createElement('div', { class: 'secondary', text: translate('admin.banned-pages', { pages: item.slugs.map((s) => `/${s}`).join(', ') }) }) : null,
      item.devices ? createElement('div', { class: 'secondary', text: translate('admin.banned-devices', { count: item.devices, n: formatNumber(item.devices) }) }) : null,
      createElement('div', { class: 'tags' }, [badge(translate(item.byStaff ? 'admin.banned-by-staff' : 'admin.banned-auto'))]),
    ]),
    createElement('div', { class: 'row-actions' }, [actionButton('admin.unban-connection', 'check', async () => {
      try {
        renderBlocks(await post('/api/admin/blocklist', { action: 'unban-connection', id: item.id }));
        toast(translate('admin.connection-unbanned'));
      } catch (error) {
        toast(errorText(error));
      }
    })]),
  ]));
}

// Each block list shows five at a time with its own pager, and keeps its
// place when an entry is added or removed (or steps back a page when its
// last entry goes).
const BLOCKS_PER_PAGE = 5;
const blockOffsets = {};

function fillPaged(listId, pagerId, rows, emptyKey) {
  const total = rows.length;
  let offset = blockOffsets[listId] || 0;
  if (offset >= total) offset = Math.max(0, Math.floor((total - 1) / BLOCKS_PER_PAGE) * BLOCKS_PER_PAGE);
  blockOffsets[listId] = offset;
  fill(byId(listId), rows.slice(offset, offset + BLOCKS_PER_PAGE), emptyKey);
  pager(byId(pagerId), { total, offset, pageSize: BLOCKS_PER_PAGE }, (next) => {
    blockOffsets[listId] = next;
    fillPaged(listId, pagerId, rows, emptyKey);
  });
}

function renderBlocks(data) {
  fillPaged('flaggedList', 'flaggedPager', flaggedRows(data.flagged ?? []), 'admin.empty-flagged');
  fillPaged('flaggedDeviceList', 'flaggedDevicePager', flaggedDeviceRows(data.flaggedVisitors ?? []), 'admin.empty-flagged-devices');
  fillPaged('bannedList', 'bannedPager', bannedRows(data.banned ?? []), 'admin.empty-banned');
  fillPaged('slugBlockList', 'slugBlockPager', blockRows(data.slugs, 'slug'), 'admin.empty-blocks');
  fillPaged('domainBlockList', 'domainBlockPager', blockRows(data.domains, 'domain'), 'admin.empty-blocks');
  fillPaged('allowedBlockList', 'allowedBlockPager', blockRows(data.allowed ?? [], 'allowed'), 'admin.empty-allowed');
  fillPaged('patternBlockList', 'patternBlockPager', blockRows(data.patterns, 'pattern'), 'admin.empty-blocks');
  fillPaged('reviewBlockList', 'reviewBlockPager', blockRows(data.reviews, 'review'), 'admin.empty-blocks');
  renderThreatList(data.threatList);
}

loaders.blocks = async () => {
  if (!isAdmin()) return;
  for (const id of ['slugBlockList', 'domainBlockList', 'allowedBlockList', 'patternBlockList', 'reviewBlockList', 'flaggedList', 'flaggedDeviceList', 'bannedList']) loading(byId(id));
  try {
    renderBlocks(await api('/api/admin/blocklist'));
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};

for (const [formId, kind] of [['slugBlockForm', 'slug'], ['domainBlockForm', 'domain'], ['allowedBlockForm', 'allowed'], ['patternBlockForm', 'pattern'], ['reviewBlockForm', 'review']]) {
  byId(formId).addEventListener('submit', (e) => {
    e.preventDefault();
    const button = byId(formId).querySelector('button[type="submit"]');
    withBusy(button, null, async () => {
      const value = byId(`${kind}BlockValue`).value;
      const reason = byId(`${kind}BlockReason`).value;
      const appliesTo = kind === 'pattern' ? byId('patternBlockScope').value : undefined;
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
  const scope = byId('patternBlockScope').value === 'names' ? 'names' : 'links';
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
      if (!guardSession(error)) toast(errorText(error));
    }
  };
  const pending = all.filter((x) => x.status === 'pending');
  fill(byId('testimonialPending'), pending.map((item) => createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      createElement('div', { class: 'primary', text: `“${item.quote}”` }),
      createElement('div', { class: 'secondary' }, [
        item.pageSlug ? createElement('a', { class: 'text-link', href: `/${item.pageSlug}`, target: '_blank', rel: 'noopener noreferrer', text: `${item.author} · /${item.pageSlug}` }) : item.author,
        ` · ${formatDate(item.createdAt)}`,
      ]),
    ]),
    createElement('div', { class: 'row-actions' }, [
      actionButton('admin.approve', 'check', () => send(item, { action: 'approve' }), 'btn-primary'),
      actionButton('admin.decline', 'close', () => send(item, { action: 'decline' })),
    ]),
  ])), 'admin.empty-pending-testimonials');
  const list = all.filter((x) => x.status !== 'pending');
  fill(byId('testimonialList'), list.map((item, i) => {
    const act = (body) => send(item, body);
    const up = createElement('button', { class: 'icon-btn small', type: 'button', 'aria-label': translate('admin.move-up'), disabled: i === 0, onclick: () => act({ action: 'move', delta: -1 }) });
    up.innerHTML = icon('arrow-up');
    const down = createElement('button', { class: 'icon-btn small', type: 'button', 'aria-label': translate('admin.move-down'), disabled: i === list.length - 1, onclick: () => act({ action: 'move', delta: 1 }) });
    down.innerHTML = icon('arrow-down');
    return createElement('li', { class: `data-row${item.isVisible ? '' : ' off'}` }, [
      createElement('div', {}, [
        createElement('div', { class: 'primary', text: `“${item.quote}”` }),
        createElement('div', { class: 'secondary', text: [item.author, item.pageSlug ? `/${item.pageSlug}` : null].filter(Boolean).join(' · ') }),
        createElement('div', { class: 'tags' }, [
          item.status === 'declined' ? badge(translate('admin.declined'), 'danger') : null,
          item.isVisible ? null : badge(translate('admin.hidden')),
          item.sentByOwner ? badge(translate('admin.sent-by-owner')) : null,
        ]),
      ]),
      // Arranging the published list is for admins; editors see it as it is.
      !isAdmin() ? null : createElement('div', { class: 'row-actions' }, [
        up,
        down,
        actionButton(item.isVisible ? 'admin.hide' : 'admin.show', item.isVisible ? 'eye-off' : 'eye', () => act({ action: 'update', isVisible: !item.isVisible })),
        actionButton('common.remove', 'trash', () => {
          if (window.confirm(translate('admin.testimonial-remove-confirm', { author: item.author }))) act({ action: 'remove' });
        }),
      ]),
    ]);
  }), 'admin.empty-testimonials');
}

loaders.testimonials = async () => {
  loading(byId('testimonialPending'));
  loading(byId('testimonialList'));
  try {
    renderTestimonials((await api('/api/admin/testimonials')).testimonials);
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};

byId('testimonialForm').addEventListener('submit', (e) => {
  e.preventDefault();
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

// The number dialog, for answering a request and setting a page's limit.
// useDefault, when given, is the default limit, offered as a way back to it.
// min and max bound the number; optional lets it be left empty (a decline
// without a smaller raise); askNumber: false hides it altogether.
let capAction = null;
function askCap({ title, body, value = '', label = 'admin.caps-limit', min = 1, max = null, optional = false, askNumber = true, note = false, useDefault = null, run }) {
  const top = max ?? caps?.maxCap ?? 200;
  capAction = { run, useDefault, min, max: top, optional, askNumber };
  byId('capTitle').textContent = title;
  byId('capBody').textContent = body;
  byId('capValueRow').hidden = !askNumber;
  byId('capValueLabel').textContent = translate(label);
  byId('capValue').min = String(min);
  byId('capValue').max = String(top);
  byId('capValue').value = value ?? '';
  byId('capValue').disabled = false;
  byId('capUseDefaultRow').hidden = useDefault === null;
  byId('capUseDefault').checked = false;
  if (useDefault !== null) byId('capUseDefaultLabel').textContent = translate('admin.caps-use-default', { limit: formatNumber(useDefault) });
  byId('capNoteRow').hidden = !note;
  byId('capNote').value = '';
  byId('capError').textContent = '';
  openModal('capModal', { initialFocus: askNumber ? byId('capValue') : (note ? byId('capNote') : null) });
}
byId('capUseDefault').addEventListener('change', (e) => { byId('capValue').disabled = e.target.checked; });
byId('capForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!capAction) return;
  const { min, max, optional, askNumber } = capAction;
  const backToDefault = capAction.useDefault !== null && byId('capUseDefault').checked;
  const value = askNumber ? byId('capValue').value.trim() : '';
  const none = backToDefault || !askNumber || (optional && value === '');
  if (!none && (!/^\d{1,4}$/.test(value) || Number(value) < min || Number(value) > max)) {
    byId('capError').textContent = translate('error.cap_grant_range', { min: formatNumber(min), max: formatNumber(max) });
    return;
  }
  withBusy(byId('capSubmit'), byId('capError'), async () => {
    await capAction.run(none ? null : Number(value), byId('capNote').value.trim());
    closeModal('capModal');
    toast(translate('admin.done'));
  });
});

function pageLink(slug, displayName) {
  return createElement('div', { class: 'primary' }, [
    createElement('a', { class: 'text-link', href: `/${slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${slug}` }),
    displayName ? ` · ${displayName}` : '',
  ]);
}

async function sendCaps(body) {
  renderCaps(await post('/api/admin/link-caps', body));
}

function changePageCap(p, defaultCap, after = null) {
  askCap({
    title: translate('admin.caps-page-title', { slug: p.slug }),
    body: translate('admin.caps-page-body'),
    value: p.limit,
    useDefault: defaultCap,
    run: async (cap) => {
      await sendCaps({ action: 'set-page', id: p.id, cap });
      after?.();
    },
  });
}

// Any staff member answers requests. Approving gives more than the page has
// now: up to what was asked (editors) or the ceiling (admins). Declining can
// come with a smaller raise, between the two.
function capRequestRow(r) {
  const numbers = { requested: formatNumber(r.requested), used: formatNumber(r.used), limit: formatNumber(r.limit) };
  const approveMax = isAdmin() ? (caps?.maxCap ?? 200) : r.requested;
  const compromise = { min: r.limit + 1, max: r.requested - 1 };
  return createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      pageLink(r.slug, r.displayName),
      createElement('div', { class: 'secondary', text: translate('admin.caps-wants', numbers) }),
      createElement('pre', { text: r.reason }),
      createElement('div', { class: 'secondary', text: formatDate(r.createdAt) }),
    ]),
    createElement('div', { class: 'row-actions' }, [
      actionButton('admin.approve', 'check', () => askCap({
        title: translate('admin.caps-approve-title', { slug: r.slug }),
        body: translate('admin.caps-approve-body', { ...numbers, min: formatNumber(r.limit + 1), max: formatNumber(approveMax) }),
        value: r.requested,
        min: r.limit + 1,
        max: approveMax,
        note: true,
        run: (cap, note) => sendCaps({ action: 'approve', id: r.id, cap, note }),
      }), 'btn-primary'),
      actionButton('admin.decline', 'close', () => {
        const canCompromise = compromise.min <= compromise.max;
        askCap({
          title: translate('admin.caps-decline-title', { slug: r.slug }),
          body: canCompromise
            ? translate('admin.caps-decline-compromise-body', { ...numbers, min: formatNumber(compromise.min), max: formatNumber(compromise.max) })
            : translate('admin.caps-decline-body'),
          label: 'admin.caps-compromise',
          min: compromise.min,
          max: compromise.max,
          optional: true,
          askNumber: canCompromise,
          note: true,
          run: (cap, note) => sendCaps({ action: 'decline', id: r.id, cap, note }),
        });
      }),
    ]),
  ]);
}

function capCustomRow(p) {
  return createElement('li', { class: 'data-row' }, [
    createElement('div', {}, [
      pageLink(p.slug, p.displayName),
      createElement('div', { class: 'secondary', text: translate('admin.caps-uses', { used: formatNumber(p.used), limit: formatNumber(p.limit) }) }),
      p.used > p.limit ? createElement('div', { class: 'tags' }, [badge(translate('admin.caps-over'), 'warn')]) : null,
    ]),
    createElement('div', { class: 'row-actions' }, [actionButton('admin.caps-change', 'edit', () => changePageCap(p, caps?.defaultCap ?? null))]),
  ]);
}

function renderCaps(data) {
  caps = data;
  const input = byId('capDefault');
  input.max = String(data.maxCap);
  if (document.activeElement !== input) input.value = String(data.defaultCap);
  fill(byId('capRequestList'), data.pending.map(capRequestRow), 'admin.caps-empty-requests');
  // Admins only: editors are not sent it.
  if (data.custom) fill(byId('capCustomList'), data.custom.map(capCustomRow), 'admin.caps-empty-custom');
}

loaders.caps = async () => {
  loading(byId('capRequestList'));
  if (isAdmin()) loading(byId('capCustomList'));
  try {
    renderCaps(await api('/api/admin/link-caps'));
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};

byId('capDefaultForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('capDefaultSave'), byId('capDefaultError'), async () => {
    await sendCaps({ action: 'set-default', cap: byId('capDefault').value.trim() });
    toast(translate('admin.done'));
  });
});

// ---------------------------------------------------------------------------
// Audit log (admin)
// ---------------------------------------------------------------------------

let auditOffset = 0;
loaders.audit = async (offset = auditOffset) => {
  if (!isAdmin()) return;
  auditOffset = offset;
  const list = byId('auditList');
  loading(list);
  try {
    const data = await api(`/api/admin/audit?action=${encodeURIComponent(byId('auditFilter').value)}&offset=${offset}`);
    fill(list, data.entries.map((entry) => {
      const actor = entry.actorType === 'staff'
        ? translate('admin.actor-staff', { name: entry.actorName || entry.actorId || '?' })
        : translate(`admin.actor-${entry.actorType}`);
      const details = Object.keys(entry.details || {}).length ? JSON.stringify(entry.details, null, 2) : '';
      return createElement('li', { class: 'data-row' }, [createElement('div', {}, [
        createElement('div', { class: 'primary', text: entry.action }),
        createElement('div', { class: 'secondary', text: `${formatDate(entry.createdAt)} · ${actor}` }),
        details ? createElement('pre', { text: details }) : null,
      ])]);
    }), 'admin.empty-audit');
    pager(byId('auditPager'), data, loaders.audit);
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};
byId('auditFilter').addEventListener('change', () => loaders.audit(0));

// ---------------------------------------------------------------------------
// Staff passkeys
// ---------------------------------------------------------------------------

function renderStaffPasskeys(passkeys) {
  const list = byId('staffPasskeyList');
  list.replaceChildren(...(passkeys.length ? passkeys.map((key, n) => {
    const remove = createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', text: translate('common.remove') });
    remove.addEventListener('click', () => askPassword(
      (password) => post('/api/admin/passkeys', { action: 'remove', id: key.id, password }),
      (data) => renderStaffPasskeys(data.passkeys)
    ));
    return createElement('li', {}, [
      createElement('div', {}, [
        createElement('div', { text: key.label || translate('security.passkey-n', { n: n + 1 }) }),
        createElement('small', { text: key.lastUsedAt ? translate('security.last-used', { when: formatDate(key.lastUsedAt) }) : translate('security.added', { when: formatDate(key.createdAt) }) }),
      ]),
      remove,
    ]);
  }) : [createElement('li', { class: 'empty-state', text: translate('admin.no-passkeys') })]));
}

loaders.account = async () => {
  byId('staffPasskeyAdd').disabled = !passkeysSupported();
  try {
    renderStaffPasskeys((await api('/api/admin/passkeys')).passkeys);
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};

let pending = null;
function askPassword(fn, then) {
  pending = { fn, then };
  byId('confirmPassword').value = '';
  byId('passwordError').textContent = '';
  byId('passwordModalTitle').textContent = translate('confirm.title');
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
    if (then) await then(data);
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

onChange(() => {
  if (staff) {
    byId('staffWho').textContent = translate('admin.signed-in-as', { name: staff.displayName || staff.username, role: translate(`admin.role-${staff.role}`) });
    const current = tabs.find((x) => x.getAttribute('aria-selected') === 'true');
    if (current) selectTab(current);
  }
  if (method) pickMethod(method);
});

api('/api/admin/auth')
  .then((data) => enter(data.staff))
  .catch(() => show('login'));
