// Cloudflare Turnstile, the "are you a person" check on sign-up, sign-in,
// password reset and the report form. Each form has a <div class="human-check
// cf-turnstile" data-action="..."> for the widget.
//
// The widget is drawn with turnstile.render() rather than left for api.js to
// find, so Cloudflare's script loads only when one of those forms is shown
// (never just for reading a public page), and only when the server says the
// check is on (api/public/turnstile.js gives the site key, or null when no
// TURNSTILE_SECRET is set outside production). The widget follows the page's
// light or dark mode, drawn again when the mode changes.

import { api, ApiError } from './api.js';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let keyPromise = null;
let scriptPromise = null;

// Asked once per page. A failure is not remembered, so the next form asks again.
function siteKey() {
  if (keyPromise === null || keyPromise === undefined) {
    keyPromise = api('/api/public/turnstile').then((data) => {
      if (data.siteKey) {
        return data.siteKey;
      }
      return null;
    }).catch(() => {
      keyPromise = null;
      return null;
    });
  }
  return keyPromise;
}

// Cloudflare's script, added once. A failed load is removed and tried again
// next time.
function loadScript() {
  if (scriptPromise === null || scriptPromise === undefined) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.turnstile) {
          resolve(window.turnstile);
        } else {
          reject(new Error('turnstile'));
        }
      };
      script.onerror = () => {
        scriptPromise = null;
        script.remove();
        reject(new Error('turnstile'));
      };
      document.head.append(script);
    });
  }
  return scriptPromise;
}

const mode = () => {
  if (document.documentElement.getAttribute('data-mode') === 'dark') {
    return 'dark';
  }
  return 'light';
};

// A widget in container, for action ("register", "login", "recover" or
// "report"; by default the container's data-action). Returns
//   token()  the token to send as "cf-turnstile-response": undefined when the
//            check is off (send nothing), or throws human_check_pending while
//            it is not ready;
//   reset()  after every submit, since a token works only once.
export function humanCheck(container, action = container.dataset.action) {
  let widget = null;
  let current = null;
  let drawnIn = null;
  let enabled = false;

  const ready = (async () => {
    const key = await siteKey();
    if (!key) {
      return;
    }
    enabled = true;
    const turnstile = await loadScript();
    // Drawn again in the new mode whenever the page's mode changes.
    const draw = () => {
      if (drawnIn === mode()) {
        return;
      }
      if (widget !== null) {
        turnstile.remove(widget);
      }
      current = null;
      drawnIn = mode();
      widget = turnstile.render(container, {
        sitekey: key,
        action,
        theme: drawnIn,
        size: 'flexible',
        callback: (token) => { current = token; },
        'expired-callback': () => { current = null; },
        'error-callback': () => { current = null; },
      });
    };
    draw();
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  })().catch(() => {});

  return {
    async token() {
      await ready;
      if (!enabled) {
        return undefined;
      }
      if (!current) {
        throw new ApiError('human_check_pending', 0);
      }
      return current;
    },
    reset() {
      current = null;
      if (widget !== null && window.turnstile) {
        window.turnstile.reset(widget);
      }
    },
  };
}
