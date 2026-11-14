// The pattern helper on the admin block lists: describe what to catch in
// plain words and it writes the regular expression, with a box to try it on
// sample text. For staff who do not write regular expressions; anyone who
// does can type one straight into the list's own field.
//
// What it writes stays inside what the server accepts (validate.js
// checkPattern): no repeated group that itself repeats, so it is never slow.

import { t as translate, onChange } from '../assets/i18n/i18n.js';
import { openModal, closeModal } from './ui.js';

const byId = (id) => document.getElementById(id);

// Characters people swap in to dodge a filter: g0vt, ad.min, gf7v.
const LOOK_ALIKES = {
  a: 'a4@', b: 'b8', e: 'e3', g: 'g9', i: 'i1l!', l: 'l1i', o: 'o0', s: 's5$', t: 't7', z: 'z2',
};

const escapeChar = (character) => character.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

function termPattern(term, { lookalike, spaced }) {
  const parts = [...term.toLowerCase()].map((character) => {
    if (lookalike && LOOK_ALIKES[character]) {
      return `[${[...LOOK_ALIKES[character]].map(escapeChar).join('')}]`;
    }
    return escapeChar(character);
  });
  // Spaced: allow a dot, underscore or dash between letters (ad.min).
  let separator;
  if (spaced) {
    separator = '[._-]?';
  } else {
    separator = '';
  }
  return parts.join(separator);
}

// mode: contains | starts | ends | exact. terms: comma separated.
export function buildPattern({ mode, terms, lookalike, spaced }) {
  let text = '';
  if (terms) {
    text = String(terms);
  }
  const list = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (list.length === 0) {
    return '';
  }
  const body = list.map((term) => termPattern(term, { lookalike, spaced })).join('|');
  let group;
  if (list.length > 1) {
    group = `(?:${body})`;
  } else {
    group = body;
  }
  let start;
  if (mode === 'starts' || mode === 'exact') {
    start = '^';
  } else {
    start = '';
  }
  let end;
  if (mode === 'ends' || mode === 'exact') {
    end = '$';
  } else {
    end = '';
  }
  return `${start}${group}${end}`;
}

let onUse = null;
let wired = false;

function update() {
  const pattern = buildPattern({
    mode: byId('regexMode').value,
    terms: byId('regexTerms').value,
    lookalike: byId('regexLookalike').checked,
    spaced: byId('regexSpaced').checked,
  });
  const output = byId('regexOut');
  if (pattern) {
    output.textContent = pattern;
  } else {
    output.textContent = translate('regex.empty');
  }
  const sample = byId('regexTry').value;
  const result = byId('regexTryResult');
  result.classList.remove('ok', 'bad');
  if (!pattern || !sample) {
    result.textContent = '';
    return pattern;
  }
  const hit = new RegExp(pattern, 'i').test(sample);
  // A match is marked "bad": the sample would be blocked.
  if (hit) {
    result.textContent = translate('regex.matches');
    result.classList.add('bad');
  } else {
    result.textContent = translate('regex.no-match');
    result.classList.add('ok');
  }
  return pattern;
}

function wire() {
  for (const id of ['regexMode', 'regexTerms', 'regexLookalike', 'regexSpaced', 'regexTry']) {
    byId(id).addEventListener('input', update);
    byId(id).addEventListener('change', update);
  }
  byId('regexForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const pattern = update();
    if (!pattern) {
      byId('regexError').textContent = translate('regex.need-terms');
      byId('regexTerms').focus();
      return;
    }
    closeModal('regexModal');
    if (onUse !== null && onUse !== undefined) {
      onUse(pattern);
    }
  });
  onChange(() => {
    if (!byId('regexModal').classList.contains('hidden')) {
      update();
    }
  });
}

// scope: "links" or "names", for the hint about what is matched.
export function openRegexMaker(scope, use) {
  if (!wired) {
    wire();
    wired = true;
  }
  onUse = use;
  byId('regexError').textContent = '';
  let hintKey;
  if (scope === 'links') {
    hintKey = 'regex.hint-links';
  } else {
    hintKey = 'regex.hint-names';
  }
  byId('regexScopeHint').textContent = translate(hintKey);
  update();
  openModal('regexModal', { initialFocus: byId('regexTerms') });
}
