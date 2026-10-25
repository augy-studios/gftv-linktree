# Claude Code prompt: retrofit Proxima Nova

Paste this into Claude Code inside the app's repo, with the `.woff2` file(s)
attached to the same message (or already copied somewhere Claude Code can
read them, e.g. the repo root or your Downloads folder, tell it where). This
is a retrofit, not a rebuild: touch only the font declaration and the
`--font` token's usages, leave every other token and every colour block
alone.

---

Read `gftv-theme.md` at the repo root, specifically the "Font is Proxima
Nova everywhere" rule and the `@font-face` block in section 1. That is the
source of truth for this task.

Goal: replace whatever font this app currently loads with self-hosted
Proxima Nova, on top of the existing theme system. Do not change any colour
token, any `--brand*` value, spacing, radii, or layout. This is a font swap
only.

Do this in order:

1. **Find the current font setup.** Search the repo for how the font is
   loaded today: a Google Fonts `<link>` or `@import` (commonly Inter, the
   font GFTV apps used before Proxima Nova), a `--font` custom property, and
   every place `font-family` is set outside that one token (per-component
   overrides are a rule violation and should be fixed as part of this task,
   not left in place).

2. **Add the font files.** Create `assets/fonts/` at the repo root if it
   doesn't exist. Copy in only the `.woff2` file(s) attached to this task.
   Name each file `ProximaNova-<Weight>.woff2` matching what it actually is
   (`Regular`, `Medium`, `Semibold`, `Bold`); ask me if a filename's weight
   isn't obvious rather than guessing.

3. **Declare `@font-face`.** In the theme CSS file (`css/theme.css`, or the
   top of `style.css`, wherever this repo keeps the `:root` token block),
   add one `@font-face` block per weight file actually present, matching the
   pattern in `gftv-theme.md` section 1:

   ```css
   @font-face {
     font-family: 'Proxima Nova';
     src: url('/assets/fonts/ProximaNova-Regular.woff2') format('woff2');
     font-weight: 400;
     font-style: normal;
     font-display: swap;
   }
   ```

   Only declare weights whose file you actually copied in step 2. Do not
   declare a weight that would 404, the fallback stack exists precisely so
   an app with only the regular weight still renders correctly and lets the
   browser synthesise the rest.

4. **Set the `--font` token.** In the structural `:root` block (no colour,
   no axis), set or update:

   ```css
   --font: 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI',
     Roboto, Helvetica, Arial, sans-serif;
   ```

   If `--font` doesn't exist yet in this app's token list, add it there
   alongside `--glass-blur`, `--radius`, `--radius-sm`, not inside a
   colour/mode block.

5. **Apply it globally, once.** Confirm `font-family: var(--font);` is set
   on the universal selector (`*` or `html, body`) and remove every
   component-level `font-family` override you found in step 1, so nothing
   can drift from the token.

6. **Remove the old font load.** Delete the Google Fonts `<link>` or
   `@import` for the previous font (Inter, most likely) from every HTML
   file's `<head>`. A licensed font cannot be imported from a third-party
   host, and leaving the old `<link>` in place would fetch a font nothing
   uses. Check every page, not just the root, if the app has more than one
   HTML entry point.

7. **Verify.** Confirm:
   - `assets/fonts/*.woff2` are the only new binary files added
   - No `@import` or `<link>` to any third-party font host remains anywhere
     in the repo
   - Every `@font-face` block's weight matches a file that actually exists
     in `assets/fonts/`
   - No component CSS sets `font-family` outside `--font`
   - Text still renders (falls back to the system sans-serif) on a clean
     checkout before the `.woff2` files are pulled, so a contributor without
     the licensed files doesn't see a broken page
   - Visually, headings and body text now render in Proxima Nova, not the
     previous font or a fallback

Work through the repo file by file (fonts and CSS first, then each HTML
page's `<head>`) and show a summary of what changed before moving to the
next, rather than editing everything silently and reporting at the end.