// Shared UI helpers: dialogs, the toast, busy buttons, formatting.

import { t, getLocale } from '../assets/i18n/i18n.js';

// ---------------------------------------------------------------------------
// Dialogs
//
// Opening one moves focus inside, traps it there, makes the rest of the page
// inert and locks scrolling. Escape, the backdrop, and any [data-close-modal]
// close it and return focus to where it was. Show and hide is one .hidden
// class flip; the timing lives in CSS.
// ---------------------------------------------------------------------------

const open = [];

function focusable(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.closest('[hidden]') && el.offsetParent !== null);
}

function setBackgroundInert(on) {
  for (const child of document.body.children) {
    if (child.classList.contains('modal-backdrop') || child.id === 'toast') continue;
    if (on) child.setAttribute('inert', '');
    else child.removeAttribute('inert');
  }
  document.documentElement.style.overflow = on ? 'hidden' : '';
}

export function openModal(id, { initialFocus = null, onClose = null } = {}) {
  const backdrop = document.getElementById(id);
  if (!backdrop || !backdrop.classList.contains('hidden')) return;
  open.forEach((entry) => entry.backdrop.setAttribute('inert', ''));
  open.push({ id, backdrop, returnTo: document.activeElement, onClose });
  // Every backdrop is z-index 50 in style.css, so a dialog opened from inside
  // another one would paint under it whenever it comes earlier in the markup,
  // and sit there unseen while the one on top is inert. Each newly opened
  // dialog goes one above the stack instead (still under the toast, at 60).
  // Not reset on close, so a closing dialog keeps its place while it fades.
  backdrop.style.zIndex = String(50 + open.length);
  backdrop.removeAttribute('inert');
  backdrop.classList.remove('hidden');
  setBackgroundInert(true);
  const target = initialFocus || focusable(backdrop)[0];
  if (target) target.focus();
}

export function closeModal(id) {
  const index = open.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const [entry] = open.splice(index, 1);
  entry.backdrop.classList.add('hidden');
  if (open.length === 0) setBackgroundInert(false);
  else open[open.length - 1].backdrop.removeAttribute('inert');
  if (entry.onClose) entry.onClose();
  if (entry.returnTo && typeof entry.returnTo.focus === 'function') entry.returnTo.focus();
}

export function wireModals() {
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close-modal]');
    if (closer) {
      closeModal(closer.getAttribute('data-close-modal'));
      return;
    }
    if (e.target.classList && e.target.classList.contains('modal-backdrop')) closeModal(e.target.id);
  });
  document.addEventListener('keydown', (e) => {
    const top = open[open.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(top.id);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusable(top.backdrop);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!top.backdrop.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Toast: one at a time, announced through role="status" without moving focus.
// ---------------------------------------------------------------------------

let toastTimer = null;

export function toast(message, ms = 2200) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast hidden';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  clearTimeout(toastTimer);
  el.textContent = message;
  void el.offsetHeight;
  el.classList.remove('hidden');
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------------------
// Busy buttons. The spinner sits inside .delayed, so a fast answer never shows
// it; the label stays for screen readers through aria-busy and the text.
// ---------------------------------------------------------------------------

export function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  const existing = button.querySelector('.busy-indicator');
  if (busy && !existing) {
    const wrap = document.createElement('span');
    wrap.className = 'delayed busy-indicator';
    wrap.setAttribute('aria-hidden', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    wrap.appendChild(spinner);
    button.prepend(wrap);
  } else if (!busy && existing) {
    existing.remove();
  }
}

// Run an async action with a button showing busy, and the error, if any,
// written to a callout as a translated sentence.
export async function withBusy(button, errorBox, fn) {
  setBusy(button, true);
  if (errorBox) errorBox.textContent = '';
  try {
    return await fn();
  } catch (error) {
    if (errorBox) errorBox.textContent = errorText(error);
    else toast(errorText(error));
    return undefined;
  } finally {
    setBusy(button, false);
  }
}

export function errorText(error) {
  const code = error && error.code ? error.code : 'generic';
  const text = t(`error.${code}`, error?.detail?.host ? { host: error.detail.host } : undefined);
  return text === `error.${code}` ? t('error.generic') : text;
}

// ---------------------------------------------------------------------------
// Formatting and escaping
// ---------------------------------------------------------------------------

export function formatNumber(n) {
  return new Intl.NumberFormat(getLocale()).format(Number(n) || 0);
}

export function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build an element: el('p', { class: 'muted', text: 'hello' }, [children]).
// Text always goes in through textContent, so owner-written content can never
// become markup.
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'i18n') {
      node.setAttribute('data-i18n', value);
      node.textContent = t(value);
    } else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('common.copied'));
  } catch {
    toast(t('error.copy'));
  }
}
