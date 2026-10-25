# Claude Code prompt: retrofit time-based mode (GFTV)

Paste this into Claude Code inside the app's repo. The repo already has the
GFTV theme system (`data-color-theme` + `data-mode`, `.glass-card`, Proxima
Nova) with a two-button light/dark toggle. This is a retrofit, not a
rebuild: touch only the theme system files, leave every other file in the
repo alone, and change nothing about colour tokens, brand values, or
Proxima Nova.

---

Read `gftv-theme.md` at the repo root and apply it. It is the source of
truth for every file this task touches, specifically the "Time based mode"
section and every code block under it. Use the repo root `index.html`'s
`<head>` tag as the template for every other HTML file in the repo, so any
`<meta>` or script ordering you add stays consistent across pages.

Goal: add the time-based mode option described in `gftv-theme.md` to this
app, on top of the light/dark toggle that already exists. Do not change the
colour theme system, the swatch grid, `THEME_COLOR`, `migrateLegacy`, or any
token value. Do not touch app logic outside the theme system.

Do this in order:

1. **Find the theme files.** Locate `js/theme.js`, the theme CSS (either
   `css/theme.css` or the top of `style.css`), `js/icons.js`, `js/ui.js`,
   the file that wires theme buttons (`app.js` or the per-page script if
   there's no shared `app.js`), and every HTML file with a theme modal and
   a pre-paint script in `<head>`.

2. **`js/theme.js`.** Diff the current file against the `js/theme.js` block
   in `gftv-theme.md` section 2. Keep `APP_KEY`, `COLOR_THEMES`,
   `THEME_COLOR`, `migrateLegacy`, `getStoredColorTheme`, `applyColorTheme`,
   and `syncMeta` exactly as they already are in this repo. Add:
   - `MODE_PREFERENCES`, `LIGHT_FROM_HOUR`, `LIGHT_UNTIL_HOUR`
   - `getModePreference()`, `isDaylightHours()`, `resolveMode()`
   - Change `getStoredMode()` to resolve through `resolveMode(getModePreference())`
     instead of reading localStorage directly
   - Change `applyMode()` to take a preference (`light`/`dark`/`time`),
     resolve it, write both `data-mode` and `data-mode-preference` to the
     document, store the preference (not the resolved value) under
     `KEY_MODE`, call `syncMeta()` same as it already does, and also call
     the new `scheduleModeCheck()`
   - Add `scheduleModeCheck()`, `msUntilNextBoundary()`, and
     `refreshTimeMode()` exactly as specified, including the
     `visibilitychange` listener and the `gftv:modechange` custom event
   - Update `initTheme()` to call `applyMode(getModePreference())`, not
     `applyMode(getStoredMode())`, after `migrateLegacy()` and
     `applyColorTheme()` run as they already do

3. **Theme CSS.** Add `.mode-btn-wide` and `.mode-note` from
   `gftv-theme.md` section 1. If `.mode-toggle` in this app isn't already a
   grid (some earlier GFTV apps may still have it as flex from before the
   third button existed), change it to a two-column grid so the third
   button can span the full row underneath. Leave every other rule,
   especially anything under `.glass-card` or the colour theme blocks,
   untouched.

4. **`js/icons.js`.** Add the `clock` icon if it isn't already there.

5. **Every HTML file with a theme modal.** Add the third mode button
   (`data-mode="time"`, class `mode-btn mode-btn-wide`) and the
   `<p class="mode-note" id="modeNote" hidden></p>` element, in the same
   place `gftv-theme.md` section 3 shows them, inside the existing
   `.modal.glass-card`. If the modal markup is duplicated across multiple
   pages rather than shared, update every copy, using the root page as the
   template for the others.

6. **Pre-paint script.** Every GFTV app's `<head>` already carries the
   pre-paint script that sets `data-mode` and `data-color-theme` before
   first paint. Update it in every `<head>` that has one to resolve `time`
   and set `data-mode-preference`, matching the script in `gftv-theme.md`
   section 3. Keep the localStorage key (`gftv-appname.mode`, matching this
   app's `APP_KEY`) exactly as it already is; do not change it.

7. **Wiring file (`app.js` or equivalent).** Update the theme modal wiring
   to import `getModePreference`, compute the active preference and
   resolved mode when syncing the modal, set `aria-pressed` on the mode
   buttons, show/hide and fill in `#modeNote`, and listen for
   `gftv:modechange` to re-sync the modal when a tab crosses a boundary
   while open.

8. **Verify against `gftv-theme.md`'s own checklist**, specifically the
   "Time based mode, where the app ships it" section at the end of the
   file. In particular confirm:
   - The app still defaults to `classic` + light for a fresh profile,
     clock preference untouched
   - Picking "Time-based" and reloading keeps that button pressed, not
     "Dark", even in the evening
   - `data-mode` in the DOM is never anything but `light` or `dark`
   - `meta[name="theme-color"]` still tracks the resolved combination via
     `THEME_COLOR`, not the preference
   - The old single-key migration (`gftv-theme` to `KEY_COLOR`/`KEY_MODE`)
     still runs correctly for a profile that has never opened this app
     since the update
   - Existing swatch and light/dark behaviour is unchanged for anyone who
     hasn't picked "Time-based"

Work through one file type at a time (theme.js, then CSS, then icons, then
HTML, then wiring) and show a summary of what changed in each before moving
to the next, rather than editing everything silently and reporting at the
end.