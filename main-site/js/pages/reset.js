// Reset a forgotten password: a Telegram code plus the second factor.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, toast } from '../ui.js';
import { normaliseSlugInput } from '../slug-check.js';

const $ = (id) => document.getElementById(id);
let challenge = null;
let factor = 'totp';

function show(id) {
  ['stepFind', 'stepNoTelegram', 'stepReset'].forEach((s) => { $(s).hidden = s !== id; });
  const heading = document.querySelector(`#${id} h1`);
  heading.tabIndex = -1;
  heading.focus();
}

$('findForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('findSubmit'), $('findError'), async () => {
    const data = await post('/api/auth/recover', { action: 'start', slug: normaliseSlugInput($('slug').value) });
    if (!data.telegram) return show('stepNoTelegram');
    challenge = data.challenge;
    show('stepReset');
  });
});

$('telegramSend').addEventListener('click', () => {
  withBusy($('telegramSend'), $('resetError'), async () => {
    await post('/api/auth/recover', { action: 'send', challenge });
    toast(t('telegram.sent'));
    $('telegramCode').focus();
  });
});

function pickFactor(name) {
  factor = name;
  document.querySelectorAll('#stepReset [data-factor]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.factor === name));
  });
  const input = $('factorCode');
  input.value = '';
  input.inputMode = name === 'totp' ? 'numeric' : 'text';
  input.maxLength = name === 'totp' ? 6 : 16;
  $('factorLabel').textContent = t(name === 'totp' ? 'field.code' : 'field.backup-code');
}
document.querySelectorAll('#stepReset [data-factor]').forEach((b) => b.addEventListener('click', () => pickFactor(b.dataset.factor)));
onChange(() => pickFactor(factor));

$('resetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = $('resetError');
  const newPassword = $('newPassword').value;
  if ([...newPassword].length < 10) {
    error.textContent = t('error.password_too_short');
    return;
  }
  if (newPassword !== $('newPasswordConfirm').value) {
    error.textContent = t('error.password_mismatch');
    return;
  }
  withBusy($('resetSubmit'), error, async () => {
    try {
      await post('/api/auth/recover', {
        action: 'finish',
        challenge,
        telegramCode: $('telegramCode').value,
        factor,
        code: $('factorCode').value,
        newPassword,
      });
      window.location.replace('/edit');
    } catch (err) {
      if (err.code === 'challenge_expired') {
        show('stepFind');
        $('findError').textContent = t('error.challenge_expired');
      }
      throw err;
    }
  });
});
