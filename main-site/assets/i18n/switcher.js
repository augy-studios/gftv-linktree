// assets/i18n/switcher.js
// The language button (section 7) and modal (section 8) of
// i18n-retrofit-spec.md. The modal uses the site's shared dialog behaviour
// from js/ui.js: focus trap, inert background, scroll lock, Escape and
// backdrop to close.
import { t, getLocale, getLocales, setLocale, onChange } from './i18n.js';
import { icon } from '../../js/icons.js';
import { openModal, closeModal } from '../../js/ui.js';

const MODAL_ID = 'langModal';
let button = null;

function current() {
  return getLocales().find((l) => l.code === getLocale()) || getLocales()[0];
}

function renderButton() {
  if (!button) return;
  const entry = current();
  button.innerHTML =
    `${icon('globe')}<span class="lang-name"></span><span class="lang-code"></span>`;
  // The visible name is the language's own name, never translated.
  button.querySelector('.lang-name').textContent = entry.name;
  button.querySelector('.lang-code').textContent = entry.code.toUpperCase();
  button.setAttribute('aria-label', t('a11y.language-switcher', { language: entry.name }));
}

function buildModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop sheet hidden';
  backdrop.id = MODAL_ID;
  backdrop.innerHTML = `
    <div class="modal glass-card" role="dialog" aria-modal="true" aria-labelledby="lang-title">
      <h2 id="lang-title" data-i18n="language.modal.title"></h2>
      <ul class="lang-list" role="listbox" aria-labelledby="lang-title"></ul>
      <button type="button" class="btn btn-block lang-close" data-i18n="common.close"></button>
    </div>`;
  backdrop.querySelector('#lang-title').textContent = t('language.modal.title');
  backdrop.querySelector('.lang-close').textContent = t('common.close');

  const list = backdrop.querySelector('.lang-list');
  for (const entry of getLocales()) {
    const li = document.createElement('li');
    li.className = 'lang-option';
    li.setAttribute('role', 'option');
    li.setAttribute('data-locale', entry.code);
    li.setAttribute('lang', entry.code);
    li.setAttribute('dir', entry.dir);
    li.tabIndex = -1;
    const name = document.createElement('span');
    name.textContent = entry.name;
    const check = document.createElement('span');
    check.className = 'lang-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = icon('check');
    li.append(name, check);
    list.appendChild(li);
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.lang-option');
    if (row) choose(row.getAttribute('data-locale'));
  });
  list.addEventListener('keydown', onListKey);
  backdrop.querySelector('.lang-close').addEventListener('click', () => closeModal(MODAL_ID));
  document.body.appendChild(backdrop);
  return backdrop;
}

function rows() {
  return [...document.querySelectorAll(`#${MODAL_ID} .lang-option`)];
}

function syncSelection() {
  const code = getLocale();
  for (const row of rows()) {
    const selected = row.getAttribute('data-locale') === code;
    row.setAttribute('aria-selected', String(selected));
    row.tabIndex = selected ? 0 : -1;
  }
}

function focusRow(index) {
  const all = rows();
  if (all.length === 0) return;
  const i = (index + all.length) % all.length;
  all.forEach((row, n) => { row.tabIndex = n === i ? 0 : -1; });
  all[i].focus();
}

function onListKey(e) {
  const all = rows();
  const index = all.indexOf(document.activeElement);
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusRow(index + 1); break;
    case 'ArrowUp': e.preventDefault(); focusRow(index - 1); break;
    case 'Home': e.preventDefault(); focusRow(0); break;
    case 'End': e.preventDefault(); focusRow(all.length - 1); break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (index >= 0) choose(all[index].getAttribute('data-locale'));
      break;
    default:
      // Typing a letter jumps to the next row starting with it.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const letter = e.key.toLocaleLowerCase();
        for (let step = 1; step <= all.length; step += 1) {
          const n = (index + step) % all.length;
          if (all[n].textContent.trim().toLocaleLowerCase().startsWith(letter)) {
            focusRow(n);
            break;
          }
        }
      }
  }
}

function choose(code) {
  // Selecting the active row just closes.
  if (code !== getLocale()) setLocale(code);
  closeModal(MODAL_ID);
}

function open() {
  syncSelection();
  const selected = rows().find((r) => r.getAttribute('aria-selected') === 'true');
  openModal(MODAL_ID, {
    initialFocus: selected,
    onClose: () => button && button.setAttribute('aria-expanded', 'false'),
  });
  button.setAttribute('aria-expanded', 'true');
}

export function mountSwitcher(slot) {
  if (!slot) return;
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'lang-btn';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', MODAL_ID);
  slot.replaceChildren(button);
  renderButton();
  buildModal();
  button.addEventListener('click', open);
  onChange(() => {
    renderButton();
    syncSelection();
  });
}
