// js/theme.js, copied verbatim from gftv-theme.md section 2 with APP_KEY set.
// Two axes: colour theme and light/dark mode.
// Default is always classic + light, regardless of OS preference.

const APP_KEY = "gftv-onelink";

export const COLOR_THEMES = [
  { id: "classic", label: "Classic", hex: "#ffffff" },
  { id: "hello", label: "Hello", hex: "#fedc00" },
];

// Page background per combination, for meta[name=theme-color].
const THEME_COLOR = {
  "classic:light": "#ffffff",
  "classic:dark": "#0f1317",
  "hello:light": "#fffde0",
  "hello:dark": "#14120a",
};

const KEY_COLOR = `${APP_KEY}.colorTheme`;
const KEY_MODE = `${APP_KEY}.mode`;
const LEGACY_KEY = "gftv-theme";

// Old single key mapped onto the two axes.
const LEGACY_MAP = {
  light: { colorTheme: "classic", mode: "light" },
  hello: { colorTheme: "hello", mode: "light" },
};

function migrateLegacy() {
  if (localStorage.getItem(KEY_COLOR)) return;
  const old = localStorage.getItem(LEGACY_KEY);
  const mapped = LEGACY_MAP[old] || { colorTheme: "classic", mode: "light" };
  localStorage.setItem(KEY_COLOR, mapped.colorTheme);
  localStorage.setItem(KEY_MODE, mapped.mode);
  localStorage.removeItem(LEGACY_KEY);
}

export function getStoredColorTheme() {
  const v = localStorage.getItem(KEY_COLOR);
  return COLOR_THEMES.some((t) => t.id === v) ? v : "classic";
}

/* Mode preference and mode are different things. The preference is what the
   person chose and can be "time"; the mode is what the document is in and is
   only ever light or dark. An app that does not ship the time based option can
   drop MODE_PREFERENCES down to two entries and delete everything under
   "Keeping the time based mode honest" below. */

export const MODE_PREFERENCES = ["light", "dark", "time"];

/* The daylight window. Duplicated in the pre-paint script in every head, which
   has to resolve this before first paint and cannot import anything. Change
   both together. */
export const LIGHT_FROM_HOUR = 9;
export const LIGHT_UNTIL_HOUR = 18;

export function getModePreference() {
  const v = localStorage.getItem(KEY_MODE);
  return MODE_PREFERENCES.includes(v) ? v : "light";
}

export function isDaylightHours(now = new Date()) {
  const hour = now.getHours();
  return hour >= LIGHT_FROM_HOUR && hour < LIGHT_UNTIL_HOUR;
}

export function resolveMode(preference) {
  if (preference === "time") return isDaylightHours() ? "light" : "dark";
  return preference === "dark" ? "dark" : "light";
}

// The mode the document is in right now, resolved. What syncMeta, the theme
// button label, and withLightMode all want.
export function getStoredMode() {
  return resolveMode(getModePreference());
}

function syncMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const key = `${getStoredColorTheme()}:${getStoredMode()}`;
  meta.setAttribute("content", THEME_COLOR[key]);
}

export function applyColorTheme(id) {
  const theme = COLOR_THEMES.find((t) => t.id === id) || COLOR_THEMES[0];
  document.documentElement.setAttribute("data-color-theme", theme.id);
  localStorage.setItem(KEY_COLOR, theme.id);
  syncMeta();
  return theme;
}

export function applyMode(preference) {
  const chosen = MODE_PREFERENCES.includes(preference) ? preference : "light";
  const resolved = resolveMode(chosen);

  document.documentElement.setAttribute("data-mode", resolved);
  document.documentElement.setAttribute("data-mode-preference", chosen);
  localStorage.setItem(KEY_MODE, chosen);

  syncMeta();
  scheduleModeCheck();

  return resolved;
}

/* Keeping the time based mode honest while the page stays open. Delete this
   block in an app that ships the two button toggle. */

let modeTimer = null;
let watchingVisibility = false;

// Milliseconds until the next 09:00 or 18:00, whichever comes first.
function msUntilNextBoundary(now = new Date()) {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);

  const hour = now.getHours();
  if (hour < LIGHT_FROM_HOUR) {
    next.setHours(LIGHT_FROM_HOUR);
  } else if (hour < LIGHT_UNTIL_HOUR) {
    next.setHours(LIGHT_UNTIL_HOUR);
  } else {
    next.setDate(next.getDate() + 1);
    next.setHours(LIGHT_FROM_HOUR);
  }

  // A second of slack, so a timer that fires a fraction early does not land
  // back in the hour it just left and reschedule itself in a tight loop.
  return Math.max(1000, next.getTime() - now.getTime() + 1000);
}

function scheduleModeCheck() {
  if (modeTimer !== null) {
    clearTimeout(modeTimer);
    modeTimer = null;
  }

  if (getModePreference() !== "time") return;

  modeTimer = setTimeout(() => {
    modeTimer = null;
    refreshTimeMode();
  }, msUntilNextBoundary());

  if (!watchingVisibility && typeof document !== "undefined") {
    watchingVisibility = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshTimeMode();
    });
  }
}

export function refreshTimeMode() {
  if (getModePreference() !== "time") return;

  const resolved = resolveMode("time");
  const current = document.documentElement.getAttribute("data-mode");

  if (resolved !== current) {
    document.documentElement.setAttribute("data-mode", resolved);
    syncMeta();
    document.dispatchEvent(
      new CustomEvent("gftv:modechange", {
        detail: { mode: resolved, preference: "time" },
      })
    );
  }

  scheduleModeCheck();
}

export function initTheme() {
  migrateLegacy();
  applyColorTheme(getStoredColorTheme());
  // The preference, not the resolved mode. Passing the resolved one would
  // quietly rewrite a stored "time" into "dark" the first evening.
  applyMode(getModePreference());
}

// PDF export forces a light document, then restores both axes.
export function withLightMode(fn) {
  const mode = getStoredMode();
  const theme = getStoredColorTheme();
  document.documentElement.setAttribute("data-color-theme", "classic");
  document.documentElement.setAttribute("data-mode", "light");
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      document.documentElement.setAttribute("data-color-theme", theme);
      document.documentElement.setAttribute("data-mode", mode);
    });
}
