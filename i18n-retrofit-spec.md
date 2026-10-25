# i18n retrofit spec

A specification for adding a language switcher and translation files to an
existing static site. It defines the files, the runtime contract, the switcher
button, the switcher modal, and the procedure for adding a language when one is
requested.

## 1. Decisions

| Topic | Decision |
| --- | --- |
| Stack | Static HTML, CSS, and JavaScript with no build step. ES modules loaded with `<script type="module">`. A service worker precaches the shell for offline use. Hosted on static hosting with clean URLs (Vercel or equivalent). Serverless functions, where present, are not involved. |
| Wiring | `data-i18n` attributes on static markup, `t()` calls for strings built in code. |
| Key shape | Flat, dotted keys: `"nav.home": "Home"`. No nesting. |
| Loading | Every locale file is a static JSON import (`import en from './en.json' with { type: 'json' }`) in one registry module. All locales are in memory before first render; switching language is instant and makes no network request. |
| Detection | First visit: match the browser's language list against the available locales, fall back to `en`. After that, the stored choice wins. |
| Persistence | `localStorage`, key `locale`. |
| Modal rows | The language's own name only (`Deutsch`, `Français`, `日本語`). No flags. |
| Extras | Interpolation, plurals, RTL, missing-key reporting. |
| Source of truth | `en.json`. Every other file must contain exactly the same keys. |

## 2. Directory layout

```
assets/i18n/
  en.json            source of truth; every key the site uses
  <code>.json        one file per additional language, same keys as en.json
  locales.js         registry module: imports every JSON file, exports the
                     locale map and the list of codes, native names, directions
  i18n.js            runtime: init, t, setLocale, DOM binding
  switcher.js        the button and the modal (§7, §8)
  check-keys.js      Node script, run from the command line: reports key
                     mismatches between files
```

`assets/` is whatever directory the site already serves its CSS and JS from;
the `i18n/` folder sits beside `css/` and `js/`. File names are the BCP 47
language tag in lowercase: `fr.json`, `pt-br.json`, `zh-hant.json`. Use the
shortest tag that is unambiguous for the audience.

Everything under `assets/i18n/` except `check-keys.js` is served to the browser
and belongs in the service worker's precache list (§10).

## 3. Locale file format

### 3.1 Shape

A single flat JSON object. Keys are dotted paths, values are strings. No
arrays, no nested objects, no non-string values.

```json
{
  "nav.home": "Home",
  "nav.about": "About",
  "form.email.label": "Email address",
  "form.email.placeholder": "you@example.com",
  "greeting.named": "Hello, {name}",
  "cart.items.one": "{count} item",
  "cart.items.other": "{count} items"
}
```

### 3.2 Key naming

- Lowercase, segments separated by `.`, words within a segment separated by `-`.
- First segment is the area of the site: a page, a component, or a cross-cutting
  group (`common`, `error`, `a11y`).
- Last segment names the role of the string, not its content:
  `submit`, `title`, `label`, `placeholder`, `hint`, `empty-state`.
  A key named after its English content (`button.click-here`) breaks the moment
  the copy changes.
- Reuse a key only when the two places must always say the same thing. Two
  buttons that happen to both say "Save" in English may not both say the same
  word in another language; give them separate keys if they sit in different
  contexts.
- Keys are never translated and never renamed inside a non-English file.

### 3.3 Interpolation

Placeholders are `{name}` with a bare identifier. The runtime replaces each
placeholder with the matching property of the params object passed to `t()`.
A placeholder with no matching param is left as-is and warned about in dev
mode.

Rules for translators:

- Placeholders keep their exact English name. `{name}` stays `{name}`.
- Placeholders can move within the sentence; they cannot be dropped or added.
- Everything outside the braces is translatable.

### 3.4 Plurals

A pluralised string is a family of keys sharing a base, suffixed with the
CLDR category: `.zero`, `.one`, `.two`, `.few`, `.many`, `.other`. `.other`
is mandatory; the rest are optional per language.

Lookup: `t('cart.items', { count: 3 })` runs
`new Intl.PluralRules(locale).select(3)`, tries `cart.items.<category>`, then
`cart.items.other`. The `count` param is also available for interpolation.

`en.json` needs `.one` and `.other`. A language file may need more or fewer;
the translator adds the categories that language uses and always includes
`.other`. The key check (§11) treats plural families as one unit: a language
file must have the same *bases* as `en.json`, not the same suffixes.

### 3.5 Text direction

Direction lives in the registry, not in the strings. Strings never contain
directional control characters.

## 4. Runtime API

One ES module, `i18n.js`, with named exports.

```
init({ locales, registry, defaultLocale = 'en', storageKey = 'locale', debug })
  Takes the locale map and registry from locales.js, resolves the starting
  locale (§5), applies it to the document (§6). Returns the resolved locale
  code. debug defaults to true on localhost and false elsewhere; it gates the
  console warnings in §11.

t(key, params?)
  Returns the translated string for the active locale. Falls back to the
  default locale, then to the key itself. Handles interpolation and plurals.

setLocale(code)
  Switches the active locale, persists it, re-applies the document, fires
  change listeners. No-op if the code is not in the registry.

getLocale()
  Active locale code.

getLocales()
  The registry array, for the modal to render.

onChange(listener) → unsubscribe
  Called with the new code after every successful setLocale. Code that builds
  strings with t() uses this to re-render.

applyTo(root = document)
  Walks root for data-i18n bindings (§6) and updates them. Called by init and
  setLocale on the whole document; call it yourself on nodes you insert later.
```

The registry entry shape:

```js
{ code: 'ar', name: 'العربية', dir: 'rtl' }
```

`name` is the language's own name for itself. `dir` is `'ltr'` or `'rtl'`.

## 5. Detection and persistence

Resolution order on `init`:

1. `localStorage[storageKey]`, if it names a locale in the registry.
2. Each entry of `navigator.languages` in order. For each: exact match
   (`pt-br`), then base language match (`pt-br` → `pt`), against registry codes
   compared case-insensitively.
3. `defaultLocale`.

`setLocale` writes the code to `localStorage`. Every storage read and write
sits inside `try/catch`; a private window or blocked storage must not break
the site, it just means the choice is not remembered.

Automatic detection runs only when nothing is stored. Once a person has chosen
a language, the browser's setting is ignored until storage is cleared.

## 6. DOM binding

### 6.1 Attributes

| Attribute | Effect |
| --- | --- |
| `data-i18n="key"` | Sets the element's `textContent` to `t(key)`. |
| `data-i18n-attr="attr:key, attr:key"` | Sets one or more attributes. `placeholder:form.email.placeholder, title:form.email.hint`. |
| `data-i18n-params='{"count": 3}'` | JSON object passed as params for both of the above. Optional. |

`textContent` only. There is no HTML-injecting binding; a string that needs
inline markup is split into keys around the markup, or the element is built in
code. This keeps every locale file safe to accept from any translator.

### 6.2 Which attributes are translatable

`placeholder`, `title`, `alt`, `aria-label`, `aria-description`, `value` on
`<input type="submit|button">`, `content` on `<meta name="description">`.
Anything else is a code smell; check it is not a key, id, or URL.

### 6.3 Document-level

On every apply:

- `<html lang>` = active code.
- `<html dir>` = registry `dir` for the active code.
- `<title>` from `data-i18n` on the `<title>` element, same as any node.

### 6.4 Strings built in code

Anything assembled at runtime (toasts, counts, error messages, dynamically
inserted lists) uses `t()` and re-runs on `onChange`. A component that renders
once and never re-renders will show stale text after a switch; the acceptance
test in §12 catches this.

## 7. Language switcher button

A single control that opens the modal.

- Placement: header or top navigation, consistent across pages; on narrow
  screens it may move into the menu but stays reachable in one tap.
- Content: a globe icon plus the active language's native name. On narrow
  screens the icon plus the uppercase code (`EN`, `FR`) is acceptable.
- Markup: `<button type="button">`, never a link. `aria-haspopup="dialog"`,
  `aria-expanded` mirrors modal state, `aria-label` from key
  `a11y.language-switcher` (e.g. "Change language, current: English"). The
  visible name is not translated: it is the native name from the registry.
- Keyboard: focusable in the natural tab order; Enter and Space open the modal.
- The button itself re-renders on `onChange` so the name updates.

## 8. Language switcher modal

### 8.1 Structure

```
<div role="dialog" aria-modal="true" aria-labelledby="lang-title">
  <h2 id="lang-title" data-i18n="language.modal.title">Choose a language</h2>
  <ul role="listbox" aria-labelledby="lang-title">
    <li role="option" aria-selected="true"  data-locale="en">English</li>
    <li role="option" aria-selected="false" data-locale="fr">Français</li>
    ...
  </ul>
  <button type="button" data-i18n="common.close">Close</button>
</div>
```

Rows come from `getLocales()` in registry order. Each row shows the native
name only, left-aligned in LTR locales and right-aligned in RTL, and its own
`lang` attribute set to its code so screen readers pronounce it correctly.

### 8.2 Behaviour

- Opens centred (or bottom-sheet on narrow screens) over a backdrop that blocks
  the page.
- On open: focus moves to the currently selected row. Focus is trapped inside
  the dialog. Background content gets `inert` (or `aria-hidden` where `inert`
  is unavailable). Page scroll is locked.
- Arrow keys move between rows; Home/End jump; Enter or Space selects; typing a
  letter jumps to the next row starting with it.
- Selecting a row calls `setLocale(code)`, closes the modal, and returns focus
  to the switcher button. The page updates in place with no reload.
- Escape, the Close button, and a click on the backdrop close without changing
  anything.
- Selecting the already-active row just closes.
- The title, close label, and any helper text inside the modal are translated
  like everything else and update immediately on switch.

### 8.3 Styling

Inherits the site's existing dialog or card styling. Selected row shows a
visible check or filled state, not colour alone. Hit targets at least 44 px
tall. Respects `prefers-reduced-motion` for the open/close transition.

## 9. RTL

When the registry marks a locale `rtl`:

- `<html dir="rtl">` is set by the runtime (§6.3). Nothing else in code should
  set `dir`.
- Layout must be written with CSS logical properties so it mirrors on its own:
  `margin-inline-start` not `margin-left`, `padding-inline` not
  `padding-left/right`, `inset-inline-end` not `right`, `text-align: start`
  not `left`, `border-inline-start` not `border-left`.
- Audit before shipping the first RTL language: every `left`, `right`,
  `margin-left`, `margin-right`, `padding-left`, `padding-right`,
  `text-align: left|right`, `float`, and `translateX` in the stylesheet.
  Replace with the logical equivalent, or scope the physical rule to
  `[dir="ltr"]` and add an `[dir="rtl"]` counterpart.
- Icons that imply direction (back arrows, chevrons, progress) flip with
  `[dir="rtl"] .icon-directional { transform: scaleX(-1); }`. Icons that do not
  imply direction (search, close, globe) do not flip.
- Numbers, phone numbers, and code stay LTR: wrap them in `<bdi>` or set
  `dir="ltr"` on that element.

## 10. Loading, offline, and hosting

### 10.1 Static JSON imports

`locales.js` imports every locale file with an import attribute and exports
them as one map, alongside the registry:

```js
// assets/i18n/locales.js
import en from './en.json' with { type: 'json' };
import fr from './fr.json' with { type: 'json' };

export const locales = { en, fr };

export const registry = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
];
```

Every page's `<head>` loads the runtime once:

```html
<script type="module" src="/assets/i18n/boot.js"></script>
```

where `boot.js` imports `locales.js` and `i18n.js`, calls `init`, and mounts
the switcher. Module scripts are deferred, so the DOM is parsed when `init`
runs and `applyTo(document)` finds every binding on first pass.

There is no build step, so the map in `locales.js` is the whole bundle. Adding
a language is one import line, one entry in `locales`, one entry in
`registry`.

### 10.2 Browser support and degradation

Import attributes (`with { type: 'json' }`) need a 2024-or-later browser. In an
older browser the module script fails to parse and nothing in it runs. The
page then shows the English text that is kept in the markup (§12 step 4) with
no switcher and no console error beyond the parse failure. That is the
designed degradation; do not add a fallback loader.

The JSON files must be served as `application/json`. Static hosts do this for
`.json` by default; if the host is configured with custom headers, confirm it.
A file served as `text/plain` fails the import with a MIME-type error.

### 10.3 Service worker

Every file under `assets/i18n/` that the browser loads goes in the service
worker's precache list: the runtime, the registry, the switcher, and every
`.json`. They are part of the shell; the switcher must work offline.

Whenever any of those files changes, including a single string in a locale
file, bump the service worker's cache version so installed clients refetch.
A stale cached `en.json` with a new key in the markup shows raw keys on the
page.

### 10.4 Hosting

Clean URLs do not affect `assets/` paths; the import paths in `locales.js` and
`boot.js` keep their extensions. Nothing else on the host needs to change. If
the site's `robots.txt` or sitemap generator lists asset paths, exclude
`assets/i18n/`.

## 11. Missing-key reporting

### 11.1 Runtime (debug mode only)

`t()` logs `console.warn('[i18n] missing key', key, locale)` when it falls
back to the default locale, and again when it falls back to the key itself.
Interpolation with an unmatched placeholder warns the same way. The warnings
are gated by the `debug` option to `init` (§4), which defaults to on for
`localhost` and `127.0.0.1` and off everywhere else.

### 11.2 Static check

`assets/i18n/check-keys.js` is a Node script (`node assets/i18n/check-keys.js`)
run from the command line and in CI. For every `<code>.json` against `en.json`
it reports:

- Keys in `en.json` missing from the locale file.
- Keys in the locale file not present in `en.json` (stale, or a typo).
- Plural families whose `.other` is missing.
- Placeholder mismatches: a value whose set of `{placeholders}` differs from
  the English value's set.
- Values that are empty strings.
- Values identical to the English value, listed as a warning (often untranslated,
  sometimes correct for brand names and proper nouns).

Exit code is non-zero if any of the first four categories has a hit. The
identical-value list is informational.

Optionally, a second mode scans the site's HTML and JS for `t('...')` calls and
`data-i18n="..."` attributes and reports keys used in code that do not exist in
`en.json`, and keys in `en.json` used nowhere.

## 12. Retrofit procedure

Applied once, to a site that currently has hard-coded English.

1. **Add the runtime.** Create `assets/i18n/` with `i18n.js`, `locales.js`
   (importing only `en.json`), an empty `en.json`, `switcher.js`, `boot.js`,
   and `check-keys.js`. Add the `<script type="module">` tag to the shared
   `<head>` of every page. Add every served file to the service worker
   precache and bump its version (§10.3).
2. **Inventory strings.** Walk every HTML page, every shared partial, and every
   script. Every piece of user-visible text, including attribute text (§6.2),
   `<title>`, toasts, validation messages, empty states, and `aria-label`s,
   gets a key. Log strings, internal error codes, and developer comments do
   not. Text that arrives from an API response is out of scope for this
   retrofit; the server owns it.
3. **Extract to `en.json`.** Add each key with its current English value.
   Convert concatenated strings to a single key with placeholders
   (`"Hello, " + name` → `"greeting.named": "Hello, {name}"`). Convert
   count-dependent strings to plural families.
4. **Bind markup.** Replace each static string with `data-i18n` or
   `data-i18n-attr`. Keep the English text in the markup as the initial content
   so the page is readable before the runtime runs and in tools that render
   without JS.
5. **Bind code.** Replace each string in scripts with `t()`. Subscribe with
   `onChange` where the string is rendered once and cached.
6. **Add the switcher.** Button (§7) and modal (§8). Register the keys they use:
   `language.modal.title`, `common.close`, `a11y.language-switcher`.
7. **Run the checks.** `check-keys.js` passes with only `en.json` present. Dev
   console shows no `[i18n]` warnings on any page.
8. **Acceptance.** With a second locale file that has every value prefixed
   with `[xx] ` (a pseudo-locale generated from `en.json`), switch to it and
   walk every page. Any text without the prefix is a missed string. Switch
   back; any text still prefixed is a stale render. Delete the pseudo-locale
   before shipping, or keep it behind a dev flag.

## 13. Adding a language on request

Applied each time a language is requested, after §12 is complete.

1. **Choose the code.** Shortest unambiguous BCP 47 tag, lowercase. Confirm
   with the requester if the request is a region-specific variant
   (`pt` vs `pt-br`, `zh-hans` vs `zh-hant`).
2. **Create `assets/i18n/<code>.json`** by copying `en.json`. Every key
   present, same order. Translate the values only.
3. **Translation rules.**
   - Keys are never changed.
   - Placeholders keep their exact name and are never dropped.
   - Plural families: add the categories the language uses, keep `.other`.
     Check the language's categories against the CLDR plural rules for that
     locale, not against English.
   - Brand names, product names, and proper nouns stay as in English unless the
     brand publishes a localised form.
   - Keep the same register as the English (formal vs informal) unless the
     requester specifies one.
   - Punctuation and quotation marks follow the target language's conventions
     (`« »` in French, `„ “` in German, `。` in Japanese).
   - Avoid idioms and wordplay in the source when the English is being written
     with translation in mind; if one is already there, translate the meaning.
   - Do not translate anything inside `{}`.
   - Length: expect German and Finnish to run 30% longer than English, Chinese
     and Japanese shorter. Flag any string that might overflow a fixed-width
     control in the pull request description.
4. **Register it** in `locales.js`: one import line, one entry in the
   `locales` map, one entry in `registry` with its native name and `dir`.
5. **Precache it.** Add the new `.json` to the service worker precache list
   and bump the cache version (§10.3).
6. **RTL** (if `dir: 'rtl'`): complete the §9 audit if this is the first RTL
   locale.
7. **Run `check-keys.js`.** Zero errors. Review the identical-value list and
   confirm each entry is intentional.
8. **Acceptance.** Switch to the new language in the modal. Walk every page.
   Check the switcher button shows the native name. Check the modal's own
   title and close button are translated. Check `<html lang>` and `dir`.
   Reload and confirm the choice persisted. Clear storage, set the browser's
   preferred language to the new code, reload, and confirm it is auto-selected.
   Go offline and confirm the switch still works.
9. **Deliverable** is exactly: one new `<code>.json`, three lines in
   `locales.js`, one line plus a version bump in the service worker, and any
   CSS fixes from the RTL audit. No changes to `en.json` or the runtime. If a
   translation reveals a missing or awkward English key, that is a separate
   change to `en.json` applied to every locale.

## 14. Acceptance checklist

- [ ] `en.json` contains every user-visible string; dev console is clean of
      `[i18n]` warnings on every page.
- [ ] `check-keys.js` exits 0 for every locale.
- [ ] Switching language updates every visible string with no reload,
      including `<title>`, attributes, and code-built strings.
- [ ] `<html lang>` and `<html dir>` are correct for every locale.
- [ ] Choice survives a reload; first visit picks the browser's language when
      available; storage failure does not break the page.
- [ ] Switcher button: keyboard-operable, correct `aria-*`, shows the active
      native name.
- [ ] Modal: focus trapped, Escape closes, focus returns to the button, arrow
      keys navigate, selected row visibly marked, `lang` set on each row.
- [ ] RTL locale (if any): layout mirrors, directional icons flip, numbers stay
      LTR.
- [ ] Pseudo-locale walk-through finds no missed or stale strings.
- [ ] No locale file contains markup; no binding injects HTML.

## 15. Reference runtime

The §4 contract as a browser ES module. It runs as written; the switcher in
`switcher.js` is left to the implementer, following §7 and §8.

```js
// assets/i18n/i18n.js
let locales = {};
let registry = [];
let active = 'en';
let fallback = 'en';
let storageKey = 'locale';
let debug = false;
const listeners = new Set();

function warn(...args) { if (debug) console.warn('[i18n]', ...args); }

function readStored() {
  try { return localStorage.getItem(storageKey); } catch { return null; }
}
function writeStored(code) {
  try { localStorage.setItem(storageKey, code); } catch { /* not remembered */ }
}

function known(code) {
  return registry.find(l => l.code.toLowerCase() === String(code).toLowerCase());
}

function detect() {
  const stored = readStored();
  if (stored && known(stored)) return known(stored).code;
  for (const tag of navigator.languages || [navigator.language]) {
    const exact = known(tag);
    if (exact) return exact.code;
    const base = known(tag.split('-')[0]);
    if (base) return base.code;
  }
  return fallback;
}

function interpolate(str, params) {
  return str.replace(/\{(\w+)\}/g, (m, name) => {
    if (params && name in params) return String(params[name]);
    warn('unmatched placeholder', name, 'in', str);
    return m;
  });
}

function lookup(key, code) {
  const table = locales[code];
  return table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function t(key, params) {
  let k = key;
  if (params && typeof params.count === 'number') {
    const cat = new Intl.PluralRules(active).select(params.count);
    if (lookup(`${key}.${cat}`, active) !== undefined) k = `${key}.${cat}`;
    else if (lookup(`${key}.other`, active) !== undefined) k = `${key}.other`;
  }
  let str = lookup(k, active);
  if (str === undefined) {
    warn('missing key', k, 'in', active);
    str = lookup(k, fallback);
  }
  if (str === undefined) {
    warn('missing key', k, 'in fallback', fallback);
    return key;
  }
  return interpolate(str, params);
}

export function applyTo(root = document) {
  const params = el => {
    const raw = el.getAttribute('data-i18n-params');
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { warn('bad data-i18n-params on', el); return undefined; }
  };
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'), params(el));
  });
  root.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.getAttribute('data-i18n-attr').split(',').forEach(pair => {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (attr && key) el.setAttribute(attr, t(key, params(el)));
    });
  });
}

function applyDocument() {
  const entry = known(active);
  document.documentElement.lang = active;
  document.documentElement.dir = entry && entry.dir ? entry.dir : 'ltr';
  applyTo(document);
}

export function setLocale(code) {
  const entry = known(code);
  if (!entry || entry.code === active) return;
  active = entry.code;
  writeStored(active);
  applyDocument();
  listeners.forEach(fn => fn(active));
}

export function getLocale() { return active; }
export function getLocales() { return registry.slice(); }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function init(opts) {
  locales = opts.locales;
  registry = opts.registry;
  fallback = opts.defaultLocale || 'en';
  storageKey = opts.storageKey || 'locale';
  debug = opts.debug ?? ['localhost', '127.0.0.1'].includes(location.hostname);
  active = detect();
  applyDocument();
  return active;
}
```

`locales.js` is shown in §10.1. The entry point every page loads:

```js
// assets/i18n/boot.js
import { init } from './i18n.js';
import { locales, registry } from './locales.js';
import { mountSwitcher } from './switcher.js';

init({ locales, registry });
mountSwitcher(document.querySelector('[data-language-switcher]'));
```

`[data-language-switcher]` is an empty element placed in the shared header
markup where the button should appear (§7). `mountSwitcher` renders the button
into it and appends the modal to `document.body`.
