// Live "is this name free?" under a slug field, for the home and sign-up
// pages and the editor's rename form.
// The server is the authority; this is the same rule shown early.

import { t as translate, onChange } from '../assets/i18n/i18n.js';
import { api } from './api.js';
import { errorText } from './ui.js';

const SHAPE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/;

export function normaliseSlugInput(value) {
  let text = '';
  if (value) {
    text = String(value);
  }
  return text.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Wires an input and a status element. Returns a function that resolves to
// the last known answer: { available, slug, review } or null when unchecked.
// options.current: a function giving the page's own name, which is answered
// with "already your name" (renaming). options.reviewKey: the message for a
// free name on the staff review list, in place of the sign-up one, and
// options.reviewTone its colour ("ok" or "warn").
export function wireSlugCheck(input, status, { current = null, reviewKey = 'slug.available-review', reviewTone = 'ok' } = {}) {
  let timer = null;
  let sequence = 0;
  let last = null;
  let state = { key: '', params: undefined, tone: '' };

  // Draws one message: a translation key and its params, or the text of an
  // error when key is '__error'. Remembered, so a language change redraws it.
  function show(key, params, tone) {
    state = { key, params, tone };
    status.classList.toggle('ok', tone === 'ok');
    status.classList.toggle('bad', tone === 'bad');
    status.classList.toggle('warn', tone === 'warn');
    status.replaceChildren();
    if (!key) {
      return;
    }
    if (tone === 'busy') {
      const spin = document.createElement('span');
      spin.className = 'delayed';
      spin.setAttribute('aria-hidden', 'true');
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spin.appendChild(spinner);
      status.appendChild(spin);
    }
    let text;
    if (key === '__error') {
      text = params;
    } else {
      text = translate(key, params);
    }
    status.append(text);
  }

  // Tidies the field, checks the shape here, then asks the server. Only the
  // newest check may draw: an older answer arriving late is dropped.
  async function check() {
    const slug = normaliseSlugInput(input.value);
    if (input.value !== slug) {
      input.value = slug;
    }
    const mine = ++sequence;
    last = null;
    if (!slug) {
      return show('', undefined, '');
    }
    if (!SHAPE.test(slug)) {
      return show('slug.invalid', undefined, 'bad');
    }
    if (current && slug === current()) {
      return show('error.slug_same', undefined, 'bad');
    }
    show('slug.checking', undefined, 'busy');
    try {
      const data = await api(`/api/slug?slug=${encodeURIComponent(slug)}`);
      if (mine !== sequence) {
        return;
      }
      last = { available: data.available, slug, review: Boolean(data.review) };
      // A free name on the staff review list can be taken, but says so.
      if (data.available) {
        let key;
        let tone;
        if (data.review) {
          key = reviewKey;
          tone = reviewTone;
        } else {
          key = 'slug.available';
          tone = 'ok';
        }
        show(key, { slug }, tone);
      } else {
        let reason = data.reason;
        if (!reason) {
          reason = 'slug_taken';
        }
        show(`error.${reason}`, undefined, 'bad');
      }
    } catch (error) {
      if (mine !== sequence) {
        return;
      }
      show('__error', errorText(error), 'bad');
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(check, 350);
  });
  onChange(() => {
    if (state.key && state.key !== '__error') {
      show(state.key, state.params, state.tone);
    }
  });
  if (input.value) {
    check();
  }
  return () => last;
}
