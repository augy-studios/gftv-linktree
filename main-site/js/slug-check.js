// Live "is this name free?" under a slug field, for the home and sign-up pages.
// The server is the authority; this is the same rule shown early.

import { t, onChange } from '../assets/i18n/i18n.js';
import { api } from './api.js';
import { errorText } from './ui.js';

const SHAPE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/;

export function normaliseSlugInput(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Wires an input and a status element. Returns a function that resolves to
// the last known answer: { available, slug } or null when unchecked.
export function wireSlugCheck(input, status) {
  let timer = null;
  let sequence = 0;
  let last = null;
  let state = { key: '', params: undefined, tone: '' };

  function show(key, params, tone) {
    state = { key, params, tone };
    status.classList.toggle('ok', tone === 'ok');
    status.classList.toggle('bad', tone === 'bad');
    status.replaceChildren();
    if (!key) return;
    if (tone === 'busy') {
      const spin = document.createElement('span');
      spin.className = 'delayed';
      spin.setAttribute('aria-hidden', 'true');
      const s = document.createElement('span');
      s.className = 'spinner';
      spin.appendChild(s);
      status.appendChild(spin);
    }
    status.append(key === '__error' ? params : t(key, params));
  }

  async function check() {
    const slug = normaliseSlugInput(input.value);
    if (input.value !== slug) input.value = slug;
    const mine = ++sequence;
    last = null;
    if (!slug) return show('', undefined, '');
    if (!SHAPE.test(slug)) return show('slug.invalid', undefined, 'bad');
    show('slug.checking', undefined, 'busy');
    try {
      const data = await api(`/api/slug?slug=${encodeURIComponent(slug)}`);
      if (mine !== sequence) return;
      last = { available: data.available, slug };
      if (data.available) show('slug.available', { slug }, 'ok');
      else show(`error.${data.reason || 'slug_taken'}`, undefined, 'bad');
    } catch (error) {
      if (mine !== sequence) return;
      show('__error', errorText(error), 'bad');
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(check, 350);
  });
  onChange(() => {
    if (state.key && state.key !== '__error') show(state.key, state.params, state.tone);
  });
  if (input.value) check();
  return () => last;
}
