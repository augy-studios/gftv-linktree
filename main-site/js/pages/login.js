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
  .then((session) => {
    if (session.signedIn) {
      window.location.replace('/edit');
    }
  })
  .catch(() => {});

const prefill = normaliseSlugInput(new URLSearchParams(window.location.search).get('slug'));
if (prefill) {
  byId('slug').value = prefill;
}

byId('passwordForm').addEventListener('submit', (event) => {
  event.preventDefault();
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

// After the password: show only the second factors this page has (and this
// browser can use), and open the first of them.
function showFactors(methods) {
  // A passkey counts only when the browser supports them.
  let passkeyUsable = methods.passkey;
  if (passkeyUsable) {
    passkeyUsable = passkeysSupported();
  }
  const usable = {
    totp: methods.totp,
    passkey: passkeyUsable,
    telegram: methods.telegram,
    backup: true,
  };
  document.querySelectorAll('#methodPicker [data-method]').forEach((button) => { button.hidden = !usable[button.dataset.method]; });
  byId('stepPassword').hidden = true;
  byId('stepFactor').hidden = false;
  // The authenticator app first. Picking Telegram sends nothing by itself:
  // the code goes out only when "Send me a code" is pressed.
  let firstMethod;
  if (usable.totp) {
    firstMethod = 'totp';
  } else if (usable.passkey) {
    firstMethod = 'passkey';
  } else if (usable.telegram) {
    firstMethod = 'telegram';
  } else {
    firstMethod = 'backup';
  }
  pick(firstMethod);
  const heading = document.querySelector('#stepFactor h1');
  heading.tabIndex = -1;
  heading.focus();
}

const HELP = { totp: 'login.help-totp', passkey: 'login.help-passkey', telegram: 'login.help-telegram', backup: 'login.help-backup' };

// Switch to one second factor: press its button, and set the help, the code
// field (digits only for the authenticator and Telegram) and which rows show.
function pick(name) {
  method = name;
  document.querySelectorAll('#methodPicker [data-method]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.method === name));
  });
  byId('codeHelp').textContent = translate(HELP[name]);
  const code = byId('code');
  code.value = '';
  byId('codeError').textContent = '';
  let numeric = false;
  if (name === 'totp' || name === 'telegram') {
    numeric = true;
  }
  if (numeric) {
    code.inputMode = 'numeric';
    code.maxLength = 6;
  } else {
    code.inputMode = 'text';
    code.maxLength = 16;
  }
  code.classList.toggle('code-input', numeric);
  let labelKey;
  if (name === 'backup') {
    labelKey = 'field.backup-code';
  } else if (name === 'telegram') {
    labelKey = 'field.telegram-code';
  } else {
    labelKey = 'field.code';
  }
  byId('codeLabel').textContent = translate(labelKey);
  byId('codeField').hidden = name === 'passkey';
  byId('codeSubmitRow').hidden = name === 'passkey';
  byId('passkeyRow').hidden = name !== 'passkey';
  byId('telegramSendRow').hidden = name !== 'telegram';
}

document.querySelectorAll('#methodPicker [data-method]').forEach((button) => {
  button.addEventListener('click', () => pick(button.dataset.method));
});
onChange(() => {
  if (method) {
    pick(method);
  }
});

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

byId('codeForm').addEventListener('submit', (event) => {
  event.preventDefault();
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
