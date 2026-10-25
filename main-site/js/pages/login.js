// Sign in: password, then one second factor.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { withBusy, toast } from '../ui.js';
import { normaliseSlugInput } from '../slug-check.js';
import { passkeysSupported, usePasskey, passkeyErrorCode } from '../passkeys.js';

const $ = (id) => document.getElementById(id);
let challenge = null;
let method = null;

// Somebody already signed in goes straight to their editor.
api('/api/auth/session')
  .then((s) => { if (s.signedIn) window.location.replace('/edit'); })
  .catch(() => {});

const prefill = normaliseSlugInput(new URLSearchParams(window.location.search).get('slug'));
if (prefill) $('slug').value = prefill;

$('passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('passwordSubmit'), $('passwordError'), async () => {
    const data = await post('/api/auth/login', { slug: normaliseSlugInput($('slug').value), password: $('password').value });
    challenge = data.challenge;
    $('password').value = '';
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
  $('stepPassword').hidden = true;
  $('stepFactor').hidden = false;
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
  $('codeHelp').textContent = t(HELP[name]);
  const code = $('code');
  code.value = '';
  $('codeError').textContent = '';
  const numeric = name === 'totp' || name === 'telegram';
  code.inputMode = numeric ? 'numeric' : 'text';
  code.maxLength = numeric ? 6 : 16;
  code.classList.toggle('code-input', numeric);
  $('codeLabel').textContent = t(name === 'backup' ? 'field.backup-code' : name === 'telegram' ? 'field.telegram-code' : 'field.code');
  $('codeField').hidden = name === 'passkey';
  $('codeSubmitRow').hidden = name === 'passkey';
  $('passkeyRow').hidden = name !== 'passkey';
  $('telegramSendRow').hidden = name !== 'telegram';
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
    $('stepFactor').hidden = true;
    $('stepPassword').hidden = false;
    $('passwordError').textContent = t('error.challenge_expired');
  }
}

$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('codeSubmit'), $('codeError'), async () => {
    try {
      await post('/api/auth/verify', { challenge, method, code: $('code').value });
      signedIn();
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
  });
});

$('telegramSend').addEventListener('click', () => {
  withBusy($('telegramSend'), $('codeError'), async () => {
    await post('/api/auth/verify', { challenge, method: 'telegram-send' });
    toast(t('telegram.sent'));
    $('code').focus();
  });
});

$('passkeyUse').addEventListener('click', () => {
  withBusy($('passkeyUse'), $('codeError'), async () => {
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

$('startOver').addEventListener('click', () => {
  challenge = null;
  $('stepFactor').hidden = true;
  $('stepPassword').hidden = false;
  $('password').focus();
});
