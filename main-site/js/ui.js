// Shared UI helpers: dialogs, the toast, busy buttons, formatting.

import { t as translate, getLocale } from '../assets/i18n/i18n.js';

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
    .filter((element) => {
      if (element.closest('[hidden]')) {
        return false;
      }
      return element.offsetParent !== null;
    });
}

function setBackgroundInert(inert) {
  for (const child of document.body.children) {
    if (child.classList.contains('modal-backdrop') || child.id === 'toast') {
      continue;
    }
    if (inert) {
      child.setAttribute('inert', '');
    } else {
      child.removeAttribute('inert');
    }
  }
  if (inert) {
    document.documentElement.style.overflow = 'hidden';
  } else {
    document.documentElement.style.overflow = '';
  }
}

export function openModal(id, { initialFocus = null, onClose = null } = {}) {
  const backdrop = document.getElementById(id);
  if (!backdrop || !backdrop.classList.contains('hidden')) {
    return;
  }
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
  let target = initialFocus;
  if (!target) {
    target = focusable(backdrop)[0];
  }
  if (target) {
    target.focus();
  }
}

export function closeModal(id) {
  const index = open.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return;
  }
  const [entry] = open.splice(index, 1);
  entry.backdrop.classList.add('hidden');
  if (open.length === 0) {
    setBackgroundInert(false);
  } else {
    open[open.length - 1].backdrop.removeAttribute('inert');
  }
  if (entry.onClose) {
    entry.onClose();
  }
  if (entry.returnTo && typeof entry.returnTo.focus === 'function') {
    entry.returnTo.focus();
  }
}

// One click listener and one key listener serve every dialog: close buttons,
// the backdrop and Escape close the top one, and Tab stays inside it.
export function wireModals() {
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close-modal]');
    if (closer) {
      closeModal(closer.getAttribute('data-close-modal'));
      return;
    }
    if (event.target.classList && event.target.classList.contains('modal-backdrop')) {
      closeModal(event.target.id);
    }
  });
  document.addEventListener('keydown', (event) => {
    const top = open[open.length - 1];
    if (!top) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal(top.id);
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const items = focusable(top.backdrop);
    if (items.length === 0) {
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!top.backdrop.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Toast: one at a time, announced through role="status" without moving focus.
// ---------------------------------------------------------------------------

let toastTimer = null;

export function toast(message, milliseconds = 2200) {
  let toastElement = document.getElementById('toast');
  if (!toastElement) {
    toastElement = document.createElement('div');
    toastElement.id = 'toast';
    toastElement.className = 'toast hidden';
    toastElement.setAttribute('role', 'status');
    document.body.appendChild(toastElement);
  }
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  // Reading offsetHeight forces a layout first, so a new toast still fades in.
  void toastElement.offsetHeight;
  toastElement.classList.remove('hidden');
  toastTimer = setTimeout(() => toastElement.classList.add('hidden'), milliseconds);
}

// ---------------------------------------------------------------------------
// Busy buttons. The spinner sits inside .delayed, so a fast answer never shows
// it; the label stays for screen readers through aria-busy and the text.
// ---------------------------------------------------------------------------

export function setBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  const existing = button.querySelector('.busy-indicator');
  if (busy && !existing) {
    const wrapper = document.createElement('span');
    wrapper.className = 'delayed busy-indicator';
    wrapper.setAttribute('aria-hidden', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    wrapper.appendChild(spinner);
    button.prepend(wrapper);
  } else if (!busy && existing) {
    existing.remove();
  }
}

// Run an async action with a button showing busy, and the error, if any,
// written to a callout as a translated sentence.
export async function withBusy(button, errorBox, action) {
  setBusy(button, true);
  if (errorBox) {
    errorBox.textContent = '';
  }
  try {
    return await action();
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = errorText(error);
    } else {
      toast(errorText(error));
    }
    return undefined;
  } finally {
    setBusy(button, false);
  }
}

// The server adds what a message names: { host } for an address the lists
// refused, { limit }, { min } and { max } for link limits.
const ERROR_PARAMETERS = ['host', 'limit', 'min', 'max'];

// The sentence for an error in the reader's language. A code with no sentence
// of its own reads as the generic one.
export function errorText(error) {
  let code = 'generic';
  if (error && error.code) {
    code = error.code;
  }
  let detail = {};
  if (error !== null && error !== undefined && error.detail) {
    detail = error.detail;
  }
  // The host goes in as written; the numbers are formatted for the locale.
  const parameters = {};
  for (const name of ERROR_PARAMETERS) {
    if (detail[name] !== undefined && detail[name] !== null) {
      if (name === 'host') {
        parameters[name] = detail[name];
      } else {
        parameters[name] = formatNumber(detail[name]);
      }
    }
  }
  let textParameters;
  if (Object.keys(parameters).length) {
    textParameters = parameters;
  } else {
    textParameters = undefined;
  }
  const text = translate(`error.${code}`, textParameters);
  if (text === `error.${code}`) {
    return translate('error.generic');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Formatting and escaping
// ---------------------------------------------------------------------------

export function formatNumber(value) {
  let number = Number(value);
  if (!number) {
    number = 0;
  }
  return new Intl.NumberFormat(getLocale()).format(number);
}

export function formatDate(value) {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build an element: createElement('p', { class: 'muted', text: 'hello' }, [children]).
// Text always goes in through textContent, so owner-written content can never
// become markup.
export function createElement(tag, properties = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key === 'i18n') {
      node.setAttribute('data-i18n', value);
      node.textContent = translate(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (child instanceof Node) {
      node.append(child);
    } else {
      node.append(document.createTextNode(String(child)));
    }
  }
  return node;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(translate('common.copied'));
  } catch {
    toast(translate('error.copy'));
  }
}
