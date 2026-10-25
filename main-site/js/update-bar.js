// Service worker registration and the update prompt bar, see
// update-bar-spec.md. A new worker never activates on its own; only the
// Reload button promotes it, and the reload happens on controllerchange.

import { t, onChange } from '../assets/i18n/i18n.js';
import { icon } from './icons.js';
import { escapeHtml } from './ui.js';

const SW_URL = '/sw.js';

let registration = null;
let waitingWorker = null;
let reloading = false;
// For this page view only. Never stored: "Not now" means not now.
let dismissed = false;

function render() {
  const existing = document.querySelector('.update-notice');

  if (!waitingWorker || dismissed) {
    existing?.remove();
    return;
  }

  const bar = existing ?? document.createElement('div');
  bar.className = 'update-notice';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-label', t('update.label'));
  bar.innerHTML = `
    <div class="update-notice-inner">
      <p>${escapeHtml(t('update.ready'))}</p>
      <button type="button" class="btn btn-primary" data-sw-update>
        ${icon('refresh')}${escapeHtml(t('update.reload'))}
      </button>
      <button type="button" class="btn btn-quiet" data-sw-later>
        ${escapeHtml(t('update.later'))}
      </button>
    </div>
  `;

  bar.querySelector('[data-sw-update]').addEventListener('click', () => {
    // The only place anything asks for skipWaiting.
    waitingWorker?.postMessage('skip-waiting');
  });

  bar.querySelector('[data-sw-later]').addEventListener('click', () => {
    dismissed = true;
    render();
  });

  if (!existing) {
    // The official banner is permanent chrome and stays topmost; the notice
    // sits directly beneath it.
    const official = document.getElementById('officialBar');
    if (official) official.insertAdjacentElement('afterend', bar);
    else document.body.prepend(bar);
  }
}

function watchForUpdate() {
  if (!registration) return;

  // A worker already waiting when the page opened: the ordinary case on the
  // second page view after a deploy.
  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = registration.waiting;
    render();
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // installed with a controller is an update; without one it is a first
      // install, which has nothing to prompt about.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting ?? installing;
        render();
      }
    });
  });
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker
    .register(SW_URL)
    .then((reg) => {
      registration = reg;
      watchForUpdate();
    })
    .catch((cause) => {
      // A refused registration is not a reason to break the page.
      console.warn('service worker registration failed:', cause);
    });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

export function initUpdateBar() {
  // The bar is written by script, so it is redrawn on a language change.
  onChange(render);
  // Register on load, so precaching does not compete with the page's own
  // first fetches.
  if (document.readyState === 'complete') registerWorker();
  else window.addEventListener('load', registerWorker, { once: true });
}
