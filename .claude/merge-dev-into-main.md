# Merging `dev` into `main`: OneLink GFTV

Context for whoever merges this repo's `dev` branch into `main`. Augy, give this file to Claude: "Read `.claude/merge-dev-into-main.md` and help me merge `dev` into `main`."

- **What's on `dev`:** the readable-refactor chain for help desk #17, one squash commit per job. 8 of 10 jobs have landed so far.
- **What merging does:** Merging into `main` deploys `main-site/` (pages and API) on Vercel.
- **Kept up to date:** the coordinator (Thomas's workspace) updates this file each time a job lands, and once more just before opening the pull request. Last updated 14 Nov, 10:08 SGT.

## Claude: how to run the merge

Work through these in order, and stop to ask Augy wherever a step says so.

1. **Read first:** this file, then `README.md`. Never read, print or copy a `.env` or `token.env` file; read `main-site/.env.example`.
2. **Check `dev` matches this file:** `git fetch origin`, then `git log --oneline origin/main..origin/dev`. Every commit in the Jobs table below should be there. Commits titled "Merge context" only update this file. Read the message of any other commit the table doesn't list (`git show <sha>`) and tell Augy what it is.
3. **Run the tests** on a checkout of `dev` (commands below). All must pass. If one fails, stop and tell Augy; don't fix it on `main`.
4. **Go through "Before merging"** with Augy. Steps marked as his (Vercel settings, the database) are his to do by hand; ask him to confirm each one.
5. **The pull request:** `gh pr list --base main --head dev`. Thomas's side opens it once the last job lands. If Augy wants to ship before that, open it yourself: `gh pr create --base main --head dev`, titled "Help desk #17: readable refactor", with the Jobs table as its body.
6. **Merge with a merge commit, never squash or rebase**: `gh pr merge <number> --merge`. Squashing would drop the one-commit-per-job history, and each commit's `Archived-As` line points to the job's full branch. Ask Augy before running it: **merging is deploying.**
7. **Go through "After merging"**, then the smoke test with Augy (unless this file says to run it before merging).
8. **If something breaks:** in Vercel, promote the previous production deployment to roll back at once. Then revert the merge on `main` through a pull request (`git revert -m 1 <merge sha>`), and tell Thomas. Never force-push.

## Jobs

| Job | What it does | On `dev` |
|---|---|---|
| 01 | Ids and reply tests | `0c0841f` |
| 02 | Playwright for every page | `f558bf3` |
| 03 | Rename the shared short helpers | `c992324` |
| 04 | Readability: api/_lib | `0e98bb5` |
| 05 | Readability: API routes | to come |
| 06 | Readability: the admin dashboard | `5a6f251` |
| 07 | Readability: the editor and picture editor | `06a8134` |
| 08 | Readability: other pages and browser helpers | `a1b5bd1` |
| 09 | Readability: service worker, scripts and tools | `1b5c507` |
| 10 | Lint config and final check | to come |

Each job's commit message lists what changed and how it was reviewed. The full branch is kept at `refs/archive/<job-id>`: `git fetch origin 'refs/archive/*:refs/archive/*'` to see them.

## Tests

```bash
cd main-site
npm ci
npm test             # unit and API tests on the fake database
npm run e2e          # Playwright: needs Playwright + Chromium where Node finds them
npm run check-i18n
npm run check-sw
```

They need no `.env`, network or real database.

## Before merging

- **Service worker:** `main-site/sw.js`'s `VERSION` must differ from `main`'s (job 10 bumps it). If it doesn't, bump it in a commit on `dev` first.
- **`main` moved?** Augy pushes to `main` directly. If `main` has commits `dev` doesn't, merge `main` into `dev` and re-run the tests first.
- No new environment variables or migrations come with this chain.

## After merging

- Nothing by hand beyond the smoke test.

## Smoke test on the live site

The tests can't reach the real database, logins or messaging, so check these by hand after the deploy:

- The home page, a public page `/<name>` (links, testimonials, report) and `/team` load, signed out.
- Sign in as a page owner with the second factor; edit the page and its links; open the picture editor; check stats.
- Sign in as staff: every admin tab loads (admin and editor).
- A password reset starts (Telegram, if linked).
- Real Supabase, Telegram, production Turnstile and passkeys: the tests can't reach these.

## What users may notice

- None meant: the chain only tidies ids no page uses and rewrites the code for readability. Users see the update bar once, because the service worker version changes.

Open questions and anything left for later are on help desk #17's review page, not here.
