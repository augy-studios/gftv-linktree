# Setting up Cloudflare Turnstile

Turnstile is Cloudflare's "are you a person" check. OneLink uses it on two
forms: sign-up (`/register`) and the report form on public pages. On a public
page Cloudflare's script loads only when someone opens the report form, never
just for reading the page.

It needs two keys from Cloudflare, set in Vercel. Until both are set, the
forms show no widget and the server skips the check, so nothing breaks while
you set it up.

## 1. Create the widget in Cloudflare

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com). A free
   account is enough, and `gftv.asia` does not need to be on Cloudflare.
2. Open **Turnstile** in the left sidebar (in newer dashboards it sits under
   **Application security**), then **Add widget**.
3. **Widget name:** `OneLink GFTV`.
4. **Hostnames:** add `links.gftv.asia`. If Vercel previews should show the
   widget too, also add `gftv-linktree-main-site.vercel.app`. Each preview
   deploy has its own address as well; add any you test on.
5. **Widget mode:** **Managed**. Leave **Pre-clearance** off.
6. **Create**. Cloudflare shows a **Site key** and a **Secret key**. Copy
   both. The site key is public; the secret key is a secret, so keep it out
   of chats, tickets and the repository.

## 2. Add the keys in Vercel

1. Vercel, the OneLink project, **Settings > Environment Variables**.
2. Add, for **Production** (and **Preview** if you added preview hostnames):

   | Variable | Value |
   | --- | --- |
   | `TURNSTILE_SITE_KEY` | the site key |
   | `TURNSTILE_SECRET_KEY` | the secret key; tick **Sensitive** |

3. **Redeploy** (Deployments, the latest production deploy, **Redeploy**), so
   the functions see the new variables.

The Content-Security-Policy in `main-site/vercel.json` already allows
`https://challenges.cloudflare.com` for scripts and frames; there is nothing
to change there.

## 3. Check it works

1. Open `https://links.gftv.asia/api/public/turnstile`. It answers
   `{"ok":true,"siteKey":"..."}` with your site key, not `null`.
2. Open `/register`. Under the password fields a Cloudflare box appears and
   turns to a tick within a second or two (sometimes it asks for a click).
   Create a test page: it goes through as before.
3. Open any public page, press **Report page**: the same box appears in the
   form. Send a test report and check it arrives under **Reports** in
   `/admin`.
4. Check the server refuses a sign-up without a token. From any terminal:

   ```sh
   curl -X POST https://links.gftv.asia/api/auth/register \
     -H "Origin: https://links.gftv.asia" -H "Content-Type: application/json" \
     -d '{"slug":"turnstile-test","password":"correct horse battery"}'
   ```

   The answer is `{"ok":false,"error":"human_check_failed"}`.
5. In Cloudflare, the widget's **Analytics** shows the checks.

## How it behaves

- **Before the keys are set** (or with only one of them): no widget, nothing
  checked. Vercel's function logs say once per instance
  `TURNSTILE_SECRET_KEY or TURNSTILE_SITE_KEY is not set: the Turnstile check
  is skipped`.
- **With both set:** a sign-up or report without a passed check is refused
  with "The check that you are a person did not pass". A token works once and
  for 300 seconds; the form resets the widget after every try, so a second
  attempt gets a fresh one.
- **If Cloudflare cannot be reached**, or rejects the secret key itself, the
  request goes through and the logs say `turnstile siteverify:` or
  `turnstile: invalid-input-secret`. The rate limits and connection bans still
  apply. Seeing either line means the keys or Cloudflare want a look.
- The widget follows the page's light or dark mode.

## Turning it off, or a leaked secret

- **Off:** delete both variables in Vercel and redeploy.
- **Secret leaked:** in Cloudflare, open the widget, **Rotate secret key**,
  put the new one in `TURNSTILE_SECRET_KEY`, and redeploy.
