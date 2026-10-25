// An eye button inside every password field, to show what is being typed.
//
// A real <button> with aria-pressed and a label that says what it will do,
// so it is keyboard operable and announced. The field goes back to hidden
// when its form is submitted, so a shown password is never left on screen
// behind the next step.

import { t, onChange } from '../assets/i18n/i18n.js';
import { icon } from './icons.js';

const toggles = [];

function render(button, input) {
  const shown = input.type === 'text';
  button.innerHTML = icon(shown ? 'eye-off' : 'eye');
  button.setAttribute('aria-pressed', String(shown));
  button.setAttribute('aria-label', t(shown ? 'password.hide' : 'password.show'));
  button.title = t(shown ? 'password.hide' : 'password.show');
}

function wire(input) {
  if (input.dataset.revealable) return;
  input.dataset.revealable = 'true';
  if (!input.id) input.id = `pw-${Math.random().toString(36).slice(2, 9)}`;

  const wrap = document.createElement('div');
  wrap.className = 'password-field';
  input.replaceWith(wrap);
  wrap.appendChild(input);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'password-reveal';
  button.setAttribute('aria-controls', input.id);
  wrap.appendChild(button);

  button.addEventListener('click', () => {
    // Keep the caret where it was, so typing carries on uninterrupted.
    const { selectionStart, selectionEnd } = input;
    input.type = input.type === 'password' ? 'text' : 'password';
    render(button, input);
    input.focus();
    try { input.setSelectionRange(selectionStart, selectionEnd); } catch { /* not all types allow it */ }
  });

  input.form?.addEventListener('submit', () => {
    if (input.type !== 'password') {
      input.type = 'password';
      render(button, input);
    }
  });

  render(button, input);
  toggles.push([button, input]);
}

export function initPasswordToggles(root = document) {
  root.querySelectorAll('input[type="password"]').forEach(wire);
}

onChange(() => toggles.forEach(([button, input]) => render(button, input)));
