# main-site

The Vercel project for OneLink GFTV. Static HTML, CSS and ES modules with no
build step, plus Node serverless functions under `api/`. Setup is in the
[project README](../README.md).

## Pages

| URL | File | Script |
| --- | --- | --- |
| `/` | `index.html` | `js/pages/home.js` |
| `/register` | `register.html` | `js/pages/register.js` |
| `/login` | `login.html` | `js/pages/login.js` |
| `/reset` | `reset.html` | `js/pages/reset.js` |
| `/edit` | `edit.html` | `js/pages/edit.js` |
| `/admin` | `admin.html` | `js/pages/admin.js` |
| `/privacy` | `privacy.html` | `js/pages/privacy.js` |
| `/<slug>` | `shell/profile.html`, served by `api/render.js` | `js/pages/profile.js` |
| anything else | `404.html` | `js/pages/notfound.js` |

`/<slug>` is rewritten to `api/render.js`, which puts the owner's name and bio
in the page's title and preview tags and inlines the page data, so links
appear without a second request. Real files always win over the rewrite, and
every path this site uses is on the reserved-name list in
`api/_lib/validate.js`.

Every page shares the same head, official bar, header, theme modal and footer.
Change them on every page together.

`/privacy` is OneLink's own notice under GFTV's Privacy Statement and Terms
of Use (policy.globalfurry.tv), saying what OneLink keeps and for how long.
Change it with any change to what is collected or how long it is kept, in
every locale.

## GFTV specifications

- **Theme** (`gftv-theme.md`): `style.css` section 1 holds the token blocks,
  glass, focus and loading primitives. `js/theme.js` is the spec's file with
  only `APP_KEY` changed. Light/dark/time-based mode, classic and hello themes.
  The pre-paint script is `js/prepaint.js`, loaded synchronously in `<head>`
  rather than inline, so the Content-Security-Policy can refuse inline scripts.
- **Font**: Proxima Nova Regular, self hosted at
  `assets/fonts/ProximaNova-Regular.woff2`. Only that weight is declared.
- **Official bar** (`gftv-official.md`): `js/official-bar.js`, first thing in
  every `<body>`. Not dismissible; only its expansion is remembered.
- **Update bar** (`update-bar-spec.md`): `sw.js` never calls `skipWaiting()`
  except when the bar's Reload button asks; `js/update-bar.js` shows the bar.
  Bump `VERSION` in `sw.js` on every deploy that changes a cached file.
- **i18n** (`i18n-retrofit-spec.md`): `assets/i18n/`. `en.json` is the source of
  truth, `zh.json` is 华文. The Chinese is a draft and wants a check by a fluent
  reader before launch, as `gftv-official.md` also says of its own copy.

## API

All under `api/`. Each answer is `{ ok: true, ... }` or `{ ok: false, error: "<code>" }`;
the browser shows `error.<code>` from the locale file.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/slug?slug=` | anyone | Is this name free? |
| `POST /api/auth/register` | anyone | Name, password and Turnstile token. Returns a setup challenge; the page stays private until a second factor is set up. |
| `POST /api/auth/enrol` | setup challenge | First authenticator or passkey. Activates the page, returns ten backup codes, signs in. |
| `POST /api/auth/login` | anyone | Password step. Returns a challenge and the second factors this page can use. |
| `POST /api/auth/verify` | login challenge | Authenticator, passkey, backup code or Telegram code. Signs in. |
| `POST /api/auth/recover` | anyone | Forgotten password: needs a Telegram code and the authenticator or a backup code. |
| `GET/POST /api/auth/session` | anyone | Am I signed in; sign out. |
| `GET/PATCH /api/me/page` | owner | The editor view; name and bio. |
| `POST/PATCH/DELETE /api/me/links` | owner | Add, edit, show/hide, reorder, delete links. Adding is refused once the page is at its link limit. |
| `GET/POST/DELETE /api/me/link-cap` | owner | The link limit; ask for a higher one, or withdraw the request. |
| `POST /api/me/security` | owner | Second factors, backup codes, Telegram, password, sign out elsewhere, delete page. Asks for the password again. |
| `GET /api/public/page` | anyone | A page as visitors see it. |
| `POST /api/public/click` | anyone | Count a click. |
| `POST /api/public/report` | anyone | Report a page or link, with a Turnstile token. |
| `GET /api/public/turnstile` | anyone | The Turnstile site key, or null. |
| `POST /api/telegram/webhook` | Telegram | Bot updates, checked against `TELEGRAM_WEBHOOK_SECRET`. Replies with the help message (rich) and one-line confirmations (plain). |
| `/api/admin/*` | staff | `auth`, `passkeys`, `overview`, `pages`, `links`, `reports`, `blocklist` (admin), `link-caps` (any staff answer requests for more links; the default and per-page limits are admin only), `audit` (admin). |
| `GET /api/cron/cleanup` | Vercel Cron | Sweeps expired rows. |

### Security model

- **Sessions**: HttpOnly, Secure, SameSite=Strict `__Host-` cookies. The table
  stores only the SHA-256 of the cookie. Owners get 7 days, staff 12 hours.
- **Second factor is mandatory**. A page cannot remove its last authenticator
  or passkey. Backup codes are spent on use, and checked with bcrypt.
- **No request signing.** Writes need the site's own `Origin` and a JSON body,
  on top of SameSite cookies.
- **Secrets at rest**: passwords bcrypt; owners' TOTP secrets AES-256-GCM with
  `TOTP_ENCRYPTION_KEY`; IP addresses and device fingerprints only as salted
  hashes.
- **Device fingerprints**, on the sign-up, sign-in, reset and editor pages
  only (`js/visitor.js`, FingerprintJS 5.3.0 vendored in `js/vendor/`, MIT,
  monitoring off). `api.js` sends the id as `X-OLG-Visitor`, waiting at most
  1.5 seconds for it. The server keeps only a salted hash, next to the address
  hash in the audit log, and clears it there after 30 days. Banning a
  connection bans the devices seen on it (migration 012); a banned device on
  another connection is flagged for staff and cannot create a page, but is
  never banned automatically. Public pages, the home page, 404 and `/admin`
  never load it, and a test checks that.
- **Turnstile** (Cloudflare) on sign-up and the report form, checked by
  `api/_lib/turnstile.js` once `TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY` are both set. On a public page its script loads
  only when the report form opens. See `TURNSTILE-SETUP.md`.
- **Rate limits** on every sensitive route, shared across instances through a
  table (`gftvonelink_rate_hit`).
- **Links** are `http` or `https` only. Other schemes are refused, not
  rewritten. They open with `rel="noopener noreferrer nofollow"`.
- **Data minimisation**: no route sends a database row as it came back.
  `api/_lib/serialize.js` builds each answer from a list of allowed fields, per
  audience. Password hashes, TOTP secrets, code and token hashes, Telegram chat
  ids, staff emails, reporter hashes and device hashes have no serializer, so they cannot
  reach a browser. The tests check every answer for those field names.
- **Staff** accounts are read from `gftvhello_users` on every request, so a
  role removed on gftv.asia stops working here at once. Staff backup codes are
  accepted in both formats the sister sites write (bcrypt from careers-gftv,
  SHA-256 from gftv-redirects-portal).

### Telegram messages

These follow `telethon-richmessage-retrofit.md`, adapted from Telethon to the
HTTP Bot API (10.1 and later). Structured messages (the code DMs, the help,
the dormancy reminder, and the answer to a request for more links) are built
in `api/_lib/telegram-messages.js` as `{ markdown, fallback }` and sent with
`sendRichMessage`. That method has no plain-text field, so when a
rich send is refused, `sendRichTelegram` sends the fallback with `sendMessage`
and logs `rich send failed, falling back`. One-line notices stay plain. Data in
the Markdown goes through `escapeMd`, and table cells through `escapeCell`.
Neither path uses `parse_mode`. The bot writes in English only. A message
that is a courtesy (the answer to a link limit request) is sent only when the
owner has Telegram linked, and a failed send is logged, never an error for
the staff member who answered.

### Profile pictures

Owners pick a picture in the editor's Profile tab, which opens the picture
editor (`js/avatar-composer.js`):

- **Framing.** The preview is the round frame the page uses. A cut-out is
  framed so the whole subject sits inside the circle; a subject the photo cut
  off (a head-and-shoulders shot) has its cut edges pushed outside the circle
  so no straight line shows. Drag, arrow keys, the slider or the wheel adjust
  it; Reset framing goes back to the automatic framing.
- **Background removal** runs in the browser, in `js/bg-removal-worker.js`,
  with IS-Net (`assets/models/`, Apache-2.0, provenance in `NOTICE.txt`) on
  onnxruntime-web (`assets/vendor/ort/`, MIT). The picture never leaves the
  device. The first use downloads about 57 MB, kept in the
  `onelink-models-v1` cache after that.
- **Backgrounds** behind a cut-out: none, a colour (swatches, or the colour
  wheel and hex field in `js/colour-wheel.js`, ported from the colorguess
  game), a gradient (presets, or custom start, end and direction), or another
  image.
- The browser saves a 512 by 512 WebP; `api/me/avatar.js` re-encodes it with
  sharp to WebP again, stripping all metadata, and stores it in the
  `gftvonelink_avatars` bucket under a fresh random name.

Staff can remove a picture from the page's details in the dashboard.

### Platform links

`js/platforms.js` lists 52 services with their address formats. Choosing one
fills in the start of the address, so the owner types only the username or
ID; YouTube offers handle, channel ID, custom address and legacy username.
An existing link to a known service opens again as that service. Links are
stored as ordinary addresses and checked like any other.

Icons come in categories (`ICON_CATEGORIES` in `js/icons.js`), from general
icons to service logos. `LINK_ICONS` in `api/_lib/validate.js` is the server's
list; the tests check the two agree.

### Offline

Every public page a visitor opens is kept on their device (the last 30 pages,
and the last 60 profile pictures), so it opens again without a connection,
marked as a saved copy. These caches are not emptied by a deploy.

## Tests

`npm test` runs every route end to end against `tests/fake-db.js`, an
in-memory stand-in for the Supabase client that mirrors the schema's
constraints, cascades and functions. The SQL itself was checked separately,
against a real Postgres (PGlite).
