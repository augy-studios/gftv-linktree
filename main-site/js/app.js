// Shared page wiring for every page: i18n, theme, icons, images, dialogs, the update
// bar, the sticky header and the footer year. Each page's own module imports
// this first.

import '../assets/i18n/boot.js';
import { t as translate, onChange } from '../assets/i18n/i18n.js';
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

function hour(hourOfDay) {
  return `${String(hourOfDay).padStart(2, '0')}:00`;
}

function syncThemeButton() {
  const themeButton = document.getElementById('themeBtn');
  if (!themeButton) {
    return;
  }
  const mode = getStoredMode();
  if (mode === 'dark') {
    themeButton.innerHTML = icon('moon');
  } else {
    themeButton.innerHTML = icon('sun');
  }
  themeButton.setAttribute('aria-label', translate('theme.button', { mode: translate(`theme.mode.${mode}`) }));
}

// Bring the theme dialog in line with what is stored: the pressed mode button,
// the time-based note, the pressed swatch, and the header button.
function syncThemeModal() {
  const preference = getModePreference();
  const resolved = getStoredMode();
  const colorTheme = getStoredColorTheme();

  document.querySelectorAll('#modeToggle .mode-btn').forEach((modeButton) => {
    const active = modeButton.dataset.mode === preference;
    modeButton.classList.toggle('active', active);
    modeButton.setAttribute('aria-pressed', String(active));
  });

  const note = document.getElementById('modeNote');
  if (note) {
    if (preference === 'time') {
      note.textContent = translate('theme.time-note', {
        from: hour(LIGHT_FROM_HOUR),
        until: hour(LIGHT_UNTIL_HOUR),
        mode: translate(`theme.mode.${resolved}`),
      });
      note.hidden = false;
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }

  document.querySelectorAll('#swatchGrid .swatch').forEach((swatch) => {
    const active = swatch.dataset.theme === colorTheme;
    swatch.classList.toggle('active', active);
    swatch.setAttribute('aria-pressed', String(active));
  });

  syncThemeButton();
}

// Built with the DOM and style.setProperty rather than an inline style
// attribute, which the Content-Security-Policy would refuse.
function buildSwatches() {
  const grid = document.getElementById('swatchGrid');
  if (!grid) {
    return;
  }
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
    label.textContent = translate(`theme.swatch.${theme.id}`);
    button.append(dot, label);
    grid.appendChild(button);
  }
}

// The header's theme button opens the theme dialog; the dialog's mode buttons
// and swatches apply at once.
function wireTheme() {
  buildSwatches();

  const themeButton = document.getElementById('themeBtn');
  if (themeButton) {
    themeButton.addEventListener('click', () => { syncThemeModal(); openModal('themeModal'); });
  }

  // Picking a mode or a swatch updates the modal in place and leaves it open.
  const modeToggle = document.getElementById('modeToggle');
  if (modeToggle) {
    modeToggle.addEventListener('click', (event) => {
      const modeButton = event.target.closest('.mode-btn');
      if (!modeButton) {
        return;
      }
      applyMode(modeButton.dataset.mode);
      syncThemeModal();
    });
  }

  const swatchGrid = document.getElementById('swatchGrid');
  if (swatchGrid) {
    swatchGrid.addEventListener('click', (event) => {
      const swatch = event.target.closest('.swatch');
      if (!swatch) {
        return;
      }
      applyColorTheme(swatch.dataset.theme);
      syncThemeModal();
    });
  }

  // A tab left open across 09:00 or 18:00 redraws rather than showing the
  // answer from before dinner.
  document.addEventListener('gftv:modechange', syncThemeModal);
  onChange(syncThemeModal);
  syncThemeModal();
}

// The header gets .stuck once it reaches the top of the window and the page
// has scrolled, at most once a frame.
function wireStickyHeader() {
  const header = document.querySelector('.site-header');
  if (!header) {
    return;
  }
  let ticking = false;
  const update = () => {
    ticking = false;
    let stuck = false;
    if (header.getBoundingClientRect().top <= 0 && window.scrollY > 0) {
      stuck = true;
    }
    header.classList.toggle('stuck', stuck);
  };
  window.addEventListener('scroll', () => {
    if (ticking) {
      return;
    }
    ticking = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
}

function wireFooterYear() {
  const yearElement = document.getElementById('currentYear');
  if (yearElement) {
    yearElement.textContent = String(new Date().getFullYear());
  }
}

// A hidden way in for staff: triple-clicking "Global Furry Television" in the
// footer opens /admin. event.detail is the browser's own click count.
function wireFooterAdminLink() {
  const byline = document.querySelector('.site-footer [data-i18n="footer.by"]');
  if (!byline) {
    return;
  }
  byline.addEventListener('click', (event) => {
    if (event.detail === 3 && location.pathname !== '/admin') {
      location.assign('/admin');
    }
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
