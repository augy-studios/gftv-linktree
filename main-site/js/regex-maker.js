// The pattern helper on the admin block lists: describe what to catch in
// plain words and it writes the regular expression, with a box to try it on
// sample text. For staff who do not write regular expressions; anyone who
// does can type one straight into the list's own field.
//
// What it writes stays inside what the server accepts (validate.js
// checkPattern): no repeated group that itself repeats, so it is never slow.

import { t, onChange } from '../assets/i18n/i18n.js';
import { openModal, closeModal } from './ui.js';

const $ = (id) => document.getElementById(id);

// Characters people swap in to dodge a filter: g0vt, ad.min, gf7v.
const LOOK_ALIKES = {
  a: 'a4@', b: 'b8', e: 'e3', g: 'g9', i: 'i1l!', l: 'l1i', o: 'o0', s: 's5$', t: 't7', z: 'z2',
};

const escapeChar = (c) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

function termPattern(term, { lookalike, spaced }) {
  const parts = [...term.toLowerCase()].map((c) => {
    if (lookalike && LOOK_ALIKES[c]) return `[${[...LOOK_ALIKES[c]].map(escapeChar).join('')}]`;
    return escapeChar(c);
  });
  return parts.join(spaced ? '[._-]?' : '');
}

// mode: contains | starts | ends | exact. terms: comma separated.
export function buildPattern({ mode, terms, lookalike, spaced }) {
  const list = String(terms || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return '';
  const body = list.map((term) => termPattern(term, { lookalike, spaced })).join('|');
  const group = list.length > 1 ? `(?:${body})` : body;
  return `${mode === 'starts' || mode === 'exact' ? '^' : ''}${group}${mode === 'ends' || mode === 'exact' ? '$' : ''}`;
}

let onUse = null;
let wired = false;

function update() {
  const pattern = buildPattern({
    mode: $('regexMode').value,
    terms: $('regexTerms').value,
    lookalike: $('regexLookalike').checked,
    spaced: $('regexSpaced').checked,
  });
  $('regexOut').textContent = pattern || t('regex.empty');
  const sample = $('regexTry').value;
  const result = $('regexTryResult');
  result.classList.remove('ok', 'bad');
  if (!pattern || !sample) {
    result.textContent = '';
    return pattern;
  }
  const hit = new RegExp(pattern, 'i').test(sample);
  result.textContent = t(hit ? 'regex.matches' : 'regex.no-match');
  result.classList.add(hit ? 'bad' : 'ok');
  return pattern;
}

function wire() {
  for (const id of ['regexMode', 'regexTerms', 'regexLookalike', 'regexSpaced', 'regexTry']) {
    $(id).addEventListener('input', update);
    $(id).addEventListener('change', update);
  }
  $('regexForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pattern = update();
    if (!pattern) {
      $('regexError').textContent = t('regex.need-terms');
      $('regexTerms').focus();
      return;
    }
    closeModal('regexModal');
    onUse?.(pattern);
  });
  onChange(() => { if (!$('regexModal').classList.contains('hidden')) update(); });
}

// scope: "links" or "names", for the hint about what is matched.
export function openRegexMaker(scope, use) {
  if (!wired) {
    wire();
    wired = true;
  }
  onUse = use;
  $('regexError').textContent = '';
  $('regexScopeHint').textContent = t(scope === 'links' ? 'regex.hint-links' : 'regex.hint-names');
  update();
  openModal('regexModal', { initialFocus: $('regexTerms') });
}
