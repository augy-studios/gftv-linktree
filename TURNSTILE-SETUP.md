# Setting up Cloudflare Turnstile

Turnstile is Cloudflare's "are you a person" check. OneLink uses it on four
forms, each with its own action name:

| Form | Page | Action | Route |
| --- | --- | --- | --- |
| Sign-up | `/register` | `register` | `POST /api/auth/register` |
| Sign-in, password step | `/login` | `login` | `POST /api/auth/login` |
| Password reset, first step | `/reset` | `recover` | `POST /api/auth/recover` (`start`) |
| Report a page or link | any public page | `report` | `POST /api/public/report` |

A token made on one form is refused by the others. On a public page
Cloudflare's script loads only when someone opens the report form, never just
for reading the page. The staff sign-in at `/admin`, and everything behind a
session, has no widget.

The widget already exists in Cloudflare (Help desk #9), and its **site key**
is in the code (`SITE_KEY` in `main-site/api/_lib/turnstile.js`). The
**secret key** is set in Vercel and nowhere else.

## 1. Check the widget in Cloudflare

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com), open
   **Turnstile** (in newer dashboards under **Application security**), and open
   the OneLink widget (site key `0x4AAAAAAFlkl5LtUMQYO1DZ`).
2. **Hostnames** must include `links.gftv.asia`. Add any Vercel preview
   address you want the widget to work on as well.
3. Copy the **Secret key**. It is a secret: keep it out of chats, tickets and
   the repository.

## 2. Add the variables in Vercel

1. Vercel, the OneLink project, **Settings > Environment Variables**.
2. Add, for **Production**:

   | Variable | Value |
   | --- | --- |
   | `TURNSTILE_SECRET` | the secret key; tick **Sensitive** |
   | `TURNSTILE_HOSTNAMES` | `links.gftv.asia` |

   `TURNSTILE_HOSTNAMES` is the comma-separated list of hostnames a token may
   come from. Left out, it is the hostname of `SITE_URL`. In production
   `localhost` and `127.0.0.1` are ignored even if listed.

   `TURNSTILE_SITE_KEY` is not needed: it only overrides the site key in the
   code (with Cloudflare's test key `1x00000000000000000000AA`, say). The older
   name `TURNSTILE_SECRET_KEY` still works for the secret, but use
   `TURNSTILE_SECRET`.

3. **Redeploy** (Deployments, the latest production deploy, **Redeploy**), so
   the functions see the new variables.

Set the secret before the code that needs it reaches production: without it,
production refuses sign-ups, sign-ins, resets and reports (see below).

The Content-Security-Policy in `main-site/vercel.json` already allows
`https://challenges.cloudflare.com` for scripts and frames.

## 3. Check it works

1. Open `https://links.gftv.asia/api/public/turnstile`. It answers
   `{"ok":true,"siteKey":"0x4AAAAAAFlkl5LtUMQYO1DZ"}`.
2. Open `/register`. Under the password fields a Cloudflare box appears and
   turns to a tick within a second or two (sometimes it asks for a click).
   Create a test page: it goes through as before.
3. Sign in at `/login` and start a reset at `/reset`: the same box appears,
   and each goes through.
4. Open any public page, press **Report page**: the box appears in the form.
   Send a test report and check it arrives under **Reports** in `/admin`.
5. Check the server refuses a sign-up without a token. From any terminal:

   ```sh
   curl -X POST https://links.gftv.asia/api/auth/register \
     -H "Origin: https://links.gftv.asia" -H "Content-Type: application/json" \
     -d '{"slug":"turnstile-test","password":"correct horse battery"}'
   ```

   The answer is `{"ok":false,"error":"human_check_failed"}` (HTTP 403). If it
   is `human_check_unavailable` (HTTP 503), the secret is missing or wrong:
   see the logs.
6. In Cloudflare, the widget's **Analytics** shows the checks.

## How it behaves

The browser sends the token as `cf-turnstile-response`.
`api/_lib/turnstile.js` posts it, with the secret and the visitor's address,
to Cloudflare's siteverify (10 second timeout), and accepts it only when
Cloudflare says `success`, the token's action is the form's, and its hostname
is in `TURNSTILE_HOSTNAMES`. The rest of the route runs unchanged after that.

| Situation | Answer | Log line |
| --- | --- | --- |
| Token passes | the form works as before | none |
| No token, a refused token, a used or expired one, another form's, another hostname's | 403 `human_check_failed`: "The check that you are a person did not pass" | wrong action or hostname only |
| Cloudflare cannot be reached or times out | 503 `human_check_unavailable`: "...is not working right now" | `turnstile siteverify:` |
| Cloudflare refuses the secret | 503 `human_check_unavailable` | `turnstile: invalid-input-secret` |
| Production (`VERCEL_ENV=production`) with no secret | 503 `human_check_unavailable` | none |
| `TURNSTILE_SECRET=off`, anywhere | no widget, nothing checked | once per instance: `TURNSTILE_SECRET is "off"` |
| Local runs and Vercel previews with no secret | no widget, nothing checked | once per instance: `TURNSTILE_SECRET is not set: the Turnstile check is skipped` |

Why it fails closed: when Cloudflare is down the browser cannot get a token
either, so letting requests through would only help scripts; and a missing
or wrong secret in production shows up at once instead of leaving the forms
open. Tokens and addresses are never logged.

- A token works once and for 300 seconds; each form resets the widget after
  every try, so a second attempt gets a fresh one.
- The widget follows the page's light or dark mode.
- Previews: without `TURNSTILE_SECRET` in the Preview environment, previews
  skip the check. Keep Vercel's Deployment Protection on for previews if
  they use the production database. To check on previews too, add the secret
  for Preview, the preview hostnames in Cloudflare, and the same hostnames in
  a Preview `TURNSTILE_HOSTNAMES`.

## Turning it off, or a leaked secret

- **Off** (Cloudflare down for long, say): set `TURNSTILE_SECRET` to `off`
  and redeploy. The widget goes away and nothing is checked; the logs say
  `TURNSTILE_SECRET is "off"`. Put the secret back the same way. Deleting
  the variable does not switch it off in production: everything protected
  would be refused.
- **Secret leaked:** in Cloudflare, open the widget, **Rotate secret key**,
  put the new one in `TURNSTILE_SECRET`, and redeploy.
