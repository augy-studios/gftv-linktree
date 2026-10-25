# GFTV theme system reference (portable)

Canonical source: GFTV PolicySpot. This file is the drop-in spec for every
other GFTV PWA (HelloQueue, HelloTrace, HelloShare, GFTV Forms, FURST, the
gftv.asia portal). Copy it into the repo as `gftv-theme.md` or paste it into
the Claude Code prompt and follow it exactly. Update this file when the
canonical implementation changes.

This borrows the *architecture* and the *contrast rules* from the uwuapps
theme system and none of its palette. GFTV keeps its own colours, its own
token names, and Proxima Nova. Do not import Jua, `.glass`, `--ink`, or the seven
pastel swatches.

Two independent axes that combine freely:
**colour theme** (`data-color-theme` on `<html>`) and
**mode** (light/dark, `data-mode` on `<html>`).

Mode has three settings a person can pick from and two values it can resolve
to. `data-mode` is only ever `light` or `dark`; the third setting, `time`,
is a rule for choosing between them. See Time based mode below.

## What changes

Today GFTV apps have a single axis: `data-theme` on `<body>`, with values
that mix colour identity and lightness together (`light`, `hello`).

| Axis | Attribute | Values |
|---|---|---|
| Colour theme | `data-color-theme` | `classic` (default), `hello` |
| Mode | `data-mode` | `light`, `dark` |
| Mode preference | `data-mode-preference` | `light` (default), `dark`, `time` |

`data-color-theme` and `data-mode` are always present, both on `<html>`, not
`<body>`. Every colour block selects on those two and on nothing else.

`data-mode-preference` records which of the three settings the person chose. No
stylesheet reads it. It is there so the theme modal can show the right button
pressed after a reload, and so anything inspecting the page can tell "dark
because you asked" apart from "dark because it is nine in the evening".

For PolicySpot that is 2 colour themes x 2 modes = 4 combinations. Other
GFTV repos may define a different set. Carry forward whatever that repo
already states; do not invent new brand colours anywhere.

## Time based mode

A third setting on the mode axis: follow the device clock. Light from 09:00 up
to but not including 18:00, dark the rest of the day.

Optional per app. An app that does not want it ships the two button toggle and
nothing below applies. An app that does want it must take all of it, because
the parts that look skippable are the ones that break.

**The split that makes it safe.** Two things the original design conflated:

| | What it is | Values |
|---|---|---|
| Preference | what the person chose | `light`, `dark`, `time` |
| Mode | what the document is in | `light`, `dark` |

`getModePreference()` returns the first and decides which button is pressed.
`getStoredMode()` resolves it and is what `meta[name=theme-color]`, the theme
button's label, and `withLightMode` use. Not one line of colour CSS changes.

**The hours are duplicated in the pre-paint script, and have to be.**
`theme.js` is a module and runs after first paint, so resolving only there
shows an evening reader a white page that turns dark a moment later. The
pre-paint script cannot import anything, so the two hours appear in both
places. Change them together, and say so in a comment in both.

**A tab left open across a boundary re-resolves itself.** Somebody who opens
the site at 17:55 and looks up at 18:10 should not still be in light mode.
Schedule one timer to the next 09:00 or 18:00 rather than polling, so an idle
tab costs one wakeup rather than 1,440 a day. Also re-check on
`visibilitychange`: a laptop that sleeps through the boundary fires its timer
late, and coming back to the tab is the moment to notice.

When the resolved mode does change, dispatch `gftv:modechange` on `document`
with `{ mode, preference }`, so the theme modal can redraw rather than showing
the answer from before dinner.

**The device clock is the only input.** No timezone is asked for, sent, or
stored, and there is no sunrise or sunset lookup, which would need a location.
Somebody's evening is their evening wherever they are.

**Accessibility.** This is the one thing in the theme system that changes the
page without the person touching anything. It is opt in, it never moves focus,
and it never animates the transition beyond the ordinary token change. An app
adding it should include it in its accessibility pass rather than assume the
two button toggle's result carries over.

## Non-negotiable rules

- **No gradients, orbs, or blobs.** Flat tints and glass surfaces only.
- **Glassmorphism, not flat cards.** Card-like surfaces use the
  `.glass-card` primitive with `--glass-blur` and `--radius`. Smaller
  nested controls (buttons, chips, badges) use `--surface-active` so they
  read one level above the card.
- **Never hardcode a colour in component CSS.** Reference a token so it
  stays correct in every combination.
- **Font is Proxima Nova everywhere**, the GFTV branding font, self hosted
  and set once through `--font`. No per-component `font-family`.

  Proxima Nova is licensed and is not on Google Fonts, so it cannot be
  pulled in with an `@import` the way Inter was. Each app self hosts the
  `.woff2` files under `assets/fonts/` and declares its own `@font-face`
  blocks. Self hosting is also what an offline capable PWA needs: a font on
  a third party host cannot be precached, and an installed app would load
  unstyled.

  The `--font` stack ends in the system sans serif, so an app that has not
  yet been given the licensed files renders plainly rather than breaking.
  Where only the regular weight is available, declare that face alone and
  let the browser synthesise the heavier weights, rather than declaring a
  face that 404s.

  This replaces Inter, which was the GFTV font before Proxima Nova was
  adopted. Nothing else in this file changes: the token contract, the
  palette, and every measured contrast ratio in the audit below are
  unaffected, since none of them depend on the typeface.
- **No emoji as icons.** Inline SVG, coloured with `currentColor`.
- **No em dashes** in UI copy, code comments, or docs. Use a comma,
  semicolon, colon, or period.
- **Light mode is the default.** Do not read `prefers-color-scheme` on
  first load, ever. Users opt into dark explicitly in the theme modal, and
  into the time based rule the same way. Neither the OS setting nor the clock
  changes anything for somebody who has not chosen it.
- **`data-mode` is only ever `light` or `dark`.** A third value would match no
  colour block in this file and the page would render unstyled. Anything that
  is a rule for picking a mode, rather than a mode, is a preference and
  resolves before it is written to the attribute.
- **Every text pair meets WCAG AA** in all four combinations: 4.5:1 for
  body text, 3:1 for large text (18.66px bold or 24px and up) and for UI
  boundaries that carry meaning. The audit table below lists the measured
  ratio for every pair. Exactly two pairs are exempt, both listed under
  Documented exceptions with their scope. A new pair under 4.5:1 is a bug,
  not a third exception.
- **Accent text and accent fills are different tokens.** Body-size accent
  text uses `--brand-text`. Accent fills use `--brand-dark`, with
  `--brand-on` for the label sitting on them. Mixing these is what breaks
  contrast in the `hello` theme.
- **Everything that opens, closes, or switches state animates**, 150 to
  220ms. Show and hide is a single `.hidden` class flip in JS; timing
  lives in CSS. Honour `prefers-reduced-motion: reduce`.
- **Radii come from `--radius` and `--radius-sm`**, not fixed pixel values.
- Layout, header height, and sidebar behaviour are out of scope.

## Token contract

Token **names stay exactly as they are**. Hundreds of declarations depend
on them and renaming buys nothing:

`--brand`, `--brand-dark`, `--brand-text`, `--bg`, `--bg-alt`,
`--surface`, `--surface-hover`, `--surface-active`, `--border`,
`--border-strong`, `--text`, `--text-muted`, `--text-light`, `--shadow`,
`--glass-blur`, `--radius`, `--radius-sm`, `--font`

Roles worth stating, since three of these are misleading:

- `--brand` is the swatch identity colour, the one shown on the dot in the
  theme modal. Same value in both modes. Display only, no text ever sits
  on it, so it needs no paired foreground.
- `--brand-dark` is not "a dark colour", it is **the primary accent fill**,
  used around 37 times. In dark mode it gets lighter, not darker. It is no
  longer the accent *text* colour; see `--brand-text` below.
- `--brand-text` was defined and never used. It now has a job: **accent
  text at body size**, headings, and active-state labels sitting on a page
  or card background. This is what fixes `hello` light, where
  `--brand-dark` (`#9e8800`) reaches 3.41:1 on `--bg` and 2.88:1 on a
  nested surface, both short of AA for body text. Accent text on a
  background is `--brand-text`; text on an accent fill is `--brand-on`.
- `--brand-mid` is defined, never used, and has no role in the new model.
  Drop it rather than carry a dead token. See open question 3.

### New tokens to add

| Token | Why |
|---|---|
| `--brand-on` | foreground on `--brand-dark` fills. Six rules currently hardcode `color: white`, which breaks the moment `--brand-dark` becomes a light tint in dark mode. |
| `--brand-dark-hover` | the hover step above `--brand-dark`, derived rather than picked, so it stays correct in both modes. |
| `--text-muted-strong` | secondary text sitting on `--surface-active`. Plain `--text-light` drops to 3.74:1 there in dark mode, since the stacked overlays lighten the backdrop. |
| `--link`, `--link-visited` | `:link { color: #EF3340 }` and `:visited { color: #66f }` sit outside the token system. Note `:link` at (0,1,0) beats `a { color: var(--brand-dark) }` at (0,0,1), so in-content links are GFTV red today, not the accent. That is current behaviour and the new tokens preserve it. |
| `--danger`, `--danger-hover`, `--danger-on`, `--ok`, `--warn` | `.btn-danger` hardcodes `#c0392b` / `#a93226`, plus `#c62828` and `#8a2a2a` elsewhere. Status colours belong on one definition. |
| `--callout-danger-bg`, `--callout-ok-bg` | the `rgba(200,60,60,...)` and `rgba(60,180,60,0.15)` callout tints, now derived from the status tokens at 14%. |
| `--glass-highlight` | the inset `rgba(255,255,255,0.6)` highlight inside `.glass-card` reads as a white scar on dark surfaces. |
| `--focus-ring` | every border token lands under 3:1 in every combination, so focus indicators cannot rely on `--border-strong`. |

## Structure of the token blocks

```css
/* structural tokens, no colour, no axis */
:root {
  --glass-blur: 16px;
  --radius: 14px;
  --radius-sm: 8px;
  --font: 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI',
    Roboto, Helvetica, Arial, sans-serif;
}

/* one block per colour theme x mode combination */
:root[data-color-theme="classic"][data-mode="light"] { ... }
:root[data-color-theme="classic"][data-mode="dark"]  { ... }
:root[data-color-theme="hello"][data-mode="light"]   { ... }
:root[data-color-theme="hello"][data-mode="dark"]    { ... }
```

Both attributes go in every selector. That keeps specificity uniform at
(0,3,0) and removes any dependence on source order. A pre-paint script
guarantees both attributes exist before first paint, so there is no
attribute-missing fallback to reason about.

The default colour theme is renamed from `light` to `classic`, since
`light` now means a mode.

## Colour values

Brand values below are carried over verbatim. Nothing in the established
GFTV palette changes. The tokens that move are the ones that were never
brand colours to begin with: links, status colours, and the foregrounds
that were hardcoded to `white`.

### classic, light

```css
--brand: #ffffff;
--brand-dark: #4a6a8a;
--brand-text: #1a3a5a;
--brand-on: #ffffff;
--bg: #ffffff;
--bg-alt: #f5f5f5;
--surface: rgba(255, 255, 255, 0.6);
--surface-hover: rgba(245, 245, 245, 0.8);
--surface-active: rgba(235, 235, 235, 0.95);
--border: rgba(180, 190, 200, 0.4);
--border-strong: rgba(140, 155, 170, 0.6);
--text: #1a1a2e;
--text-muted: #4a5568;
--text-light: #6b7280;
--shadow: rgba(100, 120, 140, 0.12);
--glass-highlight: rgba(255, 255, 255, 0.6);
--link: #EF3340;
--link-visited: #4b4bd6;
--danger: #b03325;
--danger-hover: #8a2a2a;
--danger-on: #ffffff;
--ok: #177038;
--warn: #8a5200;
```

### hello, light

```css
--brand: #fedc00;
--brand-dark: #9e8800;
--brand-text: #3a3000;
--brand-on: #ffffff;
--bg: #fffde0;
--bg-alt: #fff9c4;
--surface: rgba(254, 220, 0, 0.35);
--surface-hover: rgba(254, 220, 0, 0.55);
--surface-active: rgba(254, 220, 0, 0.7);
--border: rgba(200, 170, 0, 0.3);
--border-strong: rgba(160, 130, 0, 0.5);
--text: #2e2800;
--text-muted: #5a4e00;
--text-light: #7a6c00;
--shadow: rgba(160, 130, 0, 0.15);
--glass-highlight: rgba(255, 255, 255, 0.5);
--link: #EF3340;
--link-visited: #4b4bd6;
--danger: #b03325;
--danger-hover: #8a2a2a;
--danger-on: #ffffff;
--ok: #177038;
--warn: #8a5200;
```

### classic, dark

Dark mode has never existed in GFTV, so these values are new. They are
derived from the colours GFTV already states (the `#4a6a8a` blue-grey
family and the `#fedc00` yellow), not invented from scratch. Signed off,
treat as canonical.

Derivation used:
- `--brand` keeps the swatch identity, unchanged across modes.
- `--brand-dark` flips to a light tint of the same hue so it reads as an
  accent fill on a dark background.
- `--brand-text` becomes a lighter tint of the same hue for accent text.
- `--brand-on` flips to a dark ink, since it now sits on a light fill.
- Neutral surfaces become low-opacity white overlays, tinted with the
  swatch hue where the light theme was already tinted.
- Text ramps invert: near-white primary, two muted steps down.

```css
--brand: #ffffff;
--brand-dark: #8fb0cf;
--brand-text: #cfe0f0;
--brand-on: #10161d;
--bg: #0f1317;
--bg-alt: #161b21;
--surface: rgba(255, 255, 255, 0.06);
--surface-hover: rgba(255, 255, 255, 0.10);
--surface-active: rgba(255, 255, 255, 0.14);
--border: rgba(160, 180, 200, 0.18);
--border-strong: rgba(160, 180, 200, 0.32);
--text: #eceff3;
--text-muted: #a7b2be;
--text-light: #7d8794;
--shadow: rgba(0, 0, 0, 0.5);
--glass-highlight: rgba(255, 255, 255, 0.08);
--link: #ff6b74;
--link-visited: #a9a9ff;
--danger: #ff8a80;
--danger-hover: #ffb3ac;
--danger-on: #1a0f0e;
--ok: #6ee7a0;
--warn: #fbbf24;
```

### hello, dark

```css
--brand: #fedc00;
--brand-dark: #fedc00;
--brand-text: #ffe873;
--brand-on: #2e2800;
--bg: #14120a;
--bg-alt: #1c1a0e;
--surface: rgba(254, 220, 0, 0.10);
--surface-hover: rgba(254, 220, 0, 0.16);
--surface-active: rgba(254, 220, 0, 0.22);
--border: rgba(254, 220, 0, 0.20);
--border-strong: rgba(254, 220, 0, 0.36);
--text: #f5f0dc;
--text-muted: #c4ba8e;
--text-light: #9a9270;
--shadow: rgba(0, 0, 0, 0.55);
--glass-highlight: rgba(255, 255, 255, 0.06);
--link: #ff6b74;
--link-visited: #a9a9ff;
--danger: #ff8a80;
--danger-hover: #ffb3ac;
--danger-on: #1a0f0e;
--ok: #6ee7a0;
--warn: #fbbf24;
```

## Derived tokens

These resolve against the per-combination blocks above, so they stay
correct in all four without being restated four times.

```css
:root {
  /* Hover step above --brand-dark, both modes. */
  --brand-dark-hover: color-mix(in srgb, var(--brand-dark) 85%, var(--text));
  /* Secondary text on --surface-active. */
  --text-muted-strong: color-mix(in srgb, var(--text) 70%, transparent);
  /* Callout tints, 14% of the status colour. */
  --callout-danger-bg: color-mix(in srgb, var(--danger) 14%, transparent);
  --callout-ok-bg: color-mix(in srgb, var(--ok) 14%, transparent);
  --callout-warn-bg: color-mix(in srgb, var(--warn) 14%, transparent);
  /* Focus indicator. Border tokens are all under 3:1, brand-dark is not. */
  --focus-ring: var(--brand-dark);
}
```

The status colours are tuned so each reads at or above 4.5:1 against a 14%
tint of itself, which is the standard callout and badge treatment:

```css
.callout.danger {
  background: var(--callout-danger-bg);
  color: var(--danger);
}
```

Measured on that pattern: danger 5.02 light and 6.52 dark, ok 5.02 light
and 8.94 dark, warn 5.21 light and 8.47 dark. The previous `#c0392b` sat
at 4.40 against its own tint, which is the reason for the small shift to
`#b03325`.

Any fill that tracked the colour theme before the mode axis existed must
still track it after. If a surface changed colour when the user switched
between `classic` and `hello`, it keeps doing that in both light and dark.
The `hello` surface tokens are already brand tints, so this holds as long
as component CSS points at `--surface` and friends rather than a hex.

## WCAG audit

Measured against the values above. Body text target 4.5:1, large text and
meaningful UI boundaries 3:1.

| Pair | classic light | hello light | classic dark | hello dark |
|---|---|---|---|---|
| `--text` on `--bg` | 17.06 | 14.35 | 16.17 | 16.40 |
| `--text-muted` on `--bg` | 7.53 | 8.07 | 8.66 | 9.60 |
| `--text-light` on `--bg` | 4.83 | 5.13 | 5.12 | 6.00 |
| `--text-light` on stacked `--surface-active` | 4.83 | 4.33 | **3.74** | **3.76** |
| `--text-muted-strong` on stacked `--surface-active` | 6.28 | 5.03 | 6.63 | 5.95 |
| `--brand-text` on `--bg` | 11.69 | 12.72 | 13.83 | 15.21 |
| `--brand-dark` on `--bg` (as a fill, 3:1 target) | 5.65 | 3.41 | 8.24 | 13.79 |
| `--brand-on` on `--brand-dark` | 5.65 | **3.51** | 8.04 | 10.88 |
| `--link` on `--bg` | **4.02** | **3.91** | 6.76 | 6.79 |
| `--link-visited` on `--bg` | 6.41 | 6.22 | 8.71 | 8.75 |
| `--border-strong` on `--bg` | 1.78 | 1.78 | 1.97 | 2.76 |

Four consequences, each of which is a rule rather than a note:

1. **`--text-light` never carries meaning on a nested control.** It fails
   AA on `--surface-active` in both dark themes. Use `--text-muted-strong`
   for placeholders, chip labels, badge captions, and icon-button glyphs
   that sit on `--surface-active`. Set `opacity: 1` on placeholders using
   it; a stacked opacity multiplier puts the pair back under AA.
2. **`--brand-dark` is a fill, not body text.** In `hello` light it reaches
   3.41:1 on `--bg` and 2.88:1 on a nested surface. Fine as a fill, fine
   for large headings on `--bg`, short of AA for body-size text anywhere.
   Body-size accent text uses `--brand-text`.
3. **Borders are decorative.** No border token clears 3:1 in any
   combination, and lifting them would change the established look. So
   dividers and card edges stay as they are, and anything where the
   boundary is the whole affordance (focus rings, input outlines, selected
   states) uses `--focus-ring` plus the containment ring below.
4. **Two pairs are documented exceptions, not passes.** `--link` in light
   mode and `--brand-on` in `hello` light both sit under 4.5:1 and stay
   that way on purpose. They are bounded in the section below. Nothing
   else in the system is allowed to join them.

### Documented exceptions

Two pairs fail AA and are kept anyway, because the colour is GFTV identity
and the alternative changes a look that already ships. Both are scoped. If
a new pair fails, it is a bug, not a third exception.

**1. `--link` in light mode.** GFTV red `#EF3340` measures 4.02:1 on the
`classic` background and 3.91:1 on `hello`. Kept verbatim. Scope and
mitigation:

- **Links carry no underline, in any state.** This is a change. The
  mitigation used to be "keep the underline, since the underline is the
  affordance rather than the colour". GFTV now wants links clean, so the
  underline is gone and colour is the only thing distinguishing an
  in-content link from body text.
- Do not reuse `--link` for anything other than links. It is not a status
  colour and not an accent.
- Dark mode is not an exception on the background pair. `#EF3340` on
  near-black is 4.63:1, which passes, but it reads muddy, so dark mode uses
  `#ff6b74` at 6.76:1. `--link-visited` `#6666ff` is 4.28:1 and has no brand
  identity to preserve, so it moves to `#4b4bd6` at 6.41:1 in light mode.

Dropping the underline moves the relevant test from link against background
to link against **body text**, which is what WCAG 1.4.1 asks for when colour
is the only means of identifying a link. Measured against `--text`:

| Pair | classic light | hello light | classic dark | hello dark |
|---|---|---|---|---|
| `--link` on `--text` | 4.24 | 3.68 | **2.39** | **2.42** |
| `--link-visited` on `--text` | **2.66** | **2.31** | **1.86** | **1.87** |

Both light combinations clear the 3:1 bar for unvisited links. Neither dark
combination does, and no combination does for visited links. So in dark mode
a link inside a paragraph is close to indistinguishable from the text around
it until it is hovered or focused.

**The mitigation is weight, not colour.** A link inside body copy is set one
step heavier than the text around it. That is a non-colour distinction, so
1.4.1 is satisfied in all four combinations including the two dark ones, and
it covers visited links as well, which are the worst pairs in the table. It
replaces the underline rather than restoring it.

Only prose containers are targeted, since navigation, footer lists, buttons,
and chips already read as controls and set their own weight. Wrapping the
prose selector in `:where()` keeps its specificity at `(0,0,1)`, so any
component rule that names a class overrides it without `!important`.

```css
a,
a:link,
a:visited,
a:hover,
a:focus,
a:active {
  text-decoration: none;
}

:link {
  color: var(--link);
}

/* The non-colour distinction that replaces the underline. */
:where(p, li, dd, dt, td, th, blockquote, figcaption, .lede) a {
  font-weight: 600;
}
```

**2. `--brand-on` on `--brand-dark` in `hello` light.** White on `#9e8800`
is 3.51:1. Kept verbatim, so Hello primary buttons look exactly as they do
today. Scope:

- Clears the 3:1 bar for large text and for non-text UI contrast, so it is
  fine for button labels, chips, badges, and toasts, which is everywhere it
  is used now.
- Never put paragraph-length or caption-size text on `--brand-dark` in
  `hello`. If a new surface needs body copy on the accent, use
  `--brand-text` on `--bg` instead of inventing a fill.
- The fill itself is fine: `--brand-dark` against `--bg` is 3.41:1, which
  clears the 3:1 non-text bar, so the button boundary is visible without a
  border.
- The other three combinations are comfortable (5.65, 8.04, 10.88), so this
  is a `hello` light exception only.

Focus indicator, which needs to survive `hello` light where `--brand-dark`
against a nested surface is 2.88:1:

```css
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--text) 45%, transparent);
}
```

The outer ring is what carries the state in the weakest combination. The
same trick applies to the active swatch in the theme modal, since the
`classic` swatch is `#ffffff` and vanishes on a light modal without a
containment ring.

## Loading states

Three primitives, because loading is not one situation.

| Primitive | For |
|---|---|
| `.spinner` | an action is in flight and the result has no shape yet |
| `.skeleton` | content is coming whose shape is already known |
| `.delayed` | wraps either, and shows nothing for the first 250ms |

**The delay is the part most often left out.** A spinner that appears for 80ms
and vanishes reads as a flicker, and most same origin fetches finish inside
that. Showing nothing until 250ms means a fast response is never seen to load
at all, and a slow one is still acknowledged long before anyone wonders.
`animation-fill-mode: both` holds opacity at 0 through the delay, so this needs
no JavaScript and no timers.

**No shimmer sweep.** The usual skeleton effect is a gradient sliding across the
block, and gradients are forbidden. A flat `--surface-active` tint with an
opacity pulse does the same job, reads calmer, and obeys the rule.

**Every one of them carries text for a screen reader.** An animation announces
nothing. Pair a spinner with a visible or visually hidden label, put
`aria-busy="true"` on a container holding skeletons and remove it when the real
content lands, and give a live region `role="status"` so the result is
announced without stealing focus.

```css
@keyframes gftv-spin  { to { transform: rotate(360deg); } }
@keyframes gftv-pulse { 50% { opacity: 0.45; } }
@keyframes gftv-fade-in { from { opacity: 0 } to { opacity: 1 } }

.spinner {
  --spinner-size: 1.25rem;
  --spinner-weight: 2px;
  width: var(--spinner-size);
  height: var(--spinner-size);
  border-radius: 50%;
  border: var(--spinner-weight) solid color-mix(in srgb, var(--text) 16%, transparent);
  border-top-color: var(--brand-dark);
  animation: gftv-spin 700ms linear infinite;
}

/* On a --brand-dark fill, where the accent border would vanish. */
.btn-primary .spinner {
  border-color: color-mix(in srgb, var(--brand-on) 30%, transparent);
  border-top-color: var(--brand-on);
}

.skeleton {
  background: var(--surface-active);
  border-radius: var(--radius-sm);
  animation: gftv-pulse 1.4s ease-in-out infinite;
}

.delayed { animation: gftv-fade-in 180ms ease 250ms both; }
```

### The one exception to the reduced motion rule

The blanket `prefers-reduced-motion` block stops every animation on the page.
These two are deliberately exempt, and slow down instead:

```css
@media (prefers-reduced-motion: reduce) {
  .spinner  { animation-duration: 2s   !important; animation-iteration-count: infinite !important; }
  .skeleton { animation-duration: 2.4s !important; animation-iteration-count: infinite !important; }
  .delayed  { animation: none !important; }
}
```

A loading indicator that does not move indicates nothing, and a stopped spinner
reads as a failed one. Both are small, localised, and constant, which is not
what the guidance targets: that is aimed at large sweeps, parallax, and
anything that moves the page under a reader. `.delayed` drops its fade entirely,
since there the animation is only a nicety.

If a third exception is ever proposed, it is almost certainly a bug rather than
an exception.

## Shape conventions

- `.glass-card`: `border-radius: var(--radius)`, `--glass-blur` backdrop
- Chip-style buttons: `999px`; rectangular buttons and inputs:
  `var(--radius-sm)`
- Icon buttons: `40px` square, `32px` with `.small`
- Single breakpoint: `@media (max-width: 480px)`

---

## 1. CSS to add (`css/theme.css`, or the top of `style.css`)

```css
/* Proxima Nova is licensed and is not on Google Fonts, so it is self hosted
   rather than imported. Drop the .woff2 files into assets/fonts/ and declare
   one face per weight. Only declare a weight whose file is actually present;
   the browser synthesises the rest from the regular. */

@font-face {
  font-family: 'Proxima Nova';
  src: url('/assets/fonts/ProximaNova-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
/* Repeat for Medium 500, Semibold 600, and Bold 700 as those files arrive. */

/* structural, no colour */
:root {
  --glass-blur: 16px;
  --radius: 14px;
  --radius-sm: 8px;
  --font: 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI',
    Roboto, Helvetica, Arial, sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; font-family: var(--font); }
html, body { height: 100%; }

body {
  background: var(--bg);
  color: var(--text);
  transition: background-color 0.25s ease, color 0.25s ease;
}

/* No underline in any state. List the states out so no component rule and no
   user agent default can reintroduce one. See the exceptions section. */
a, a:link, a:visited, a:hover, a:focus, a:active { text-decoration: none; }
:link { color: var(--link); }
:visited { color: var(--link-visited); }

button { cursor: pointer; border: none; background: none; color: inherit; }
button:disabled { cursor: not-allowed; opacity: 0.6; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}

/* one block per colour theme x mode, values from the section above */
:root[data-color-theme="classic"][data-mode="light"] { /* ... */ }
:root[data-color-theme="classic"][data-mode="dark"]  { /* ... */ }
:root[data-color-theme="hello"][data-mode="light"]   { /* ... */ }
:root[data-color-theme="hello"][data-mode="dark"]    { /* ... */ }

/* derived, resolves per combination */
:root {
  --brand-dark-hover: color-mix(in srgb, var(--brand-dark) 85%, var(--text));
  --text-muted-strong: color-mix(in srgb, var(--text) 70%, transparent);
  --callout-danger-bg: color-mix(in srgb, var(--danger) 14%, transparent);
  --callout-ok-bg: color-mix(in srgb, var(--ok) 14%, transparent);
  --callout-warn-bg: color-mix(in srgb, var(--warn) 14%, transparent);
  --focus-ring: var(--brand-dark);
}

/* glass primitive */
.glass-card {
  background: var(--surface);
  backdrop-filter: blur(var(--glass-blur)) saturate(150%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(150%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow) 0 8px 24px, inset 0 1px 0 var(--glass-highlight);
}

/* accent fill and its label */
.btn-primary {
  background: var(--brand-dark);
  color: var(--brand-on);
  border-radius: var(--radius-sm);
}
.btn-primary:hover { background: var(--brand-dark-hover); }

.btn-danger { background: var(--danger); color: var(--danger-on); }
.btn-danger:hover { background: var(--danger-hover); }

/* focus, see the audit section */
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--text) 45%, transparent);
}

/* theme modal */
.swatch { background: var(--surface); border: 1px solid var(--border); }
.swatch.active {
  border-color: var(--swatch-color);
  box-shadow:
    0 0 0 2px var(--swatch-color),
    0 0 0 3px color-mix(in srgb, var(--text) 50%, transparent);
}
.swatch-dot {
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--swatch-color);
  border: 1px solid color-mix(in srgb, var(--text) 30%, transparent);
}
.mode-btn.active { background: var(--brand-dark); color: var(--brand-on); }

/* Time based mode only. Light and dark stay side by side and the third spans
   the row beneath them: three equal columns put the longer label in a box too
   narrow to read at 320px, and the full width row also says visually that this
   one is a different kind of choice, a rule for picking a mode rather than a
   mode. Omit both rules in an app that ships the two button toggle. */
.mode-btn-wide { grid-column: 1 / -1; }
.mode-note {
  margin-top: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-muted);
}
```

## 2. `js/theme.js` (copy verbatim, change `APP_KEY` only)

```js
// Two axes: colour theme and light/dark mode.
// Default is always classic + light, regardless of OS preference.

const APP_KEY = "gftv-appname"; // e.g. gftv-policyspot

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
```

`withLightMode` writes the attributes directly and never touches
localStorage, so an export cannot overwrite the user's choice if it throws
partway through. It saves and restores the resolved mode rather than the
preference, which is right: the attribute is what is being put back.

## 3. HTML

In `<head>`, before the stylesheet:

```html
<meta name="theme-color" content="#ffffff" />
<script>
  (function () {
    var k = "gftv-appname";
    var m = localStorage.getItem(k + ".mode") || "light";

    // Time based mode. Resolved here rather than in theme.js because theme.js
    // runs after first paint, and an evening reader would otherwise watch a
    // white page turn dark. Keep the two hours in step with LIGHT_FROM_HOUR
    // and LIGHT_UNTIL_HOUR in theme.js. Omit this block in an app that ships
    // the two button toggle.
    if (m === "time") {
      var h = new Date().getHours();
      m = h >= 9 && h < 18 ? "light" : "dark";
      document.documentElement.setAttribute("data-mode-preference", "time");
    }

    var c = localStorage.getItem(k + ".colorTheme") || "classic";
    document.documentElement.setAttribute("data-mode", m);
    document.documentElement.setAttribute("data-color-theme", c);
  })();
</script>
```

This runs before first paint and guarantees both attributes exist, which is
what lets every colour block select on both without a fallback. Keep the key
in sync with `APP_KEY`.

Modal at the end of `<body>`, starting with `.hidden`:

```html
<div class="modal-backdrop hidden" id="themeModal">
  <div class="modal glass-card" role="dialog" aria-modal="true" aria-labelledby="themeModalTitle">
    <div class="modal-head">
      <h2 id="themeModalTitle">Theme</h2>
      <button class="icon-btn small" type="button" data-close-modal="themeModal" aria-label="Close">
        <span data-icon="close"></span>
      </button>
    </div>
    <p class="modal-section-label">Mode</p>
    <div class="mode-toggle" id="modeToggle">
      <button class="mode-btn" type="button" data-mode="light" aria-pressed="false"><span data-icon="sun"></span>Light</button>
      <button class="mode-btn" type="button" data-mode="dark" aria-pressed="false"><span data-icon="moon"></span>Dark</button>
      <button class="mode-btn mode-btn-wide" type="button" data-mode="time" aria-pressed="false"><span data-icon="clock"></span>Time-based</button>
    </div>
    <p class="mode-note" id="modeNote" hidden></p>
    <p class="modal-section-label">Colour theme</p>
    <div class="swatch-grid" id="swatchGrid"></div>
  </div>
</div>
```

Selecting a swatch or a mode updates the modal in place. It never closes the
modal; closing is a separate explicit action (close button, or the backdrop).

The third mode button and `#modeNote` belong to the time based option only.
Drop both in an app that ships the two button toggle. Where it is shipped, the
button pressed state comes from `getModePreference()` and the note says which
mode the clock has currently chosen, so the two are never confused. The modal
should listen for `gftv:modechange` and re-sync, or a tab left open shows the
wrong answer after six.

## localStorage

Keys are namespaced per app, `gftv-<app>.colorTheme` and `gftv-<app>.mode`.
GFTV apps live on different subdomains, so localStorage is per-origin and a
shared key would not sync between them anyway.

`.mode` stores the **preference**, not the resolved mode, so its value is
`light`, `dark`, or `time`. An app that does not ship the time based option
will never write `time`, and one that does must not write the resolved value
back over it: storing `dark` on a winter evening would silently end the
setting the person actually chose.

Migration from the old single key `gftv-theme`:

| Old value | New colorTheme | New mode |
|---|---|---|
| `light` | `classic` | `light` |
| `hello` | `hello` | `light` |
| missing or unknown | `classic` | `light` |

Migration runs once, on the first `initTheme()` after the update, and
removes the old key.

## Acceptance checklist

- [ ] Every colour theme renders in both modes with readable text
- [ ] Fresh profile with the OS in dark mode still loads light
- [ ] Choice survives reload and applies on every page in the app
- [ ] Theme button icon matches the active mode
- [ ] Search modal, callouts, danger buttons, and toasts all follow the
      mode, with no white boxes left in dark
- [ ] PDF export still produces a light document and restores both axes
      afterwards, including when the export throws
- [ ] `meta[name="theme-color"]` tracks the active combination, not the
      colour theme alone
- [ ] Zero hardcoded colour values left outside the token blocks
- [ ] Proxima Nova is self hosted under `assets/fonts/`, with a `@font-face`
      block only for weights whose file is actually present, and the page
      falls back to the system sans serif rather than breaking when none are
- [ ] No `@import` of a font from a third party host anywhere, since that
      cannot be precached by a service worker
- [ ] Old `gftv-theme` value migrates without the user losing their pick
- [ ] Every text pair clears AA 4.5:1 in all four combinations, except the
      two logged exceptions
- [ ] No underline on a link in any state, including hover and focus
- [ ] Links in body copy are one weight step heavier than the surrounding
      text, which is what carries the affordance in place of the underline
- [ ] The two exceptions stay in scope: `--link` is used for links only, and
      nothing body-size sits on `--brand-dark` in `hello` light
- [ ] Nothing body-size uses `--brand-dark` as a text colour
- [ ] Secondary text on `--surface-active` uses `--text-muted-strong`
- [ ] Focus is visible in `hello` light, where the accent against a nested
      surface is 2.88:1 on its own
- [ ] The active `classic` swatch is still visibly ringed on a white modal
- [ ] Loading states use `.spinner` or `.skeleton`, never a bare frozen screen
- [ ] Nothing loading shows an indicator before 250ms have passed
- [ ] Every loading indicator is paired with text a screen reader can announce
- [ ] No gradients, no emoji, no em dashes

Time based mode, where the app ships it:

- [ ] `data-mode` is still only ever `light` or `dark`, in the DOM and in
      localStorage's resolved reads
- [ ] `.mode` in localStorage holds the preference, and picking `time` and
      reloading in the evening still shows `time` pressed rather than `dark`
- [ ] No flash: loading in the evening with `time` chosen paints dark from the
      first frame, which means the pre-paint script resolves it
- [ ] The two hours in the pre-paint script match `LIGHT_FROM_HOUR` and
      `LIGHT_UNTIL_HOUR` in `theme.js`
- [ ] A tab held open across 09:00 or 18:00 changes mode by itself, and the
      theme modal's note updates with it
- [ ] A device woken from sleep past a boundary corrects on the next look at
      the tab, not on the next reload
- [ ] `meta[name="theme-color"]` follows the resolved mode, not the preference
- [ ] Changing the device clock or the timezone is reflected without clearing
      storage
- [ ] Nothing asks for, sends, or stores a timezone or a location

## Open questions

1. **`--brand-mid`.** Dropped above, since `--brand-dark-hover` covers the
   one role it could have had. Confirm nothing downstream reads it.
2. **Colour theme set per repo.** PolicySpot has `classic` and `hello`. Do
   HelloQueue, HelloTrace, HelloShare, GFTV Forms, FURST, and the portal
   all carry the same two, or does any of them state a third?

Settled, kept here so the reasoning is not relitigated:

- In-content links stay GFTV red `#EF3340` in light mode, as a documented
  exception. The underline that used to carry the affordance has since been
  removed, so colour carries it alone. The cost of that is measured in the
  exceptions section and accepted.
- `--brand-on` stays white on `hello` light, as a documented exception
  bounded to button, chip, and badge labels.
- Both dark palettes are approved as written.