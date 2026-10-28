# Setting up OneLink GFTV

From an empty Vercel project to a working site at `links.gftv.asia`, with the
Telegram bot and staff access. Do the sections in order; each ends with a
check.

## 1. Database

In the Supabase project that already holds the `gftvhello_` tables, open
**SQL Editor** and run each file in `migrations/` once, in number order:

- `001_onelink_schema.sql`
- `002_avatars.sql`: adds profile pictures, and creates the public
  `gftvonelink_avatars` storage bucket they are kept in
- `003_redirects_insights_dormancy.sql`: redirect pages, visitor insights,
  the yearly sign-in rule, blocked patterns and home page testimonials
- `004_name_review.sql`: page names that wait for staff approval
- `005_threat_list_bucket.sql`: the private `gftvonelink_lists` storage
  bucket that holds the compact copy of the domain blocklists
- `006_quarantine.sql`: pausing pages that keep trying harmful addresses
- `007_longer_bio.sql`: lets a bio be up to 512 characters
- `008_site_insights.sql`: the live totals on the home page, including the
  GFTV short links' visit log (`gftvlinks_linkvisits`) while it exists
- `009_connection_bans.sql`: banning connections that keep making harmful
  pages
- `010_testimonial_submissions.sql`: testimonials sent in by page owners,
  waiting for staff approval
- `011_email_links.sql`: lets a link be an email address (`mailto:`)
- `012_device_bans.sql`: bans the devices used on a banned connection along
  with it, by a hash of their fingerprint, and flags them for staff when they
  turn up elsewhere
- `013_link_caps.sql`: a limit on how many links each page can have (20 by
  default, set by admins), per-page limits, and owners' requests for a higher one
- `014_allowed_domains.sql`: domains staff allow past the threat lists (the
  HaGeZi blocklists and Google Safe Browsing), for a site caught by mistake

**Check:** in **Table Editor** you see the `gftvonelink_` tables, each marked
**RLS enabled**.

Later changes arrive as new numbered files. Run only the new ones; never edit
or rerun a file that has already been run.

## 2. Secrets to generate

Run these on any machine with Node, and keep the output for step 3:

```sh
node -e "console.log('TOTP_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('IP_HASH_SALT=' + require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('CRON_SECRET=' + require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('TELEGRAM_WEBHOOK_SECRET=' + require('crypto').randomBytes(24).toString('hex'))"
```

Without Node, for example on a plain Debian server, `openssl` makes the same
values:

```sh
echo "TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "IP_HASH_SALT=$(openssl rand -hex 32)"
echo "CRON_SECRET=$(openssl rand -hex 32)"
echo "TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)"
```

`TOTP_ENCRYPTION_KEY` must be exactly 32 bytes: 64 characters of hex, as
above, or 44 of base64 (`openssl rand -base64 32`). Anything else is refused
with an error naming the length it got. The other three take any long random
string; hex is safest for the webhook secret, which Telegram limits to
letters, digits, `_` and `-`.

Nothing in this guide runs on a server of your own: the site, its API and the
Telegram webhook all run on Vercel. Any terminal will do for these commands
and the `curl` calls in section 4.

**Never change `TOTP_ENCRYPTION_KEY` once owners have signed up.** It encrypts
their authenticator secrets; a new key makes every one unreadable, and those
owners can then sign in only with a backup code, a passkey or Telegram.
Keep a copy somewhere safe outside Vercel.

## 3. Vercel project

1. **Add New > Project**, import this repository.
2. **Root Directory:** `main-site`. **Framework Preset:** Other. Leave the
   build and output settings empty; there is no build step.
3. **Settings > Environment Variables**, for Production (and Preview if you
   use previews):

   | Variable | Value |
   | --- | --- |
   | `SITE_URL` | `https://links.gftv.asia` |
   | `SUPABASE_URL` | Supabase **Project Settings > API**, Project URL |
   | `SUPABASE_SERVICE_KEY` | Supabase **Project Settings > API Keys**, the `service_role` key (or a secret key). Server only; never put it in browser code. |
   | `TOTP_ENCRYPTION_KEY` | from step 2 |
   | `IP_HASH_SALT` | from step 2 |
   | `CRON_SECRET` | from step 2 |
   | `TELEGRAM_BOT_TOKEN` | from section 4, or leave empty for now |
   | `TELEGRAM_BOT_USERNAME` | from section 4, or leave empty for now |
   | `TELEGRAM_WEBHOOK_SECRET` | from step 2, or leave empty for now |
   | `GOOGLE_SAFE_BROWSING_KEY` | optional; see below |
   | `DOMAIN_BLOCKLISTS` | leave empty to use HaGeZi's lists; see below |
   | `TURNSTILE_SECRET` | the Turnstile secret key; **required in Production**; see [TURNSTILE-SETUP.md](TURNSTILE-SETUP.md) |
   | `TURNSTILE_HOSTNAMES` | `links.gftv.asia`; see [TURNSTILE-SETUP.md](TURNSTILE-SETUP.md) |

4. **Settings > Domains:** add `links.gftv.asia` and create the DNS record
   Vercel shows (a `CNAME` for `links`).
5. Deploy.

The daily cleanup (`/api/cron/cleanup`, 03:00 Singapore time) is declared in
`vercel.json` and appears under **Settings > Cron Jobs** after the first
production deploy. Besides clearing expired rows it sends dormancy reminders,
checks every live link again, and every 14 days fetches the domain
blocklists afresh.

**Link checks.** Every link and redirect address is checked when it is saved
and again each day:

- **HaGeZi blocklists**, on by default with nothing to set up: threat
  intelligence, fake stores, pop-up ads, badware hosting, gambling, URL
  shorteners, adult content and piracy, about 3 million domains. The first cron run
  (or **Fetch the lists now** under Block lists in `/admin`) downloads them
  and stores a compact copy in the `gftvonelink_lists` bucket; until then
  links are not checked against them. `DOMAIN_BLOCKLISTS=off` switches them
  off; `.env.example` describes using other lists.
- **Google Safe Browsing**, optional. In Google Cloud, enable **Safe Browsing
  API**, create an API key under **APIs & Services > Credentials**, and set it
  as `GOOGLE_SAFE_BROWSING_KEY`. The free tier is for non-commercial use.

**Turnstile**: Cloudflare's "are you a person" check on sign-up, sign-in,
password reset and the report form. The site key is in the code; the secret
must be set before production deploys, or those forms are refused. Set it up
with [TURNSTILE-SETUP.md](TURNSTILE-SETUP.md).

**Check:**

- `https://links.gftv.asia/` shows the home page with the official bar on top.
- Create a test page at `/register`, set up an authenticator app, and save
  the backup codes. Add a link, then open `links.gftv.asia/<your test name>`.
- `https://links.gftv.asia/api/slug?slug=test` answers with JSON.

## 4. Telegram bot (optional)

Telegram lets owners sign in with a code sent to them, and it is the only way
to reset a forgotten password, since OneLink has no email. Without it,
everything else works and the Telegram options do not appear.

### 4.1 Create the bot

In Telegram, open [@BotFather](https://t.me/BotFather):

1. Send `/newbot`. Give it a display name (for example `OneLink GFTV`) and a
   username ending in `bot` (for example `onelinkgftv_bot`).
2. BotFather replies with the **token**. That goes in `TELEGRAM_BOT_TOKEN`,
   and the username, without the `@`, goes in `TELEGRAM_BOT_USERNAME`.
3. Tidy it up:
   - `/setdescription`: `Sign-in and recovery codes for OneLink GFTV pages at links.gftv.asia.`
   - `/setabouttext`: `Codes for links.gftv.asia`
   - `/setuserpic`: upload `main-site/OLG-512.png`
   - `/setcommands`, then send:

     ```text
     start - Link a page from your page editor
     unlink - Stop receiving codes in this chat
     ```

   - `/setjoingroups` > **Disable**. Codes must only ever go to private chats,
     and the bot ignores groups anyway.

Add the three `TELEGRAM_` variables in Vercel and **redeploy**, so the
functions see them.

### 4.2 Point the bot at the site

Run once, with your token and webhook secret filled in:

```sh
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://links.gftv.asia/api/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"],"drop_pending_updates":true}'
```

The answer should be `{"ok":true,"result":true,...}`.

**Check:**

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

`url` is the address above, `pending_update_count` is 0, and there is no
`last_error_message`.

### 4.3 Try it end to end

1. Send the bot any message. It answers with the help: a heading, a table of
   commands, and the linking steps.
2. Sign in to your test page, open **Security**, choose **Link Telegram**,
   confirm your password, and press **Open Telegram**, then **Start**. The bot
   says the page is linked, and the editor shows "Linked as @you".
3. Sign out, sign in again, and pick **Telegram** as the second step. The code
   arrives as a message with a heading and the code in a box you can tap to
   copy.
4. Try `/reset` with the test page: a Telegram code plus your authenticator
   code sets a new password.

The code and help messages are Telegram rich messages (Bot API 10.1 and
later). If Telegram ever refuses one, the same information goes out as plain
text, and Vercel's function logs show `rich send failed, falling back`.
Seeing that line means the rich path needs a look; nobody misses a code.

### 4.4 Turning it off, or a leaked token

- **Turn Telegram off:** clear the three `TELEGRAM_` variables and redeploy,
  then remove the webhook:

  ```sh
  curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
  ```

  Linked chats stay on record and work again if it is switched back on.
- **Token leaked:** in BotFather send `/revoke`, pick the bot, put the new
  token in `TELEGRAM_BOT_TOKEN`, redeploy, and run 4.2 again. Also pick a new
  `TELEGRAM_WEBHOOK_SECRET` while you are there.

## 5. Staff access

Staff sign in at `https://links.gftv.asia/admin` with their existing GFTV
account. In `gftvhello_users` they need:

- `is_approved = true`;
- `is_admin = true` (everything) or `is_editor = true` (reports and links);
- an authenticator app on the account (`totp_secret`), set up on gftv.asia.
  Without one they are told to set it up there first. After signing in they
  can add a passkey under **My passkeys**, which works on this site only.

Backup codes from their GFTV account also work here, whichever GFTV site
issued them.

**Check:** sign in at `/admin`, see the overview counts, and report your test
page's link from its public page (the flag button). The report appears under
**Reports**.

## 6. Before launch

- Have a fluent Singaporean reader check `main-site/assets/i18n/zh.json`.
- Delete the test page from its editor (**Security > Delete my page**).
- Add real app screenshots to `manifest.json` if you want them on the install
  sheet. The old template ones were from another app and are not listed.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Every API call answers 500, and the logs say `missing environment variable` | A variable from section 3 is not set, or was added without a redeploy. |
| Sign-in works but the authenticator code is always wrong | The device clock is off, or `TOTP_ENCRYPTION_KEY` changed after the page was set up. |
| Passkeys fail on a `*.vercel.app` address | Expected: passkeys are bound to `links.gftv.asia`. Use the real domain, or an authenticator app. |
| `bad_origin` on every form | The site is being reached on a host other than `SITE_URL`. |
| The bot does not answer | `getWebhookInfo` shows the error. Usually the webhook secret differs between Telegram and Vercel, or the variables were added without a redeploy. |
| Staff told "Set up an authenticator app on your GFTV account" | That account has no `totp_secret` on gftv.asia yet. |
| A change does not show for people who installed the app | The update bar offers it on their next visit. If it never appears, `VERSION` in `main-site/sw.js` was not bumped. |
