// Reset a forgotten password: a Telegram code plus the second factor.

import '../app.js';
import '../visitor.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, toast } from '../ui.js';
import { normaliseSlugInput } from '../slug-check.js';
import { passkeysSupported, usePasskey, passkeyErrorCode } from '../passkeys.js';
import { humanCheck } from '../turnstile.js';

const byId = (id) => document.getElementById(id);
let challenge = null;
let factor = 'totp';
// Turnstile on the first step (turnstile.js); the rest needs its challenge.
const check = humanCheck(byId('humanCheck'));

byId('stepReset').querySelector('[data-factor="passkey"]').hidden = !passkeysSupported();

function show(id) {
  ['stepFind', 'stepNoTelegram', 'stepReset'].forEach((s) => { byId(s).hidden = s !== id; });
  const heading = document.querySelector(`#${id} h1`);
  heading.tabIndex = -1;
  heading.focus();
}

byId('findForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('findSubmit'), byId('findError'), async () => {
    const token = await check.token();
    let data;
    try {
      data = await post('/api/auth/recover', { action: 'start', slug: normaliseSlugInput(byId('slug').value), 'cf-turnstile-response': token });
    } finally {
      check.reset();
    }
    if (!data.telegram) return show('stepNoTelegram');
    challenge = data.challenge;
    show('stepReset');
  });
});

byId('telegramSend').addEventListener('click', () => {
  withBusy(byId('telegramSend'), byId('resetError'), async () => {
    await post('/api/auth/recover', { action: 'send', challenge });
    toast(translate('telegram.sent'));
    byId('telegramCode').focus();
  });
});

function pickFactor(name) {
  factor = name;
  document.querySelectorAll('#stepReset [data-factor]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.factor === name));
  });
  const input = byId('factorCode');
  input.value = '';
  input.inputMode = name === 'totp' ? 'numeric' : 'text';
  input.maxLength = name === 'totp' ? 6 : 16;
  byId('factorLabel').textContent = translate(name === 'totp' ? 'field.code' : 'field.backup-code');
  byId('factorField').hidden = name === 'passkey';
  byId('passkeyHint').hidden = name !== 'passkey';
}

// The passkey prompt comes up between the two calls. passkey-options checks
// the Telegram code first, so a wrong one is reported before the prompt.
async function passkeyResponse(telegramCode) {
  const { options } = await post('/api/auth/recover', { action: 'passkey-options', challenge, telegramCode });
  try {
    return await usePasskey(options);
  } catch (cause) {
    throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
  }
}
document.querySelectorAll('#stepReset [data-factor]').forEach((b) => b.addEventListener('click', () => pickFactor(b.dataset.factor)));
onChange(() => pickFactor(factor));

byId('resetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = byId('resetError');
  const newPassword = byId('newPassword').value;
  if ([...newPassword].length < 10) {
    error.textContent = translate('error.password_too_short');
    return;
  }
  if (newPassword !== byId('newPasswordConfirm').value) {
    error.textContent = translate('error.password_mismatch');
    return;
  }
  withBusy(byId('resetSubmit'), error, async () => {
    try {
      const telegramCode = byId('telegramCode').value;
      const proof = factor === 'passkey' ? { response: await passkeyResponse(telegramCode) } : { code: byId('factorCode').value };
      await post('/api/auth/recover', { action: 'finish', challenge, telegramCode, factor, ...proof, newPassword });
      window.location.replace('/edit');
    } catch (err) {
      if (err.code === 'challenge_expired') {
        show('stepFind');
        byId('findError').textContent = translate('error.challenge_expired');
      }
      throw err;
    }
  });
});
