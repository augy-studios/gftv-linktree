// Sign up: name and password, then the first second factor, then backup codes.

import '../app.js';
import '../visitor.js';
import { t as translate } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, errorText } from '../ui.js';
import { wireSlugCheck, normaliseSlugInput } from '../slug-check.js';
import { qrSvg } from '../qr.js';
import { showCodes } from '../codes.js';
import { passkeysSupported, createPasskey, passkeyErrorCode } from '../passkeys.js';
import { humanCheck } from '../turnstile.js';

const byId = (id) => document.getElementById(id);

// The enrolment challenge survives a reload of this tab, and nothing else.
const STORE = 'gftv-onelink.enrol';
let enrol = null;
try { enrol = JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch { enrol = null; }
function remember(value) {
  enrol = value;
  try {
    if (value) sessionStorage.setItem(STORE, JSON.stringify(value));
    else sessionStorage.removeItem(STORE);
  } catch { /* not remembered */ }
}

// Turnstile, started the first time step 1 shows (turnstile.js).
let check = null;

// Focus moves to the new step's heading when the step changes, so a screen
// reader hears where it is; not on first load, where it starts at the top.
function step(n, { focus = true } = {}) {
  if (n === 1) check ??= humanCheck(byId('humanCheck'));
  byId('stepAccount').hidden = n !== 1;
  byId('stepFactor').hidden = n !== 2;
  byId('stepCodes').hidden = n !== 3;
  ['step1', 'step2', 'step3'].forEach((id, i) => byId(id).classList.toggle('done', i < n));
  const heading = document.querySelector(`#${['stepAccount', 'stepFactor', 'stepCodes'][n - 1]} h1`);
  if (heading && focus) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

// --- step 1 -----------------------------------------------------------------

const slugInput = byId('slug');
const prefill = normaliseSlugInput(new URLSearchParams(window.location.search).get('slug'));
if (prefill) slugInput.value = prefill;
wireSlugCheck(slugInput, byId('slugStatus'));

byId('accountForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = byId('accountError');
  const password = byId('password').value;
  if ([...password].length < 10) {
    error.textContent = translate('error.password_too_short');
    return;
  }
  if (password !== byId('passwordConfirm').value) {
    error.textContent = translate('error.password_mismatch');
    return;
  }
  withBusy(byId('accountSubmit'), error, async () => {
    const token = await check.token();
    let data;
    try {
      data = await post('/api/auth/register', { slug: normaliseSlugInput(slugInput.value), password, 'cf-turnstile-response': token });
    } finally {
      check.reset();
    }
    remember({ slug: data.slug, challenge: data.challenge });
    byId('password').value = '';
    byId('passwordConfirm').value = '';
    startFactor();
  });
});

// --- step 2 -----------------------------------------------------------------

let factor = 'totp';
let totpStarted = false;

function pickFactor(name) {
  factor = name;
  document.querySelectorAll('#stepFactor [data-factor]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.factor === name));
  });
  byId('totpSetup').hidden = name !== 'totp';
  byId('passkeySetup').hidden = name !== 'passkey';
  if (name === 'totp') startTotp();
}

document.querySelectorAll('#stepFactor [data-factor]').forEach((b) => {
  b.addEventListener('click', () => pickFactor(b.dataset.factor));
});

async function startTotp() {
  if (totpStarted) return;
  totpStarted = true;
  const qr = byId('totpQr');
  try {
    const data = await post('/api/auth/enrol', { challenge: enrol.challenge, action: 'totp-start' });
    qr.innerHTML = qrSvg(data.uri, translate('totp.qr-label'));
    qr.removeAttribute('aria-busy');
    byId('totpSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
  } catch (error) {
    totpStarted = false;
    qr.removeAttribute('aria-busy');
    qr.replaceChildren();
    byId('totpError').textContent = errorText(error);
    if (error.code === 'challenge_expired') expired();
  }
}

function startFactor({ focus = true } = {}) {
  step(2, { focus });
  if (!passkeysSupported()) {
    byId('passkeyUnsupported').hidden = false;
    byId('passkeyCreate').disabled = true;
  }
  pickFactor(factor);
}

function expired() {
  remember(null);
  byId('accountError').textContent = translate('error.challenge_expired');
  totpStarted = false;
  step(1);
}

byId('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = byId('totpError');
  withBusy(byId('totpSubmit'), error, async () => {
    try {
      const data = await post('/api/auth/enrol', { challenge: enrol.challenge, action: 'totp-finish', code: byId('totpCode').value });
      finished(data);
    } catch (err) {
      if (err.code === 'challenge_expired') expired();
      throw err;
    }
  });
});

byId('passkeyCreate').addEventListener('click', () => {
  const error = byId('passkeyError');
  withBusy(byId('passkeyCreate'), error, async () => {
    try {
      const { options } = await post('/api/auth/enrol', { challenge: enrol.challenge, action: 'passkey-options' });
      let response;
      try {
        response = await createPasskey(options);
      } catch (cause) {
        throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
      }
      const data = await post('/api/auth/enrol', { challenge: enrol.challenge, action: 'passkey-finish', response });
      finished(data);
    } catch (err) {
      if (err.code === 'challenge_expired') expired();
      throw err;
    }
  });
});

// --- step 3 -----------------------------------------------------------------

function finished(data) {
  remember(null);
  showCodes(byId('backupCodes'), data.backupCodes, {
    copyButton: byId('codesCopy'),
    downloadButton: byId('codesDownload'),
    slug: data.slug,
  });
  step(3);
}

const done = byId('codesDone');
byId('codesSaved').addEventListener('change', (e) => {
  done.setAttribute('aria-disabled', String(!e.target.checked));
});
done.addEventListener('click', (e) => {
  if (done.getAttribute('aria-disabled') === 'true') {
    e.preventDefault();
    byId('codesSaved').focus();
  }
});

// Back in the middle of setup after a reload.
if (enrol && enrol.challenge) {
  slugInput.value = enrol.slug;
  startFactor({ focus: false });
} else {
  step(1, { focus: false });
}
