// An eye button inside every password field, to show what is being typed.
//
// A real <button> with aria-pressed and a label that says what it will do,
// so it is keyboard operable and announced. The field goes back to hidden
// when its form is submitted, so a shown password is never left on screen
// behind the next step.

import { t as translate, onChange } from '../assets/i18n/i18n.js';
import { icon } from './icons.js';

const toggles = [];

function render(button, input) {
  const shown = input.type === 'text';
  if (shown) {
    button.innerHTML = icon('eye-off');
  } else {
    button.innerHTML = icon('eye');
  }
  button.setAttribute('aria-pressed', String(shown));
  let labelText;
  if (shown) {
    labelText = translate('password.hide');
  } else {
    labelText = translate('password.show');
  }
  button.setAttribute('aria-label', labelText);
  if (shown) {
    button.title = translate('password.hide');
  } else {
    button.title = translate('password.show');
  }
}

// Wrap one password field and add its button. A field already wired is left alone.
function wire(input) {
  if (input.dataset.revealable) {
    return;
  }
  input.dataset.revealable = 'true';
  if (!input.id) {
    input.id = `pw-${Math.random().toString(36).slice(2, 9)}`;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'password-field';
  input.replaceWith(wrapper);
  wrapper.appendChild(input);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'password-reveal';
  button.setAttribute('aria-controls', input.id);
  wrapper.appendChild(button);

  button.addEventListener('click', () => {
    // Keep the caret where it was, so typing carries on uninterrupted.
    const { selectionStart, selectionEnd } = input;
    if (input.type === 'password') {
      input.type = 'text';
    } else {
      input.type = 'password';
    }
    render(button, input);
    input.focus();
    try { input.setSelectionRange(selectionStart, selectionEnd); } catch { /* not all types allow it */ }
  });

  if (input.form) {
    input.form.addEventListener('submit', () => {
      if (input.type !== 'password') {
        input.type = 'password';
        render(button, input);
      }
    });
  }

  render(button, input);
  toggles.push([button, input]);
}

export function initPasswordToggles(root = document) {
  root.querySelectorAll('input[type="password"]').forEach(wire);
}

onChange(() => toggles.forEach(([button, input]) => render(button, input)));
