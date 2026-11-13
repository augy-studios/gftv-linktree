// Sign in: password, then one second factor.

import '../app.js';
import '../visitor.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { withBusy, toast } from '../ui.js';
import { normaliseSlugInput } from '../slug-check.js';
import { passkeysSupported, usePasskey, passkeyErrorCode } from '../passkeys.js';
import { humanCheck } from '../turnstile.js';

const byId = (id) => document.getElementById(id);
let challenge = null;
let method = null;
// Turnstile on the password step (turnstile.js).
const check = humanCheck(byId('humanCheck'));

// Somebody already signed in goes straight to their editor.
api('/api/auth/session')
  .then((s) => { if (s.signedIn) window.location.replace('/edit'); })
  .catch(() => {});

const prefill = normaliseSlugInput(new URLSearchParams(window.location.search).get('slug'));
if (prefill) byId('slug').value = prefill;

byId('passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('passwordSubmit'), byId('passwordError'), async () => {
    const token = await check.token();
    let data;
    try {
      data = await post('/api/auth/login', { slug: normaliseSlugInput(byId('slug').value), password: byId('password').value, 'cf-turnstile-response': token });
    } finally {
      check.reset();
    }
    challenge = data.challenge;
    byId('password').value = '';
    showFactors(data.methods);
  });
});

function showFactors(methods) {
  const usable = {
    totp: methods.totp,
    passkey: methods.passkey && passkeysSupported(),
    telegram: methods.telegram,
    backup: true,
  };
  document.querySelectorAll('#methodPicker [data-method]').forEach((b) => { b.hidden = !usable[b.dataset.method]; });
  byId('stepPassword').hidden = true;
  byId('stepFactor').hidden = false;
  // The authenticator app first. Picking Telegram sends nothing by itself:
  // the code goes out only when "Send me a code" is pressed.
  pick(usable.totp ? 'totp' : usable.passkey ? 'passkey' : usable.telegram ? 'telegram' : 'backup');
  const heading = document.querySelector('#stepFactor h1');
  heading.tabIndex = -1;
  heading.focus();
}

const HELP = { totp: 'login.help-totp', passkey: 'login.help-passkey', telegram: 'login.help-telegram', backup: 'login.help-backup' };

function pick(name) {
  method = name;
  document.querySelectorAll('#methodPicker [data-method]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.method === name));
  });
  byId('codeHelp').textContent = translate(HELP[name]);
  const code = byId('code');
  code.value = '';
  byId('codeError').textContent = '';
  const numeric = name === 'totp' || name === 'telegram';
  code.inputMode = numeric ? 'numeric' : 'text';
  code.maxLength = numeric ? 6 : 16;
  code.classList.toggle('code-input', numeric);
  byId('codeLabel').textContent = translate(name === 'backup' ? 'field.backup-code' : name === 'telegram' ? 'field.telegram-code' : 'field.code');
  byId('codeField').hidden = name === 'passkey';
  byId('codeSubmitRow').hidden = name === 'passkey';
  byId('passkeyRow').hidden = name !== 'passkey';
  byId('telegramSendRow').hidden = name !== 'telegram';
}

document.querySelectorAll('#methodPicker [data-method]').forEach((b) => {
  b.addEventListener('click', () => pick(b.dataset.method));
});
onChange(() => { if (method) pick(method); });

function signedIn() {
  window.location.replace('/edit');
}

function handleExpiry(error) {
  if (error.code === 'challenge_expired') {
    byId('stepFactor').hidden = true;
    byId('stepPassword').hidden = false;
    byId('passwordError').textContent = translate('error.challenge_expired');
  }
}

byId('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('codeSubmit'), byId('codeError'), async () => {
    try {
      await post('/api/auth/verify', { challenge, method, code: byId('code').value });
      signedIn();
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
  });
});

byId('telegramSend').addEventListener('click', () => {
  withBusy(byId('telegramSend'), byId('codeError'), async () => {
    await post('/api/auth/verify', { challenge, method: 'telegram-send' });
    toast(translate('telegram.sent'));
    byId('code').focus();
  });
});

byId('passkeyUse').addEventListener('click', () => {
  withBusy(byId('passkeyUse'), byId('codeError'), async () => {
    try {
      const { options } = await post('/api/auth/verify', { challenge, method: 'passkey-options' });
      let response;
      try {
        response = await usePasskey(options);
      } catch (cause) {
        throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
      }
      await post('/api/auth/verify', { challenge, method: 'passkey', response });
      signedIn();
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
  });
});

byId('startOver').addEventListener('click', () => {
  challenge = null;
  byId('stepFactor').hidden = true;
  byId('stepPassword').hidden = false;
  byId('password').focus();
});
