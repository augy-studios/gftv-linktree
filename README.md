# OneLink GFTV

A link-in-bio site for GFTV at **links.gftv.asia**. Anyone can claim a page at
`links.gftv.asia/<name>`, add their links, and share it as a link or a QR code.
GFTV staff moderate pages from a dashboard at `/admin`.

## What is in this repository

| Path | What it is |
| --- | --- |
| `main-site/` | The Vercel project: static pages, browser scripts, and the serverless API. See [main-site/README.md](main-site/README.md). |
| `migrations/` | SQL to run by hand in the Supabase SQL editor, in number order. A file is never edited after it has been run; changes go in the next number. |
| `tools/make-icons.py` | Rebuilds the `OLG-*.png` app icons and `favicon.ico`. |
| `tools/make-icon-data.mjs` | Rebuilds `main-site/js/icon-data.js`, the link icons, from pinned Simple Icons (CC0) and Feather (MIT). Run `npm install && npm run icons` in `tools/`. |
| `SETUP.md` | Step-by-step setup, including the Telegram bot. |
| `TURNSTILE-SETUP.md` | Setting up Cloudflare Turnstile on sign-up, sign-in, password reset and reports. |
| `gftv-theme.md`, `gftv-official.md`, `update-bar-spec.md`, `i18n-retrofit-spec.md`, `telethon-richmessage-retrofit.md`, `gftv-retrofit-*.md` | The GFTV specifications this site follows. |
| `gftv-flag.png`, `PROXIMA NOVA FONT.woff2` | Source assets. The site uses a 72 by 48 copy of the flag and a renamed copy of the font. |

## Setting it up

Follow [SETUP.md](SETUP.md): the database, Vercel, the Telegram bot, and staff
access, each with a check at the end.

In short, staff with `is_admin` or `is_editor` on their GFTV account sign in at
`/admin`. Editors handle reports and remove or restore links. Admins can also
take pages down, edit the blocked names and domains, and read the audit log.
Admin sessions live in this site's own table, so signing in or out here never
affects a session on gftv.asia or any other GFTV site.

## Checks

From `main-site/`:

```sh
npm install
npm test             # API flows end to end, plus unit tests
npm run check-i18n   # every locale has every key; add --scan to check the pages too
npm run check-sw     # the service worker only skips waiting when asked
```
