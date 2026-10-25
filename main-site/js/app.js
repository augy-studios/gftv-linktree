// Shared page wiring for every page: i18n, theme, icons, images, dialogs, the update
// bar, the sticky header and the footer year. Each page's own module imports
// this first.

import '../assets/i18n/boot.js';
import { t, onChange } from '../assets/i18n/i18n.js';
import {
  COLOR_THEMES,
  initTheme,
  applyColorTheme,
  applyMode,
  getStoredColorTheme,
  getStoredMode,
  getModePreference,
  LIGHT_FROM_HOUR,
  LIGHT_UNTIL_HOUR,
} from './theme.js';
import { icon, hydrateIcons } from './icons.js';
import { hydrateImages } from './blob-image.js';
import { openModal, wireModals } from './ui.js';
import { initUpdateBar } from './update-bar.js';
import { initPasswordToggles } from './password-toggle.js';

function hour(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

function syncThemeButton() {
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  const mode = getStoredMode();
  btn.innerHTML = icon(mode === 'dark' ? 'moon' : 'sun');
  btn.setAttribute('aria-label', t('theme.button', { mode: t(`theme.mode.${mode}`) }));
}

function syncThemeModal() {
  const preference = getModePreference();
  const resolved = getStoredMode();
  const colorTheme = getStoredColorTheme();

  document.querySelectorAll('#modeToggle .mode-btn').forEach((b) => {
    const active = b.dataset.mode === preference;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });

  const note = document.getElementById('modeNote');
  if (note) {
    if (preference === 'time') {
      note.textContent = t('theme.time-note', {
        from: hour(LIGHT_FROM_HOUR),
        until: hour(LIGHT_UNTIL_HOUR),
        mode: t(`theme.mode.${resolved}`),
      });
      note.hidden = false;
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }

  document.querySelectorAll('#swatchGrid .swatch').forEach((s) => {
    const active = s.dataset.theme === colorTheme;
    s.classList.toggle('active', active);
    s.setAttribute('aria-pressed', String(active));
  });

  syncThemeButton();
}

// Built with the DOM and style.setProperty rather than an inline style
// attribute, which the Content-Security-Policy would refuse.
function buildSwatches() {
  const grid = document.getElementById('swatchGrid');
  if (!grid) return;
  grid.replaceChildren();
  for (const theme of COLOR_THEMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.theme = theme.id;
    button.setAttribute('aria-pressed', 'false');
    button.style.setProperty('--swatch-color', theme.hex);
    const dot = document.createElement('span');
    dot.className = 'swatch-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.setAttribute('data-i18n', `theme.swatch.${theme.id}`);
    label.textContent = t(`theme.swatch.${theme.id}`);
    button.append(dot, label);
    grid.appendChild(button);
  }
}

function wireTheme() {
  buildSwatches();

  const btn = document.getElementById('themeBtn');
  if (btn) btn.addEventListener('click', () => { syncThemeModal(); openModal('themeModal'); });

  // Picking a mode or a swatch updates the modal in place and leaves it open.
  document.getElementById('modeToggle')?.addEventListener('click', (e) => {
    const b = e.target.closest('.mode-btn');
    if (!b) return;
    applyMode(b.dataset.mode);
    syncThemeModal();
  });

  document.getElementById('swatchGrid')?.addEventListener('click', (e) => {
    const s = e.target.closest('.swatch');
    if (!s) return;
    applyColorTheme(s.dataset.theme);
    syncThemeModal();
  });

  // A tab left open across 09:00 or 18:00 redraws rather than showing the
  // answer from before dinner.
  document.addEventListener('gftv:modechange', syncThemeModal);
  onChange(syncThemeModal);
  syncThemeModal();
}

function wireStickyHeader() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    header.classList.toggle('stuck', header.getBoundingClientRect().top <= 0 && window.scrollY > 0);
  };
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
}

function wireFooterYear() {
  const el = document.getElementById('currentYear');
  if (el) el.textContent = String(new Date().getFullYear());
}

// A hidden way in for staff: triple-clicking "Global Furry Television" in the
// footer opens /admin. event.detail is the browser's own click count.
function wireFooterAdminLink() {
  const el = document.querySelector('.site-footer [data-i18n="footer.by"]');
  if (!el) return;
  el.addEventListener('click', (e) => {
    if (e.detail === 3 && location.pathname !== '/admin') location.assign('/admin');
  });
}

initTheme();
hydrateIcons();
hydrateImages();
wireModals();
wireTheme();
wireStickyHeader();
wireFooterYear();
wireFooterAdminLink();
initPasswordToggles();
initUpdateBar();
