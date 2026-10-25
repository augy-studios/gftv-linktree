// The staff dashboard: sign in with a GFTV account, then moderate.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { openModal, closeModal, withBusy, toast, el, formatNumber, formatDate, errorText, setBusy } from '../ui.js';
import { icon, iconNode } from '../icons.js';
import { passkeysSupported, createPasskey, usePasskey, passkeyErrorCode } from '../passkeys.js';
import { fillAvatar } from '../avatar.js';

const $ = (id) => document.getElementById(id);
let staff = null;

function show(name) {
  $('adminLoading').hidden = name !== 'loading';
  $('staffLogin').hidden = name !== 'login';
  $('dashboard').hidden = name !== 'dashboard';
  $('staffSignOut').hidden = name !== 'dashboard';
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

let challenge = null;
let method = null;

$('staffPasswordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('staffPasswordSubmit'), $('staffPasswordError'), async () => {
    const data = await post('/api/admin/auth', { action: 'login', identifier: $('staffIdentifier').value, password: $('staffPassword').value });
    challenge = data.challenge;
    $('staffPassword').value = '';
    const usable = { totp: data.methods.totp, passkey: data.methods.passkey && passkeysSupported(), backup: data.methods.backup };
    document.querySelectorAll('#staffMethods [data-method]').forEach((b) => { b.hidden = !usable[b.dataset.method]; });
    $('staffPasswordForm').hidden = true;
    $('staffCodeForm').hidden = false;
    pickMethod(usable.totp ? 'totp' : usable.passkey ? 'passkey' : 'backup');
  });
});

function pickMethod(name) {
  method = name;
  document.querySelectorAll('#staffMethods [data-method]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.method === name)));
  $('staffCodeField').hidden = name === 'passkey';
  $('staffCodeSubmitRow').hidden = name === 'passkey';
  $('staffPasskeyRow').hidden = name !== 'passkey';
  $('staffCodeLabel').textContent = t(name === 'backup' ? 'field.backup-code' : 'field.code');
  const input = $('staffCode');
  input.value = '';
  input.inputMode = name === 'totp' ? 'numeric' : 'text';
  if (name !== 'passkey') input.focus();
}
document.querySelectorAll('#staffMethods [data-method]').forEach((b) => b.addEventListener('click', () => pickMethod(b.dataset.method)));

function backToPassword(error) {
  if (error.code !== 'challenge_expired') return;
  $('staffCodeForm').hidden = true;
  $('staffPasswordForm').hidden = false;
  $('staffPasswordError').textContent = t('error.challenge_expired');
}

$('staffCodeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('staffCodeSubmit'), $('staffCodeError'), async () => {
    try {
      const data = await post('/api/admin/auth', { action: 'verify', challenge, method, code: $('staffCode').value });
      enter(data.staff);
    } catch (error) {
      backToPassword(error);
      throw error;
    }
  });
});

$('staffPasskeyUse').addEventListener('click', () => {
  withBusy($('staffPasskeyUse'), $('staffCodeError'), async () => {
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

$('staffSignOut').addEventListener('click', async () => {
  await post('/api/admin/auth', { action: 'logout' }).catch(() => {});
  window.location.reload();
});

// Any 401 later on means the session ended or the role was taken away.
function guardSession(error) {
  if (error.status === 401) {
    toast(t('error.signed_out'));
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
    $(other.getAttribute('aria-controls')).hidden = !on;
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
  $('staffWho').textContent = t('admin.signed-in-as', { name: user.displayName || user.username, role: t(`admin.role-${user.role}`) });
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
  const prev = el('button', { class: 'btn btn-small', type: 'button', disabled: data.offset === 0, onclick: () => go(Math.max(0, data.offset - data.pageSize)) }, [t('admin.previous')]);
  const next = el('button', { class: 'btn btn-small', type: 'button', disabled: to >= data.total, onclick: () => go(data.offset + data.pageSize) }, [t('admin.next')]);
  container.append(prev, el('span', { text: t('admin.range', { from: formatNumber(from), to: formatNumber(to), total: formatNumber(data.total) }) }), next);
}

function loading(list) {
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(el('li', { class: 'list-loading delayed', 'aria-hidden': 'true' }, [el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })]));
}

function fill(list, rows, emptyKey) {
  list.removeAttribute('aria-busy');
  list.replaceChildren(...(rows.length ? rows : [el('li', { class: 'empty-state', text: t(emptyKey) })]));
}

function badge(text, tone = '') {
  return el('span', { class: `badge ${tone}`.trim(), text });
}

function actionButton(labelKey, iconName, onclick, tone = '') {
  const b = el('button', { class: `btn btn-small ${tone}`.trim(), type: 'button', onclick });
  b.append(iconNode(iconName), el('span', { text: t(labelKey) }));
  return b;
}

function statusBadge(status) {
  return badge(t(`status.${status}`), status === 'banned' ? 'danger' : status === 'active' ? 'ok' : 'warn');
}

// The shared "give a reason" dialog.
let reasonAction = null;
function askReason({ title, body = '', required = true, showRemove = false, run }) {
  reasonAction = { run, required };
  $('reasonTitle').textContent = title;
  $('reasonBody').textContent = body;
  $('reasonText').value = '';
  $('reasonError').textContent = '';
  $('reasonRemoveRow').hidden = !showRemove;
  $('reasonRemoveLink').checked = false;
  $('reasonLabel').textContent = t(required ? 'field.reason' : 'field.note');
  openModal('reasonModal', { initialFocus: $('reasonText') });
}
$('reasonForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!reasonAction) return;
  const text = $('reasonText').value.trim();
  if (reasonAction.required && !text) {
    $('reasonError').textContent = t('error.reason_required');
    return;
  }
  withBusy($('reasonSubmit'), $('reasonError'), async () => {
    await reasonAction.run(text, $('reasonRemoveLink').checked);
    closeModal('reasonModal');
  });
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

loaders.overview = async () => {
  const grid = $('stats');
  grid.setAttribute('aria-busy', 'true');
  grid.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skeleton delayed stat', 'aria-hidden': 'true' }, [el('div', { class: 'value', text: ' ' }), el('div', { class: 'label', text: ' ' })])));
  try {
    const { counts } = await api('/api/admin/overview');
    const items = [
      ['openReports', 'admin.stat-open-reports', 'reports'],
      ['active', 'admin.stat-active'],
      ['pending', 'admin.stat-pending'],
      ['banned', 'admin.stat-banned'],
      ['links', 'admin.stat-links'],
      ['removed', 'admin.stat-removed'],
    ];
    grid.replaceChildren(...items.map(([key, label, tab]) => {
      const card = el(tab ? 'button' : 'div', { class: 'glass-card stat', type: tab ? 'button' : undefined }, [
        el('div', { class: 'value', text: formatNumber(counts[key]) }),
        el('div', { class: 'label', text: t(label) }),
      ]);
      if (tab) card.addEventListener('click', () => selectTab($(`atab-${tab}`), true));
      return card;
    }));
    grid.removeAttribute('aria-busy');
  } catch (error) {
    if (!guardSession(error)) grid.replaceChildren(el('p', { class: 'callout danger', text: errorText(error) }));
  }
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

let reportOffset = 0;
loaders.reports = async (offset = reportOffset) => {
  reportOffset = offset;
  const list = $('reportList');
  loading(list);
  try {
    const data = await api(`/api/admin/reports?status=${encodeURIComponent($('reportStatus').value)}&offset=${offset}`);
    fill(list, data.reports.map(reportRow), 'admin.empty-reports');
    pager($('reportPager'), data, loaders.reports);
  } catch (error) {
    if (!guardSession(error)) fill(list, [el('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-reports');
  }
};
$('reportStatus').addEventListener('change', () => loaders.reports(0));

function reportRow(r) {
  const target = r.link ? t('admin.report-on-link', { title: r.link.title }) : t('admin.report-on-page');
  const tags = el('div', { class: 'tags' }, [
    badge(t(`report.reason-${r.reason}`), r.reason === 'scam' || r.reason === 'malware' ? 'danger' : 'warn'),
    r.pageStatus ? statusBadge(r.pageStatus) : null,
    r.link && r.link.removed ? badge(t('admin.link-removed'), 'danger') : null,
  ]);
  const info = el('div', {}, [
    el('div', { class: 'primary' }, [el('a', { class: 'text-link', href: `/${r.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${r.slug}` }), ` · ${target}`]),
    r.link ? el('div', { class: 'secondary', text: r.link.url }) : null,
    el('div', { class: 'secondary', text: formatDate(r.createdAt) }),
    r.details ? el('pre', { text: r.details }) : null,
    r.resolutionNote ? el('div', { class: 'secondary', text: t('admin.note', { note: r.resolutionNote }) }) : null,
    tags,
  ]);
  const actions = el('div', { class: 'row-actions' });
  if (r.status === 'open') {
    actions.append(
      actionButton('admin.resolve', 'check', () => askReason({
        title: t('admin.resolve-title'),
        body: t('admin.resolve-body'),
        required: false,
        showRemove: Boolean(r.link && !r.link.removed),
        run: async (note, removeLink) => {
          await post('/api/admin/reports', { action: 'resolve', id: r.id, note, removeLink });
          toast(t('admin.done'));
          loaders.reports();
        },
      }), 'btn-primary'),
      actionButton('admin.dismiss', 'close', () => askReason({
        title: t('admin.dismiss-title'),
        required: false,
        run: async (note) => {
          await post('/api/admin/reports', { action: 'dismiss', id: r.id, note });
          toast(t('admin.done'));
          loaders.reports();
        },
      })),
    );
  }
  actions.append(actionButton('admin.view-page', 'eye', () => openPage(r.pageId)));
  return el('li', { class: 'data-row' }, [info, actions]);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

let pageOffset = 0;
loaders.pages = async (offset = pageOffset) => {
  pageOffset = offset;
  const list = $('pageList');
  loading(list);
  try {
    const q = encodeURIComponent($('pageQuery').value.trim());
    const status = encodeURIComponent($('pageStatus').value);
    const data = await api(`/api/admin/pages?q=${q}&status=${status}&offset=${offset}`);
    fill(list, data.pages.map(pageRow), 'admin.empty-pages');
    pager($('pagePager'), data, loaders.pages);
  } catch (error) {
    if (!guardSession(error)) fill(list, [el('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-pages');
  }
};
$('pageSearch').addEventListener('submit', (e) => { e.preventDefault(); loaders.pages(0); });
$('pageStatus').addEventListener('change', () => loaders.pages(0));

function banActions(p, after) {
  if (!isAdmin()) return [];
  if (p.status === 'banned') {
    return [actionButton('admin.unban', 'restore', () => askReason({
      title: t('admin.unban-title', { slug: p.slug }),
      required: false,
      run: async () => {
        await post('/api/admin/pages', { action: 'unban', id: p.id });
        toast(t('admin.done'));
        after();
      },
    }))];
  }
  return [actionButton('admin.ban', 'ban', () => askReason({
    title: t('admin.ban-title', { slug: p.slug }),
    body: t('admin.ban-body'),
    run: async (reason) => {
      await post('/api/admin/pages', { action: 'ban', id: p.id, reason });
      toast(t('admin.done'));
      after();
    },
  }), 'btn-danger')];
}

function pageRow(p) {
  const info = el('div', {}, [
    el('div', { class: 'primary' }, [el('a', { class: 'text-link', href: `/${p.slug}`, target: '_blank', rel: 'noopener noreferrer', text: `/${p.slug}` }), p.displayName ? ` · ${p.displayName}` : '']),
    el('div', { class: 'secondary', text: t('admin.created', { when: formatDate(p.createdAt) }) }),
    p.banReason ? el('div', { class: 'secondary', text: t('admin.ban-reason', { reason: p.banReason }) }) : null,
    el('div', { class: 'tags' }, [
      statusBadge(p.status),
      badge(t('admin.link-count', { count: p.linkCount, n: formatNumber(p.linkCount) })),
      p.reportCount ? badge(t('admin.report-count', { count: p.reportCount, n: formatNumber(p.reportCount) }), 'warn') : null,
      p.telegramLinked ? badge(t('factor.telegram')) : null,
    ]),
  ]);
  return el('li', { class: 'data-row' }, [
    info,
    el('div', { class: 'row-actions' }, [actionButton('admin.view-page', 'eye', () => openPage(p.id)), ...banActions(p, () => loaders.pages())]),
  ]);
}

async function openPage(id) {
  const body = $('pageModalBody');
  $('pageModalTitle').textContent = t('common.loading');
  body.replaceChildren(el('div', { class: 'skeleton delayed u-h-14', 'aria-hidden': 'true' }));
  openModal('pageModal');
  try {
    const data = await api(`/api/admin/pages?id=${encodeURIComponent(id)}`);
    const p = data.page;
    $('pageModalTitle').textContent = `/${p.slug}`;
    const refresh = () => openPage(id);
    const avatar = el('div', { class: 'avatar admin-avatar', 'aria-hidden': 'true' });
    fillAvatar(avatar, p.avatarUrl, p.displayName || p.slug);
    // Any staff member can take a picture down, the way they can a link.
    const removeAvatar = p.avatarUrl
      ? actionButton('admin.remove-avatar', 'trash', () => askReason({
        title: t('admin.remove-avatar-title', { slug: p.slug }),
        body: t('admin.remove-avatar-body'),
        run: async (reason) => {
          await post('/api/admin/pages', { action: 'remove-avatar', id: p.id, reason });
          toast(t('admin.done'));
          refresh();
        },
      }), 'btn-danger')
      : null;
    body.replaceChildren(...[
      el('div', { class: 'row admin-avatar-row' }, [avatar, removeAvatar]),
      el('p', { class: 'muted small', text: [p.displayName, t('admin.created', { when: formatDate(p.createdAt) })].filter(Boolean).join(' · ') }),
      p.bio ? el('pre', { text: p.bio }) : null,
      el('div', { class: 'tags row u-mt-05' }, [statusBadge(p.status)]),
      p.banReason ? el('p', { class: 'callout danger', text: t('admin.ban-reason', { reason: p.banReason }) }) : null,
      el('div', { class: 'actions inline' }, banActions(p, () => { refresh(); loaders.pages?.(); })),
      el('p', { class: 'modal-section-label', text: t('admin.tab-links') }),
      el('ul', { class: 'data-list' }, data.links.length ? data.links.map((l) => linkRow(l, refresh)) : [el('li', { class: 'empty-state', text: t('admin.empty-links') })]),
      el('p', { class: 'modal-section-label', text: t('admin.tab-reports') }),
      el('ul', { class: 'data-list' }, data.reports.length ? data.reports.map((r) => el('li', { class: 'data-row' }, [el('div', {}, [
        el('div', { class: 'primary', text: `${t(`report.reason-${r.reason}`)} · ${t(`admin.report-${r.status}`)}` }),
        el('div', { class: 'secondary', text: formatDate(r.createdAt) }),
        r.details ? el('pre', { text: r.details }) : null,
      ])])) : [el('li', { class: 'empty-state', text: t('admin.empty-reports') })]),
    ].filter(Boolean));
  } catch (error) {
    if (guardSession(error)) closeModal('pageModal');
    else body.replaceChildren(el('p', { class: 'callout danger', text: errorText(error) }));
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

let linkOffset = 0;
loaders.links = async (offset = linkOffset) => {
  linkOffset = offset;
  const list = $('adminLinkList');
  loading(list);
  try {
    const q = encodeURIComponent($('linkQuery').value.trim());
    const state = encodeURIComponent($('linkState').value);
    const data = await api(`/api/admin/links?q=${q}&state=${state}&offset=${offset}`);
    fill(list, data.links.map((l) => linkRow(l, () => loaders.links())), 'admin.empty-links');
    pager($('linkPager'), data, loaders.links);
  } catch (error) {
    if (!guardSession(error)) fill(list, [el('li', { class: 'callout danger', text: errorText(error) })], 'admin.empty-links');
  }
};
$('linkSearch').addEventListener('submit', (e) => { e.preventDefault(); loaders.links(0); });
$('linkState').addEventListener('change', () => loaders.links(0));

function linkRow(l, after) {
  const info = el('div', {}, [
    el('div', { class: 'primary' }, [iconNode(l.icon), ' ', l.title, l.slug ? ` · /${l.slug}` : '']),
    el('div', { class: 'secondary', text: l.url }),
    l.removedReason ? el('div', { class: 'secondary', text: t('admin.removed-reason', { reason: l.removedReason }) }) : null,
    el('div', { class: 'tags' }, [
      l.removedAt ? badge(t('admin.link-removed'), 'danger') : badge(t(l.isActive ? 'admin.link-shown' : 'admin.link-hidden'), l.isActive ? 'ok' : ''),
      badge(t('link.clicks', { count: l.clicks, n: formatNumber(l.clicks) })),
    ]),
  ]);
  const actions = el('div', { class: 'row-actions' });
  if (l.removedAt) {
    actions.append(actionButton('admin.restore', 'restore', () => askReason({
      title: t('admin.restore-title'),
      required: false,
      run: async () => {
        await post('/api/admin/links', { action: 'restore', id: l.id });
        toast(t('admin.done'));
        after();
      },
    })));
  } else {
    actions.append(actionButton('admin.remove', 'trash', () => askReason({
      title: t('admin.remove-title'),
      body: t('admin.remove-body'),
      run: async (reason) => {
        await post('/api/admin/links', { action: 'remove', id: l.id, reason });
        toast(t('admin.done'));
        after();
      },
    }), 'btn-danger'));
  }
  const open = el('a', { class: 'btn btn-small btn-quiet', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow', 'aria-label': t('admin.open-link') });
  open.innerHTML = icon('external');
  actions.append(open);
  return el('li', { class: 'data-row' }, [info, actions]);
}

// ---------------------------------------------------------------------------
// Block lists (admin)
// ---------------------------------------------------------------------------

function blockRows(items, kind) {
  return items.map((item) => el('li', { class: 'data-row' }, [
    el('div', {}, [
      el('div', { class: 'primary', text: item.value }),
      el('div', { class: 'secondary', text: [item.reason, formatDate(item.createdAt)].filter(Boolean).join(' · ') }),
    ]),
    el('div', { class: 'row-actions' }, [actionButton('common.remove', 'trash', async () => {
      try {
        renderBlocks(await post('/api/admin/blocklist', { action: `remove-${kind}`, value: item.value }));
      } catch (error) {
        toast(errorText(error));
      }
    })]),
  ]));
}

function renderBlocks(data) {
  fill($('slugBlockList'), blockRows(data.slugs, 'slug'), 'admin.empty-blocks');
  fill($('domainBlockList'), blockRows(data.domains, 'domain'), 'admin.empty-blocks');
}

loaders.blocks = async () => {
  if (!isAdmin()) return;
  loading($('slugBlockList'));
  loading($('domainBlockList'));
  try {
    renderBlocks(await api('/api/admin/blocklist'));
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};

for (const [formId, kind] of [['slugBlockForm', 'slug'], ['domainBlockForm', 'domain']]) {
  $(formId).addEventListener('submit', (e) => {
    e.preventDefault();
    const button = $(formId).querySelector('button[type="submit"]');
    withBusy(button, null, async () => {
      const value = $(`${kind}BlockValue`).value;
      const reason = $(`${kind}BlockReason`).value;
      renderBlocks(await post('/api/admin/blocklist', { action: `add-${kind}`, value, reason }));
      $(`${kind}BlockValue`).value = '';
      $(`${kind}BlockReason`).value = '';
      toast(t('admin.done'));
    });
  });
}

// ---------------------------------------------------------------------------
// Audit log (admin)
// ---------------------------------------------------------------------------

let auditOffset = 0;
loaders.audit = async (offset = auditOffset) => {
  if (!isAdmin()) return;
  auditOffset = offset;
  const list = $('auditList');
  loading(list);
  try {
    const data = await api(`/api/admin/audit?action=${encodeURIComponent($('auditFilter').value)}&offset=${offset}`);
    fill(list, data.entries.map((entry) => {
      const actor = entry.actorType === 'staff'
        ? t('admin.actor-staff', { name: entry.actorName || entry.actorId || '?' })
        : t(`admin.actor-${entry.actorType}`);
      const details = Object.keys(entry.details || {}).length ? JSON.stringify(entry.details, null, 2) : '';
      return el('li', { class: 'data-row' }, [el('div', {}, [
        el('div', { class: 'primary', text: entry.action }),
        el('div', { class: 'secondary', text: `${formatDate(entry.createdAt)} · ${actor}` }),
        details ? el('pre', { text: details }) : null,
      ])]);
    }), 'admin.empty-audit');
    pager($('auditPager'), data, loaders.audit);
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};
$('auditFilter').addEventListener('change', () => loaders.audit(0));

// ---------------------------------------------------------------------------
// Staff passkeys
// ---------------------------------------------------------------------------

function renderStaffPasskeys(passkeys) {
  const list = $('staffPasskeyList');
  list.replaceChildren(...(passkeys.length ? passkeys.map((key, n) => {
    const remove = el('button', { class: 'btn btn-small btn-quiet', type: 'button', text: t('common.remove') });
    remove.addEventListener('click', () => askPassword(
      (password) => post('/api/admin/passkeys', { action: 'remove', id: key.id, password }),
      (data) => renderStaffPasskeys(data.passkeys)
    ));
    return el('li', {}, [
      el('div', {}, [
        el('div', { text: key.label || t('security.passkey-n', { n: n + 1 }) }),
        el('small', { text: key.lastUsedAt ? t('security.last-used', { when: formatDate(key.lastUsedAt) }) : t('security.added', { when: formatDate(key.createdAt) }) }),
      ]),
      remove,
    ]);
  }) : [el('li', { class: 'empty-state', text: t('admin.no-passkeys') })]));
}

loaders.account = async () => {
  $('staffPasskeyAdd').disabled = !passkeysSupported();
  try {
    renderStaffPasskeys((await api('/api/admin/passkeys')).passkeys);
  } catch (error) {
    if (!guardSession(error)) toast(errorText(error));
  }
};

let pending = null;
function askPassword(fn, then) {
  pending = { fn, then };
  $('confirmPassword').value = '';
  $('passwordError').textContent = '';
  $('passwordModalTitle').textContent = t('confirm.title');
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
    if (then) await then(data);
  });
});

$('staffPasskeyAdd').addEventListener('click', () => askPassword(
  (password) => post('/api/admin/passkeys', { action: 'options', password }),
  async ({ options }) => {
    const button = $('staffPasskeyAdd');
    setBusy(button, true);
    try {
      const response = await createPasskey(options);
      renderStaffPasskeys((await post('/api/admin/passkeys', { action: 'finish', response })).passkeys);
      toast(t('security.passkey-added'));
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
    $('staffWho').textContent = t('admin.signed-in-as', { name: staff.displayName || staff.username, role: t(`admin.role-${staff.role}`) });
    const current = tabs.find((x) => x.getAttribute('aria-selected') === 'true');
    if (current) selectTab(current);
  }
  if (method) pickMethod(method);
});

api('/api/admin/auth')
  .then((data) => enter(data.staff))
  .catch(() => show('login'));
