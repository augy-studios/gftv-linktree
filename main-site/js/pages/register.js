// Sign up: name and password, then the first second factor, then backup codes.

import '../app.js';
import { t } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, errorText } from '../ui.js';
import { wireSlugCheck, normaliseSlugInput } from '../slug-check.js';
import { qrSvg } from '../qr.js';
import { showCodes } from '../codes.js';
import { passkeysSupported, createPasskey, passkeyErrorCode } from '../passkeys.js';

const $ = (id) => document.getElementById(id);

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

// Focus moves to the new step's heading when the step changes, so a screen
// reader hears where it is; not on first load, where it starts at the top.
function step(n, { focus = true } = {}) {
  $('stepAccount').hidden = n !== 1;
  $('stepFactor').hidden = n !== 2;
  $('stepCodes').hidden = n !== 3;
  ['step1', 'step2', 'step3'].forEach((id, i) => $(id).classList.toggle('done', i < n));
  const heading = document.querySelector(`#${['stepAccount', 'stepFactor', 'stepCodes'][n - 1]} h1`);
  if (heading && focus) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

// --- step 1 -----------------------------------------------------------------

const slugInput = $('slug');
const prefill = normaliseSlugInput(new URLSearchParams(window.location.search).get('slug'));
if (prefill) slugInput.value = prefill;
wireSlugCheck(slugInput, $('slugStatus'));

$('accountForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = $('accountError');
  const password = $('password').value;
  if ([...password].length < 10) {
    error.textContent = t('error.password_too_short');
    return;
  }
  if (password !== $('passwordConfirm').value) {
    error.textContent = t('error.password_mismatch');
    return;
  }
  withBusy($('accountSubmit'), error, async () => {
    const data = await post('/api/auth/register', { slug: normaliseSlugInput(slugInput.value), password });
    remember({ slug: data.slug, challenge: data.challenge });
    $('password').value = '';
    $('passwordConfirm').value = '';
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
  $('totpSetup').hidden = name !== 'totp';
  $('passkeySetup').hidden = name !== 'passkey';
  if (name === 'totp') startTotp();
}

document.querySelectorAll('#stepFactor [data-factor]').forEach((b) => {
  b.addEventListener('click', () => pickFactor(b.dataset.factor));
});

async function startTotp() {
  if (totpStarted) return;
  totpStarted = true;
  const qr = $('totpQr');
  try {
    const data = await post('/api/auth/enrol', { challenge: enrol.challenge, action: 'totp-start' });
    qr.innerHTML = qrSvg(data.uri, t('totp.qr-label'));
    qr.removeAttribute('aria-busy');
    $('totpSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
  } catch (error) {
    totpStarted = false;
    qr.removeAttribute('aria-busy');
    qr.replaceChildren();
    $('totpError').textContent = errorText(error);
    if (error.code === 'challenge_expired') expired();
  }
}

function startFactor({ focus = true } = {}) {
  step(2, { focus });
  if (!passkeysSupported()) {
    $('passkeyUnsupported').hidden = false;
    $('passkeyCreate').disabled = true;
  }
  pickFactor(factor);
}

function expired() {
  remember(null);
  $('accountError').textContent = t('error.challenge_expired');
  totpStarted = false;
  step(1);
}

$('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const error = $('totpError');
  withBusy($('totpSubmit'), error, async () => {
    try {
      const data = await post('/api/auth/enrol', { challenge: enrol.challenge, action: 'totp-finish', code: $('totpCode').value });
      finished(data);
    } catch (err) {
      if (err.code === 'challenge_expired') expired();
      throw err;
    }
  });
});

$('passkeyCreate').addEventListener('click', () => {
  const error = $('passkeyError');
  withBusy($('passkeyCreate'), error, async () => {
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
  showCodes($('backupCodes'), data.backupCodes, {
    copyButton: $('codesCopy'),
    downloadButton: $('codesDownload'),
    slug: data.slug,
  });
  step(3);
}

const done = $('codesDone');
$('codesSaved').addEventListener('change', (e) => {
  done.setAttribute('aria-disabled', String(!e.target.checked));
});
done.addEventListener('click', (e) => {
  if (done.getAttribute('aria-disabled') === 'true') {
    e.preventDefault();
    $('codesSaved').focus();
  }
});

// Back in the middle of setup after a reload.
if (enrol && enrol.challenge) {
  slugInput.value = enrol.slug;
  startFactor({ focus: false });
} else {
  step(1, { focus: false });
}
