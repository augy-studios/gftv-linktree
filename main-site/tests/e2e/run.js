// Browser tests: npm run e2e (from main-site/).
//
// Drives the real pages in Chromium against tests/e2e/server.js. Needs
// Playwright with Chromium where Node can find it (npm i -g playwright &&
// npx playwright install chromium); it is not a dependency of the site.
// Screenshots go to tests/e2e/out/ (ignored by git). Fails on any failed
// check, page error, console error (including a CSP violation) or 5xx.
//
// The checks at the end open every page (home, sign-up, sign-in, reset,
// privacy, /team, the 404 page, a public page, the editor's tabs) and every
// tab of the staff dashboard, as an editor and as an admin.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { startServer } from './server.js';
import { forgetReviewPatterns } from '../../api/_lib/guards.js';
import { randomToken, sha256 } from '../../api/_lib/crypto.js';
import { OWNER_COOKIE } from '../../api/_lib/session.js';
import { totpAt } from '../../api/_lib/totp.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = new URL('./out/', import.meta.url);
fs.mkdirSync(OUT, { recursive: true });
const shot = (name) => new URL(`${name}.png`, OUT).pathname;

const server = await startServer();
const BASE = server.url;
const problems = [];
let step = 0;
const ok = (message) => console.log(`ok ${++step} - ${message}`);

async function context(b, who, opts = {}) {
  const c = await b.newContext({ viewport: { width: 420, height: 860 }, ...opts });
  if (who) await c.addCookies(server.cookies[who].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' })));
  return c;
}
// Console errors fail the run, apart from a resource that failed to load (a
// 5xx is counted by the response listener instead) and Google's tag's own
// messages. A Content-Security-Policy violation fails unless what it blocked is
// a Google address: Google's tag on public pages asks for an ads image the
// policy refuses, which is the policy working. Checking the blocked address,
// not the whole message, matters: the message quotes the full policy, which
// names googletagmanager.com, so a plain text match would hide every violation.
const GOOGLE_HOST = /(^|\.)(google\.[a-z.]+|googletagmanager\.com|google-analytics\.com|doubleclick\.net)$/;
function blockedHost(text) {
  const quoted = /'(https?:\/\/[^']+)'/.exec(text);
  if (quoted === null) {
    return null;
  }
  return new URL(quoted[1]).hostname;
}
function isIgnoredConsoleError(text) {
  if (text.includes('Content Security Policy')) {
    const host = blockedHost(text);
    return host !== null && GOOGLE_HOST.test(host);
  }
  if (text.startsWith('Failed to load resource')) {
    return true;
  }
  return /googletagmanager|gtag/.test(text);
}
function watch(page, label) {
  page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !isIgnoredConsoleError(m.text())) problems.push(`${label} console: ${m.text()}`);
  });
  // Any 5xx from the test server counts: the API, the page and its scripts and styles.
  page.on('response', (r) => { if (new URL(r.url()).hostname === 'localhost' && r.status() >= 500) problems.push(`${label} ${r.status()} ${r.url()}`); });
}
async function open(b, path, who = null, opts = {}) {
  const c = await context(b, who, opts);
  const page = await c.newPage();
  watch(page, path);
  await page.goto(`${BASE}${path}`);
  return page;
}
async function publicState(b) {
  const p = await open(b, '/augy');
  await p.waitForSelector('#profile h1');
  const state = { tick: await p.locator('.team-tick').count(), pill: (await p.locator('.team-pill').textContent().catch(() => null))?.trim() ?? null };
  await p.context().close();
  return state;
}
async function teamList(b) {
  const p = await open(b, '/team');
  await p.waitForSelector('#teamList:not([aria-busy])');
  const slugs = await p.locator('.team-member .handle').allTextContents();
  await p.context().close();
  return slugs;
}
const dialog = (a) => a.locator('#pageModalBody');

// ---------------------------------------------------------------------------
// Helpers for the smoke checks of every page and admin tab, at the end.
// ---------------------------------------------------------------------------

// A desktop browser's user agent. Playwright's own says HeadlessChrome, and
// the site rightly counts no visit from a headless browser.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const OWNER_PASSWORD = 'correct horse battery';
const STAFF_PASSWORD = 'staff password 1';

// The smoke checks pass only when nothing went wrong on any page while they
// ran: no page error, console error, CSP violation or 5xx since the last one.
let problemsSeen = 0;
function passed(message) {
  const fresh = problems.slice(problemsSeen);
  problemsSeen = problems.length;
  assert.deepEqual(fresh, [], `no page errors, console errors, CSP violations or 5xx during: ${message}`);
  ok(message);
}

// A watched page in a fresh context that has not opened anything yet.
// Anything addressed outside the test server (Google's tag on public pages,
// a link a visitor clicks) is answered here with an empty reply, so these
// checks never reach an outside service. watch() counts any 5xx from the test
// server, the page itself included.
async function localPage(browser, label, who = null, options = {}) {
  const browserContext = await context(browser, who, options);
  await browserContext.route((url) => url.hostname !== 'localhost', (route) => route.fulfill({ status: 204, body: '' }));
  const page = await browserContext.newPage();
  watch(page, label);
  return page;
}

// localPage, then open path on it.
async function openLocal(browser, path, who = null, options = {}) {
  const page = await localPage(browser, path, who, options);
  await page.goto(`${BASE}${path}`);
  return page;
}

// The answer from one API route, as a promise to wait on after the click
// that sends it. method, when given, picks one of several answers from the
// same route.
function answerFrom(page, apiPath, method = null) {
  return page.waitForResponse((response) => {
    if (method !== null && response.request().method() !== method) {
      return false;
    }
    return new URL(response.url()).pathname === apiPath;
  });
}

// Every page runs app.js first, which names the theme button for the mode in
// use. Once it has, the page's shared wiring and translations are in place.
async function pageReady(page) {
  await page.waitForSelector('#themeBtn[aria-label^="Theme, currently"]');
}

// Waits until the toast shows this text. The toast keeps its last words
// after it fades, so this waits for it to be showing as well.
async function waitForToast(page, text) {
  await page.waitForFunction((want) => {
    const toast = document.getElementById('toast');
    if (!toast) {
      return false;
    }
    if (toast.classList.contains('hidden')) {
      return false;
    }
    return toast.textContent === want;
  }, text);
}

// Waits until an element's text is exactly this.
async function waitForText(page, selector, text) {
  await page.waitForFunction(([target, want]) => {
    const element = document.querySelector(target);
    if (!element) {
      return false;
    }
    return element.textContent === want;
  }, [selector, text]);
}

// A switch is a see-through checkbox under its track, so it is pressed where
// a person presses it: on the switch itself, its label.
async function pressSwitch(checkbox) {
  await checkbox.locator('..').click();
}

// Opens a dashboard tab and waits until it is the panel showing.
async function openAdminTab(page, name) {
  await page.click(`#atab-${name}`);
  await page.waitForSelector(`#apanel-${name}:not([hidden])`);
}

// The dashboard tabs this staff member can see, by name.
async function visibleTabs(page) {
  return page.$$eval('#dashboard [role="tab"]', (tabs) => tabs.filter((tab) => !tab.hidden).map((tab) => tab.id.replace('atab-', '')));
}

// The overview cards, as { label: number shown }.
async function overviewCounts(page) {
  await page.waitForSelector('#stats:not([aria-busy])');
  return page.$$eval('#stats .stat', (cards) => {
    const counts = {};
    for (const card of cards) {
      counts[card.querySelector('.label').textContent] = card.querySelector('.value').textContent;
    }
    return counts;
  });
}

// The names of the buttons in each row of a dashboard list: an icon button's
// label, or a button's words.
async function rowButtons(page, listSelector) {
  return page.$$eval(`${listSelector} .data-row`, (rows) => rows.map((row) => [...row.querySelectorAll('button')].map((button) => {
    const label = button.getAttribute('aria-label');
    if (label) {
      return label;
    }
    return button.textContent.trim();
  })));
}

const b = await chromium.launch();
try {
  // Public page and /team before anything is verified.
  assert.deepEqual(await publicState(b), { tick: 0, pill: null });
  let p = await open(b, '/team');
  await p.waitForSelector('#teamList .empty-state');
  for (const path of ['/team', '/augy', '/', '/privacy', '/register', '/login']) {
    await p.goto(`${BASE}${path}`);
    assert.equal(await p.locator('.site-footer a[href="/team"]').textContent(), 'GFTV team', `footer link on ${path}`);
  }
  await p.context().close();
  ok('unverified: no mark on the page, /team says there are no team pages, and every page footer links to /team');

  // Link picker: VK, Weibo, Barq.
  const o = await open(b, '/edit', 'owner');
  await o.waitForSelector('#addLink:not([disabled])');
  await o.click('#addLink');
  await o.waitForSelector('#linkModal:not(.hidden)');
  const types = await o.locator('#linkType option').allTextContents();
  for (const name of ['VK', 'Weibo', 'Barq']) assert.ok(types.includes(name), name);
  await o.selectOption('#linkType', 'weibo');
  assert.equal(await o.textContent('#linkPrefix'), 'weibo.com/u/');
  await o.fill('#linkUsername', '1234567890');
  await o.click('#linkSave');
  await o.waitForSelector('#linkModal.hidden', { state: 'attached' });
  await o.click('#addLink');
  await o.selectOption('#linkType', 'barq');
  assert.equal(await o.textContent('#linkPrefix'), 'barq.app/@');
  await o.fill('#linkUsername', 'https://barq.app/@jianweit');
  await o.locator('#linkUsername').blur();
  assert.equal(await o.inputValue('#linkUsername'), 'jianweit', 'a pasted Barq link comes down to the username');
  await o.screenshot({ path: shot('edit-barq') });
  await o.click('#linkSave');
  await o.waitForSelector('#linkModal.hidden', { state: 'attached' });
  const saved = await o.evaluate(() => fetch('/api/me/page').then((r) => r.json()).then((d) => d.page.links.map((l) => [l.url, l.icon])));
  assert.deepEqual(saved.slice(1), [['https://weibo.com/u/1234567890', 'sinaweibo'], ['https://barq.app/@jianweit', 'barq']]);
  ok('owner adds Weibo and Barq links; a pasted barq.app/@ link becomes the username');

  // The owner's own testimonial speaks to them, not about them.
  await o.click('#tab-profile');
  await o.waitForSelector('#ownQuoteForm');
  await o.fill('#ownQuote', '');
  await o.check('#ownQuoteConsent');
  await o.click('#ownQuoteSend');
  await o.waitForFunction(() => document.getElementById('ownQuoteError').textContent.trim() !== '');
  assert.equal((await o.textContent('#ownQuoteError')).trim(), 'Write your testimonial first.');
  ok('an empty testimonial on your own page says "Write your testimonial first."');

  // Stats on a phone: a country name is never split inside a word, at any
  // width or text size. Each country gets one more visit than the last, so
  // it becomes the top country in turn.
  const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  let ip = 10;
  const countries = [['SG', 'Singapore'], ['LI', 'Liechtenstein'], ['BA', 'Bosnia & Herzegovina'], ['CF', 'Central African Republic']];
  for (const [n, [code, name]] of countries.entries()) {
    for (let i = 0; i <= n; i++) {
      const r = await o.request.post(`${BASE}/api/public/visit`, { headers: { origin: BASE, 'x-vercel-ip-country': code, 'x-forwarded-for': `198.51.100.${ip++}`, 'user-agent': PHONE_UA }, data: { slug: 'augy', referrer: '' } });
      assert.equal((await r.json()).counted, true, 'the visit is counted');
    }
    for (const width of [320, 360]) {
      for (const textSize of ['100%', '130%']) {
        await o.setViewportSize({ width, height: 800 });
        await o.goto(`${BASE}/edit`);
        await o.click('#tab-stats');
        // Larger text, as a phone set to a bigger font size gives. Set through
        // the DOM: the site's CSP refuses an injected stylesheet.
        await o.evaluate((size) => document.documentElement.style.setProperty('font-size', size, 'important'), textSize);
        await o.evaluate(() => window.dispatchEvent(new Event('resize')));
        await o.waitForFunction((want) => document.querySelector('#statsTiles .value.words')?.textContent === want, name);
        await o.waitForTimeout(100);
        const check = await o.$eval('#statsTiles .value.words', (value) => {
          const text = value.firstChild;
          const split = [];
          for (const m of text.data.matchAll(/\S+/g)) {
            const r = document.createRange();
            r.setStart(text, m.index);
            r.setEnd(text, m.index + m[0].length);
            if (new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1) split.push(m[0]);
          }
          return { split, overflow: value.scrollWidth > value.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > window.innerWidth };
        });
        assert.deepEqual(check, { split: [], overflow: false, pageOverflow: false }, `${name} at ${width}px, text ${textSize}`);
        if (width === 320 && textSize === '130%') await o.locator('#statsTiles').screenshot({ path: shot(`stats-${code}-320-large-text`) });
      }
    }
  }
  await o.context().close();
  ok('top country names (Singapore to Central African Republic) are never split inside a word, at 320px and 360px, normal and large text');

  // Admin verifies with a role.
  const a = await open(b, '/admin', 'boss', { viewport: { width: 1200, height: 900 } });
  await a.waitForSelector('#dashboard:not([hidden])');
  await a.click('#atab-pages');
  await a.waitForSelector('#pageList .data-row');
  await a.locator('#pageList .data-row', { hasText: '/augy' }).getByRole('button', { name: 'View' }).click();
  await a.waitForSelector('#pageModal:not(.hidden) .actions.inline');
  await dialog(a).getByRole('button', { name: 'Verify as GFTV team' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  assert.equal(await a.locator('#reasonLabel').textContent(), 'Role (optional), for example Moderator');
  assert.equal(await a.locator('#reasonText').getAttribute('maxlength'), '40');
  assert.match(await a.locator('#reasonText').getAttribute('class') || '', /single-line/);
  await a.fill('#reasonText', 'Moderator');
  await a.screenshot({ path: shot('admin-verify-dialog') });
  await a.click('#reasonSubmit');
  await a.waitForSelector('#pageModalBody .callout.ok');
  assert.match(await a.locator('#pageModalBody .callout.ok').textContent(), /Marked as GFTV team since/);
  assert.equal(await a.locator('#pageModalBody .badge.ok', { hasText: 'GFTV team · Moderator' }).count(), 1);
  assert.equal(await dialog(a).getByRole('button', { name: 'Change team role' }).count(), 1);
  assert.equal(await dialog(a).getByRole('button', { name: 'Remove team mark' }).count(), 1);
  await a.screenshot({ path: shot('admin-verified') });
  ok('admin verifies with a role; the dialog shows the badge, the date, and change/remove');

  // The public page shows it, in GFTV yellow.
  p = await open(b, '/augy');
  await p.waitForSelector('.team-pill');
  assert.equal((await p.textContent('.team-pill')).trim(), 'GFTV team · Moderator');
  const colours = await p.evaluate(() => ({
    ring: getComputedStyle(document.querySelector('.avatar-wrap.team .avatar')).boxShadow,
    tick: getComputedStyle(document.querySelector('.team-tick')).backgroundColor,
    pill: getComputedStyle(document.querySelector('.team-pill')).backgroundColor,
  }));
  assert.match(colours.ring, /rgb\(254, 220, 0\)/);
  assert.equal(colours.tick, 'rgb(254, 220, 0)');
  assert.equal(colours.pill, 'rgb(254, 220, 0)');
  const note = p.locator('.site-footer > #teamNote:first-child');
  assert.match(await note.textContent(), /GFTV staff confirmed on .* that this page belongs to someone on the GFTV team/, 'the explanation is at the top of the footer');
  assert.equal(await p.locator('#profile').getByText('GFTV staff confirmed').count(), 0, 'and not at the top of the page');
  await p.screenshot({ path: shot('public-verified-light') });
  await p.click('.team-pill');
  await p.waitForFunction(() => document.activeElement?.id === 'teamNote');
  await p.waitForFunction(() => { const r = document.getElementById('teamNote').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
  await p.screenshot({ path: shot('public-verified-footer-note') });
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'));
  await p.waitForTimeout(800); // the theme change fades
  await p.screenshot({ path: shot('public-verified-dark') });
  await p.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
  ok('public page: yellow ring, tick and label; the explanation sits at the top of the footer and the label jumps to it');

  await p.evaluate(() => document.activeElement.blur());
  await p.focus('.team-pill');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.activeElement?.id === 'teamNote');
  ok('the label jumps to the footer note from the keyboard too');

  await p.setViewportSize({ width: 320, height: 700 });
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await p.screenshot({ path: shot('public-verified-320') });
  ok('no sideways scroll at 320px');

  await p.setViewportSize({ width: 420, height: 860 });
  await p.click('#teamNote a[href="/team"]');
  await p.waitForURL(`${BASE}/team`);
  await p.waitForSelector('.team-member');
  assert.deepEqual(await p.locator('.team-member .handle').allTextContents(), ['links.gftv.asia/augy']);
  assert.equal(await p.locator('.team-member .role').textContent(), 'Moderator');
  await p.screenshot({ path: shot('team-list') });
  await p.setViewportSize({ width: 320, height: 700 });
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await p.locator('.team-member').click();
  await p.waitForURL(`${BASE}/augy`);
  await p.context().close();
  ok('the explanation links to /team, which lists the page with its role and links back');

  // Clearing the role.
  await dialog(a).getByRole('button', { name: 'Change team role' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  assert.equal(await a.inputValue('#reasonText'), 'Moderator', 'the current role is filled in');
  await a.fill('#reasonText', '');
  await a.click('#reasonSubmit');
  await a.waitForFunction(() => [...document.querySelectorAll('#pageModalBody .badge.ok')].some((x) => x.textContent === 'GFTV team'));
  assert.equal((await publicState(b)).pill, 'GFTV team');
  ok('clearing the role leaves a plain "GFTV team" mark');

  // The pages list filter.
  await a.click('#pageModal [data-close-modal="pageModal"]');
  await a.selectOption('#pageStatus', 'team');
  await a.waitForFunction(() => document.querySelectorAll('#pageList .data-row').length === 1);
  assert.match(await a.locator('#pageList .data-row').textContent(), /\/augy/);
  await a.selectOption('#pageStatus', '');
  await a.waitForFunction(() => document.querySelectorAll('#pageList .data-row').length === 2);
  ok('the "GFTV team" filter lists only verified pages');

  // Removing the mark.
  await a.locator('#pageList .data-row', { hasText: '/augy' }).getByRole('button', { name: 'View' }).click();
  await a.waitForSelector('#pageModal:not(.hidden) .actions.inline');
  await dialog(a).getByRole('button', { name: 'Remove team mark' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  assert.ok(await a.locator('#reasonTextRow').isHidden(), 'no text box when removing');
  await a.click('#reasonSubmit');
  await a.waitForSelector('#pageModalBody >> text=Verify as GFTV team');
  assert.equal((await publicState(b)).tick, 0);
  p = await open(b, '/augy');
  await p.waitForSelector('#profile h1');
  assert.equal(await p.locator('#teamNote').count(), 0, 'no footer note without the mark');
  await p.context().close();
  assert.deepEqual(await teamList(b), []);
  ok('removing the mark takes it off the page and off /team');

  // A take down clears it, and restoring does not bring it back.
  await dialog(a).getByRole('button', { name: 'Verify as GFTV team' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  assert.equal(await a.inputValue('#reasonText'), '');
  assert.ok(await a.locator('#reasonTextRow').isVisible(), 'the text box is back after the removal dialog');
  await a.click('#reasonSubmit');
  await a.waitForSelector('#pageModalBody .callout.ok');
  await dialog(a).getByRole('button', { name: 'Take down' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  assert.equal(await a.locator('#reasonText').getAttribute('maxlength'), '500');
  assert.equal(await a.locator('#reasonLabel').textContent(), 'Reason');
  assert.doesNotMatch(await a.locator('#reasonText').getAttribute('class') || '', /single-line/);
  await a.fill('#reasonText', 'test');
  await a.click('#reasonSubmit');
  await a.waitForSelector('#pageModalBody >> text=Restore');
  assert.equal(await dialog(a).getByRole('button', { name: /team/i }).count(), 0, 'no team buttons on a taken-down page');
  await dialog(a).getByRole('button', { name: 'Restore' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  await a.click('#reasonSubmit');
  await a.waitForSelector('#pageModalBody >> text=Verify as GFTV team');
  assert.equal((await publicState(b)).tick, 0);
  ok('a take down clears the mark and restoring the page does not bring it back');

  // Editors.
  const e = await open(b, '/admin', 'ed', { viewport: { width: 1200, height: 900 } });
  await e.waitForSelector('#dashboard:not([hidden])');
  await e.click('#atab-pages');
  await e.waitForSelector('#pageList .data-row');
  await e.locator('#pageList .data-row', { hasText: '/augy' }).getByRole('button', { name: 'View' }).click();
  await e.waitForSelector('#pageModal:not(.hidden) .actions.inline', { state: 'attached' });
  assert.equal(await dialog(e).getByRole('button', { name: /team/i }).count(), 0);
  assert.ok(await e.locator('#atab-team').isHidden(), 'editors have no Team tab');
  const status = await e.evaluate(() => fetch('/api/admin/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify', id: '00000000-0000-4000-8000-000000000000' }) }).then((r) => r.status));
  assert.equal(status, 403);
  await e.context().close();
  ok('editors see no team buttons and the API refuses them');

  // The Team tab.
  await a.keyboard.press('Escape');
  await a.waitForSelector('#pageModal.hidden', { state: 'attached' });
  await a.click('#atab-team');
  await a.waitForSelector('#adminTeamList .empty-state');
  assert.equal(await a.textContent('#adminTeamList .empty-state'), 'Nobody is marked as GFTV team yet.');
  const teamRows = () => a.locator('#adminTeamList .team-row');
  const addTeam = async (slug, role = '') => {
    await a.fill('#teamAddSlug', slug);
    await a.fill('#teamAddRole', role);
    await a.click('#teamAddSubmit');
  };
  await addTeam('');
  assert.equal(await a.textContent('#teamAddError'), 'Type the page name of the person to add.');
  await addTeam('nobody');
  await a.waitForFunction(() => document.getElementById('teamAddError').textContent === 'There is no page with that name.');
  await addTeam('https://links.gftv.asia/augy/', 'Moderator');
  await a.waitForFunction(() => document.querySelectorAll('#adminTeamList .team-row').length === 1);
  assert.equal(await a.textContent('#teamAddError'), '');
  assert.equal(await a.inputValue('#teamAddSlug'), '', 'the form clears');
  assert.match(await teamRows().first().textContent(), /\/augy.*Moderator · since/);
  await addTeam('rando');
  await a.waitForFunction(() => document.querySelectorAll('#adminTeamList .team-row').length === 2);
  assert.equal(await a.textContent('#adminTeamTitle'), 'On the team: 2 pages');
  assert.deepEqual(await a.locator('#adminTeamList .team-row .primary a').allTextContents(), ['/augy', '/rando'], 'listed by name');
  assert.match(await teamRows().nth(1).textContent(), /No role/);
  await addTeam('augy', 'Intern');
  await a.waitForFunction(() => document.getElementById('teamAddError').textContent.startsWith('That page is already marked as GFTV team.'));
  assert.match(await teamRows().first().textContent(), /Moderator/, 'adding again did not overwrite the role');
  await a.fill('#teamQuery', 'ran');
  await a.press('#teamQuery', 'Enter');
  await a.waitForFunction(() => document.querySelectorAll('#adminTeamList .team-row').length === 1);
  assert.match(await teamRows().first().textContent(), /\/rando/);
  await a.fill('#teamQuery', 'zzz');
  await a.press('#teamQuery', 'Enter');
  await a.waitForSelector('#adminTeamList .empty-state');
  assert.equal(await a.textContent('#adminTeamList .empty-state'), 'No team pages match that search.');
  await a.fill('#teamQuery', '');
  await a.press('#teamQuery', 'Enter');
  await a.waitForFunction(() => document.querySelectorAll('#adminTeamList .team-row').length === 2);
  await teamRows().nth(1).getByRole('button', { name: 'Change team role' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  await a.fill('#reasonText', 'Designer');
  await a.click('#reasonSubmit');
  await a.waitForFunction(() => /Designer/.test(document.querySelectorAll('#adminTeamList .team-row')[1]?.textContent || ''));
  await a.screenshot({ path: shot('admin-team-tab') });
  await a.setViewportSize({ width: 390, height: 844 });
  assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
  await a.screenshot({ path: shot('admin-team-tab-phone'), fullPage: true });
  await a.setViewportSize({ width: 1200, height: 900 });
  assert.deepEqual(await teamList(b), ['links.gftv.asia/augy', 'links.gftv.asia/rando'], 'the public list matches');
  await teamRows().nth(1).getByRole('button', { name: 'Remove team mark' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  await a.click('#reasonSubmit');
  await a.waitForFunction(() => document.querySelectorAll('#adminTeamList .team-row').length === 1);
  assert.equal(await a.textContent('#adminTeamTitle'), 'On the team: 1 page');
  assert.deepEqual(await teamList(b), ['links.gftv.asia/augy']);
  await teamRows().first().getByRole('button', { name: 'View page' }).click();
  await a.waitForSelector('#pageModalBody .callout.ok');
  await dialog(a).getByRole('button', { name: 'Remove team mark' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  await a.click('#reasonSubmit');
  await a.waitForSelector('#pageModalBody >> text=Verify as GFTV team');
  await a.waitForSelector('#adminTeamList .empty-state');
  ok('Team tab: add by name or pasted address, clear errors, never overwrites a role, search, change and remove roles, sorted by name, phone width, and the dialog keeps it in step');

  // Chinese.
  await dialog(a).getByRole('button', { name: 'Verify as GFTV team' }).click();
  await a.waitForSelector('#reasonModal:not(.hidden)');
  await a.click('#reasonSubmit');
  await a.waitForSelector('#pageModalBody .callout.ok');
  p = await open(b, '/augy', null, { locale: 'zh-CN' });
  await p.waitForSelector('.team-pill');
  const zh = (await p.textContent('.team-pill')).trim();
  await p.screenshot({ path: shot('public-zh') });
  await p.context().close();
  ok(`in a Chinese browser the pill reads "${zh}"`);

  // Renaming, last: everything above uses /augy.
  server.fake.table('gftvonelink_review_patterns').push({ id: crypto.randomUUID(), pattern: 'furcon', reason: null, created_at: new Date().toISOString() });
  forgetReviewPatterns();
  // The take down above signed the owner out everywhere: a fresh session.
  const augy = server.fake.table('gftvonelink_pages').find((x) => x.slug === 'augy');
  const token = randomToken(32);
  server.fake.table('gftvonelink_sessions').push({ id: crypto.randomUUID(), page_id: augy.id, token_hash: sha256(token), expires_at: new Date(Date.now() + 86400_000).toISOString(), last_seen_at: new Date().toISOString(), created_at: new Date().toISOString() });
  server.cookies.renamer = [[OWNER_COOKIE, token]];
  const r = await open(b, '/edit', 'renamer', { viewport: { width: 390, height: 844 } });
  await r.waitForSelector('#addLink:not([disabled])');
  await r.click('#tab-security');
  await r.waitForSelector('#renameSection:not([hidden])');
  assert.equal(await r.textContent('#renameState'), 'links.gftv.asia/augy');
  await r.click('#renameOpen');
  await r.waitForSelector('#renameModal:not(.hidden)');
  const renameStatus = async (name) => {
    await r.evaluate(() => document.getElementById('renameStatus').replaceChildren());
    await r.fill('#renameSlug', name);
    await r.waitForFunction(() => { const s = document.getElementById('renameStatus'); return s.textContent && !s.querySelector('.spinner'); });
    return { text: (await r.textContent('#renameStatus')).trim(), tone: await r.getAttribute('#renameStatus', 'class') };
  };
  assert.equal((await renameStatus('augy')).text, 'That is already your page name.');
  assert.equal((await renameStatus('rando')).text, 'That name is taken. Try another.');
  const review = await renameStatus('sgfurcon');
  assert.match(review.text, /checks names like this one/);
  assert.match(review.tone, /warn/);
  assert.match((await renameStatus('augy-fox')).tone, /ok/);
  await r.fill('#renamePassword', 'correct horse battery');
  assert.ok(await r.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
  await r.screenshot({ path: shot('edit-rename') });
  await r.click('#renameSubmit');
  await r.waitForSelector('#renameModal.hidden', { state: 'attached' });
  assert.equal(await r.textContent('#renameState'), 'links.gftv.asia/augy-fox');
  assert.equal(await r.isDisabled('#renameOpen'), true, 'once every 30 days');
  assert.match(await r.textContent('#renameNote'), /links\.gftv\.asia\/augy are sent here until/);
  assert.match(await r.textContent('#pageUrl'), /\/augy-fox$/);
  await r.screenshot({ path: shot('edit-renamed'), fullPage: true });
  await r.goto(`${BASE}/augy`);
  await r.waitForSelector('#profile h1');
  assert.equal(new URL(r.url()).pathname, '/augy-fox', 'the old address sends visitors on');
  await r.context().close();
  ok('owner renames the page from Security: own, taken and review names are flagged as typed, and the old address sends visitors on');

  // ---------------------------------------------------------------------------
  // Every page and admin tab. Smoke checks that each page opens and its main
  // parts work, after the checks above (which count exactly two pages, so the
  // pages made here come after them). Each fails on any page error, console
  // error (including a CSP violation) or 5xx while it ran.
  //
  // Where things stand now: /augy is /augy-fox, marked as GFTV team with no
  // role, with VK, Weibo and Barq links and ten counted visits; /rando has
  // one VK link; the owner sessions above have ended.
  // ---------------------------------------------------------------------------
  problemsSeen = problems.length;

  // Home: the claim field checks a name as it is typed and hands it on to
  // sign-up; the insight tiles show the site's totals; one question open at
  // a time. Reduced motion, so the numbers do not count up.
  const home = await openLocal(b, '/', null, { reducedMotion: 'reduce' });
  await pageReady(home);
  await home.fill('#claimSlug', 'rando');
  await waitForText(home, '#claimStatus', 'That name is taken. Try another.');
  await home.fill('#claimSlug', 'Newcomer');
  await waitForText(home, '#claimStatus', 'links.gftv.asia/newcomer is free');
  assert.equal(await home.inputValue('#claimSlug'), 'newcomer', 'the name is put in lower case');
  await home.locator('#insightTiles').scrollIntoViewIfNeeded();
  await home.waitForSelector('#insightTiles.in-view');
  assert.equal(await home.textContent('#tileVisits'), '10', 'the ten visits counted above');
  assert.equal(await home.textContent('#tileClicks'), '0');
  assert.equal(await home.textContent('#tileSource'), '2', 'with no referring site yet, the number of live pages');
  assert.equal(await home.textContent('#tileSourceLabel'), 'pages live');
  const questions = home.locator('.faq details');
  await questions.nth(0).locator('summary').click();
  await home.waitForFunction(() => document.querySelectorAll('.faq details')[0].open);
  await questions.nth(1).locator('summary').click();
  await home.waitForFunction(() => {
    const all = document.querySelectorAll('.faq details');
    if (!all[1].open) {
      return false;
    }
    return !all[0].open;
  });
  await home.screenshot({ path: shot('home'), fullPage: true });
  await home.click('#claimForm button[type="submit"]');
  await home.waitForURL(`${BASE}/register?slug=newcomer`);
  passed('home: the claim field says whether a name is taken or free as it is typed, and hands it to sign-up; the insight tiles show the site totals; one question opens at a time');

  // Sign-up, carrying on from the home page: the password rules, then an
  // authenticator code worked out here from the secret the page shows, then
  // ten backup codes, and on to the editor, signed in.
  const signUp = home;
  await pageReady(signUp);
  await signUp.waitForSelector('#stepAccount:not([hidden])');
  assert.equal(await signUp.inputValue('#slug'), 'newcomer', 'the name from the home page is filled in');
  await waitForText(signUp, '#slugStatus', 'links.gftv.asia/newcomer is free');
  await signUp.fill('#password', 'too short');
  await signUp.fill('#passwordConfirm', 'too short');
  await signUp.click('#accountSubmit');
  assert.equal(await signUp.textContent('#accountError'), 'Use at least 10 characters.');
  await signUp.fill('#password', OWNER_PASSWORD);
  await signUp.fill('#passwordConfirm', 'a different password');
  await signUp.click('#accountSubmit');
  assert.equal(await signUp.textContent('#accountError'), 'The two passwords do not match.');
  await signUp.fill('#passwordConfirm', OWNER_PASSWORD);
  await signUp.click('#accountSubmit');
  await signUp.waitForSelector('#stepFactor:not([hidden])');
  await signUp.waitForFunction(() => document.getElementById('totpSecret').textContent.trim() !== '');
  assert.equal(await signUp.locator('#totpQr svg').count(), 1, 'a QR code for the authenticator app');
  const newcomerSecret = (await signUp.textContent('#totpSecret')).replace(/\s+/g, '');
  await signUp.fill('#totpCode', totpAt(newcomerSecret));
  await signUp.click('#totpSubmit');
  await signUp.waitForSelector('#stepCodes:not([hidden])');
  assert.equal(await signUp.locator('#backupCodes li').count(), 10, 'ten backup codes');
  assert.equal(await signUp.getAttribute('#codesDone', 'aria-disabled'), 'true', 'not until the codes are saved');
  await signUp.check('#codesSaved');
  assert.equal(await signUp.getAttribute('#codesDone', 'aria-disabled'), 'false');
  await signUp.screenshot({ path: shot('register-codes') });
  await signUp.click('#codesDone');
  await signUp.waitForURL(`${BASE}/edit`);
  await signUp.waitForSelector('#editorReady:not([hidden])');
  assert.match(await signUp.textContent('#pageUrl'), /\/newcomer$/);
  await signUp.context().close();
  passed('sign-up: too short and mismatched passwords are caught, then a name, a password and an authenticator code make the page, with ten backup codes, and open its editor');

  // Sign-in: a wrong password is refused; the password and an authenticator
  // code open the editor.
  const signIn = await openLocal(b, '/login?slug=newcomer');
  await pageReady(signIn);
  assert.equal(await signIn.inputValue('#slug'), 'newcomer', 'the name from the address is filled in');
  await signIn.fill('#password', 'not the password at all');
  await signIn.click('#passwordSubmit');
  await waitForText(signIn, '#passwordError', 'That page name and password do not match.');
  await signIn.fill('#password', OWNER_PASSWORD);
  await signIn.click('#passwordSubmit');
  await signIn.waitForSelector('#stepFactor:not([hidden])');
  assert.equal(await signIn.getAttribute('#methodPicker [data-method="totp"]', 'aria-pressed'), 'true', 'the authenticator app comes first');
  assert.ok(await signIn.locator('#methodPicker [data-method="telegram"]').isHidden(), 'no Telegram, which this page has not linked');
  await signIn.fill('#code', totpAt(newcomerSecret));
  await signIn.click('#codeSubmit');
  await signIn.waitForURL(`${BASE}/edit`);
  await signIn.waitForSelector('#editorReady:not([hidden])');
  assert.match(await signIn.textContent('#pageUrl'), /\/newcomer$/);
  await signIn.context().close();
  passed('sign-in: a wrong password is refused, then the password and an authenticator code open the editor');

  // Password reset: a name with no page, then a page with no Telegram linked,
  // which is told it cannot be reset. Nothing is sent anywhere.
  const reset = await openLocal(b, '/reset');
  await pageReady(reset);
  await reset.fill('#slug', 'nobody-here');
  await reset.click('#findSubmit');
  await waitForText(reset, '#findError', 'There is no page with that name.');
  await reset.fill('#slug', 'newcomer');
  await reset.click('#findSubmit');
  await reset.waitForSelector('#stepNoTelegram:not([hidden])');
  assert.equal(await reset.textContent('#stepNoTelegram h1'), 'This page cannot be reset');
  assert.ok(await reset.locator('#stepReset').isHidden());
  await reset.screenshot({ path: shot('reset-no-telegram') });
  await reset.context().close();
  passed('password reset: an unknown name is refused, and a page without Telegram is told it cannot be reset');

  // Privacy, /team and the 404 page.
  const privacy = await openLocal(b, '/privacy');
  await pageReady(privacy);
  assert.equal(await privacy.textContent('h1'), 'Privacy at OneLink');
  await privacy.screenshot({ path: shot('privacy'), fullPage: true });
  await privacy.context().close();
  const teamPage = await openLocal(b, '/team');
  await pageReady(teamPage);
  await teamPage.waitForSelector('#teamList:not([aria-busy])');
  assert.deepEqual(await teamPage.locator('.team-member .handle').allTextContents(), ['links.gftv.asia/augy-fox'], 'the team page under its new name');
  assert.equal(await teamPage.locator('.team-member .role').count(), 0, 'with no role');
  await teamPage.context().close();
  const missing = await localPage(b, '/nobody-here');
  const missingResponse = await missing.goto(`${BASE}/nobody-here`);
  assert.equal(missingResponse.status(), 404);
  await pageReady(missing);
  assert.equal(await missing.textContent('h1'), 'Page not found uwu');
  await missing.waitForSelector('a[href="/register?slug=nobody-here"]');
  await missing.screenshot({ path: shot('not-found') });
  await missing.context().close();
  passed('privacy, /team (the team page under its new name) and the 404 page, which offers the missing name for sign-up');

  // A public page: its link, a visit and a click counted for the owner's
  // insights (in a desktop browser, since headless ones are not counted),
  // the share dialog, and reports on the whole page and on one link, with no
  // Turnstile while the check is off.
  const visitor = await localPage(b, '/rando', null, { userAgent: DESKTOP_UA });
  const outside = [];
  visitor.on('request', (request) => {
    if (new URL(request.url()).hostname !== 'localhost') {
      outside.push(request.url());
    }
  });
  const visitCounted = answerFrom(visitor, '/api/public/visit');
  await visitor.goto(`${BASE}/rando`);
  await pageReady(visitor);
  await visitor.waitForSelector('#profile h1');
  assert.deepEqual(await (await visitCounted).json(), { ok: true, counted: true }, 'the visit is counted');
  const linkButtons = visitor.locator('#profile .link-btn');
  assert.deepEqual(await linkButtons.locator('.link-title').allTextContents(), ['VK']);
  assert.equal(await linkButtons.first().getAttribute('href'), 'https://vk.com/rando');
  assert.equal(await linkButtons.first().getAttribute('rel'), 'noopener noreferrer nofollow');
  // The browser's own navigation is cancelled before the link's handler
  // runs, so the click is counted but nothing outside opens.
  await visitor.evaluate(() => document.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true }));
  const clickCounted = answerFrom(visitor, '/api/public/click');
  await linkButtons.first().click();
  assert.equal((await clickCounted).status(), 200, 'the click is counted');
  await visitor.getByRole('button', { name: 'Share', exact: true }).click();
  await visitor.waitForSelector('#shareModal:not(.hidden)');
  assert.equal(await visitor.locator('#shareQr svg').count(), 1, 'a QR code');
  assert.equal(await visitor.textContent('#shareUrl'), `${new URL(BASE).host}/rando`);
  await visitor.click('[data-close-modal="shareModal"]');
  await visitor.waitForSelector('#shareModal.hidden', { state: 'attached' });
  await visitor.getByRole('button', { name: 'Report page' }).click();
  await visitor.waitForSelector('#reportModal:not(.hidden)');
  assert.equal(await visitor.textContent('#reportWhat'), 'You are reporting the page links.gftv.asia/rando.');
  await visitor.selectOption('#reportReason', 'spam');
  await visitor.fill('#reportDetails', 'Smoke test: a report on the whole page.');
  await visitor.screenshot({ path: shot('public-report'), animations: 'disabled' });
  const pageReported = answerFrom(visitor, '/api/public/report');
  await visitor.click('#reportSubmit');
  assert.equal((await pageReported).status(), 200);
  await visitor.waitForSelector('#reportModal.hidden', { state: 'attached' });
  await waitForToast(visitor, 'Thank you. The GFTV team will take a look.');
  await visitor.getByRole('button', { name: 'Report VK' }).click();
  await visitor.waitForSelector('#reportModal:not(.hidden)');
  assert.equal(await visitor.textContent('#reportWhat'), 'You are reporting the link "VK".');
  await visitor.selectOption('#reportReason', 'scam');
  const linkReported = answerFrom(visitor, '/api/public/report');
  await visitor.click('#reportSubmit');
  assert.equal((await linkReported).status(), 200);
  await visitor.waitForSelector('#reportModal.hidden', { state: 'attached' });
  assert.equal(await visitor.locator('#reportCheck iframe').count(), 0, 'no Turnstile widget while the check is off');
  assert.deepEqual(outside.filter((address) => !address.startsWith('https://www.googletagmanager.com/')), [], 'nothing but the Google tag is asked for outside the site');
  await visitor.context().close();
  passed('public page /rando: its link, a counted visit and click, the share dialog with its QR code, and reports on the page and on a link');

  // The editor, as the owner of /rando, with a fresh session.
  server.seedOwnerSession('rando', 'randoOwner');
  const editor = await openLocal(b, '/edit', 'randoOwner');
  await pageReady(editor);
  await editor.waitForSelector('#editorReady:not([hidden])');
  assert.match(await editor.textContent('#pageUrl'), /\/rando$/);

  // Links: the redirect switch opens its address field and closes it again
  // without saving; then a link is added, edited, moved up (and saved in that
  // order), hidden and shown, and deleted.
  assert.equal(await editor.textContent('#linkCapUsage'), '1 of 20 links used');
  assert.match(await editor.locator('#linkList .edit-link').first().textContent(), /1 click/, 'the click on the public page');
  assert.equal(await editor.textContent('#redirectState'), 'Off: visitors see your links');
  await pressSwitch(editor.locator('#redirectToggle'));
  await editor.waitForSelector('#redirectForm:not([hidden])');
  assert.ok(await editor.isChecked('#redirectToggle'));
  await pressSwitch(editor.locator('#redirectToggle'));
  await editor.waitForSelector('#redirectForm[hidden]', { state: 'attached' });
  assert.ok(!(await editor.isChecked('#redirectToggle')));
  await editor.click('#addLink');
  await editor.waitForSelector('#linkModal:not(.hidden)');
  assert.equal(await editor.textContent('#linkModalTitle'), 'Add a link');
  await editor.fill('#linkUrl', 'https://example.com/rando-shop');
  await editor.fill('#linkTitle', 'Shop');
  await editor.click('#linkSave');
  await editor.waitForSelector('#linkModal.hidden', { state: 'attached' });
  await waitForToast(editor, 'Link added');
  await editor.getByRole('button', { name: 'Edit Shop', exact: true }).click();
  await editor.waitForSelector('#linkModal:not(.hidden)');
  assert.equal(await editor.textContent('#linkModalTitle'), 'Edit link');
  assert.equal(await editor.inputValue('#linkTitle'), 'Shop');
  assert.equal(await editor.inputValue('#linkUrl'), 'https://example.com/rando-shop');
  await editor.fill('#linkTitle', 'Art shop');
  await editor.click('#linkSave');
  await editor.waitForSelector('#linkModal.hidden', { state: 'attached' });
  await waitForToast(editor, 'Link saved');
  const linkAddresses = () => editor.locator('#linkList .edit-link .url').allTextContents();
  assert.deepEqual(await linkAddresses(), ['https://vk.com/rando', 'https://example.com/rando-shop']);
  assert.ok(await editor.getByRole('button', { name: 'Move VK up' }).isDisabled(), 'the first link cannot move up');
  await editor.getByRole('button', { name: 'Move Art shop up' }).click();
  await waitForText(editor, '#linkList .edit-link .url', 'https://example.com/rando-shop');
  const savedOrder = await editor.evaluate(async () => {
    const answer = await (await fetch('/api/me/page')).json();
    return answer.page.links.map((link) => link.title);
  });
  assert.deepEqual(savedOrder, ['Art shop', 'VK'], 'the new order is saved');
  await pressSwitch(editor.getByRole('checkbox', { name: 'Show Art shop on your page' }));
  await editor.waitForSelector('#linkList .edit-link.off');
  assert.match(await editor.locator('#linkList .edit-link.off').textContent(), /Art shop.*Hidden/);
  await pressSwitch(editor.getByRole('checkbox', { name: 'Show Art shop on your page' }));
  await editor.waitForFunction(() => document.querySelectorAll('#linkList .edit-link.off').length === 0);
  const deletePrompts = [];
  editor.once('dialog', (prompt) => {
    deletePrompts.push(prompt.message());
    prompt.accept();
  });
  await editor.getByRole('button', { name: 'Delete Art shop' }).click();
  await waitForToast(editor, 'Link deleted');
  assert.deepEqual(deletePrompts, ['Delete "Art shop"? This cannot be undone.']);
  assert.deepEqual(await linkAddresses(), ['https://vk.com/rando']);
  passed('editor links: the redirect switch opens and closes its field; a link is added, edited, moved up (and saved in that order), hidden and shown, and deleted after a confirmation');

  // Page details: the display name and bio are saved and show on the public
  // page, in its title too.
  await editor.click('#tab-profile');
  await editor.waitForSelector('#panel-profile:not([hidden])');
  await editor.fill('#displayName', 'Rando the Fox');
  await editor.fill('#bio', 'Painter of foxes. Commissions open.');
  assert.equal(await editor.textContent('#bioCount'), '35 of 512 characters');
  await editor.click('#profileSave');
  await waitForToast(editor, 'Saved');
  const profileView = await openLocal(b, '/rando');
  await profileView.waitForSelector('#profile h1');
  assert.equal(await profileView.textContent('#profile h1'), 'Rando the Fox');
  assert.equal(await profileView.textContent('#profile .bio'), 'Painter of foxes. Commissions open.');
  assert.equal(await profileView.title(), 'Rando the Fox | OneLink GFTV');
  await profileView.context().close();
  passed('editor page details: the display name and bio are saved and show on the public page and in its title');

  // The picture editor opens for a chosen picture: a photo is offered
  // background removal, and a cut-out the backgrounds to put behind it.
  // Nothing of the background remover (its worker, model or runtime) loads,
  // since removal is never pressed.
  const photo = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const cutOut = await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 48, height: 48, channels: 4, background: { r: 204, g: 51, b: 51, alpha: 1 } } }, left: 24, top: 24 }])
    .png()
    .toBuffer();
  const removerRequests = [];
  editor.on('request', (request) => {
    if (/bg-removal-worker|\/assets\/models\/|\/assets\/vendor\/ort\//.test(request.url())) {
      removerRequests.push(request.url());
    }
  });
  await editor.setInputFiles('#avatarFile', { name: 'photo.png', mimeType: 'image/png', buffer: photo });
  await editor.waitForSelector('#avatarModal:not(.hidden)');
  assert.ok(await editor.locator('#composerRemoveBg').isVisible(), 'a photo is offered background removal');
  assert.ok(await editor.locator('#composerBg').isHidden(), 'and no backgrounds until it is cut out');
  assert.ok(Number(await editor.getAttribute('#composerCanvas', 'width')) > 0);
  await editor.screenshot({ path: shot('edit-picture-photo'), animations: 'disabled' });
  await editor.click('[data-close-modal="avatarModal"]');
  await editor.waitForSelector('#avatarModal.hidden', { state: 'attached' });
  await editor.setInputFiles('#avatarFile', { name: 'cut-out.png', mimeType: 'image/png', buffer: cutOut });
  await editor.waitForSelector('#avatarModal:not(.hidden)');
  assert.equal(await editor.textContent('#composerStatus'), 'This picture already has a see-through background. Add one behind it, or leave it as None.');
  assert.ok(await editor.locator('#composerRemoveBg').isHidden(), 'a cut-out needs no removal');
  await editor.click('#composerBgMode [data-bg="colour"]');
  await editor.waitForSelector('#composerColourBlock:not([hidden])');
  assert.ok(await editor.locator('#composerColours .colour-swatch').count() > 1, 'colour swatches');
  await editor.click('#composerBgMode [data-bg="gradient"]');
  await editor.waitForSelector('#composerGradientBlock:not([hidden])');
  await editor.screenshot({ path: shot('edit-picture-cut-out'), animations: 'disabled' });
  await editor.click('[data-close-modal="avatarModal"]');
  await editor.waitForSelector('#avatarModal.hidden', { state: 'attached' });
  assert.deepEqual(removerRequests, [], 'nothing of the background remover was fetched');
  assert.equal(editor.workers().length, 0, 'and no worker started');
  passed('editor picture: choosing a picture opens the picture editor (removal offered for a photo, background choices for a cut-out) without loading the background remover');

  // Share and insights: the QR code; one visit and one click, from the
  // public page above, by visits or clicks, over 30 or 7 days.
  await editor.click('#tab-share');
  await editor.waitForSelector('#panel-share:not([hidden])');
  assert.equal(await editor.locator('#shareQr svg').count(), 1, 'a QR code');
  await editor.click('#tab-stats');
  await editor.waitForSelector('#statsTiles:not([aria-busy]) .stat-tile .value');
  const tileValues = await editor.locator('#statsTiles .stat-tile .value').allTextContents();
  assert.deepEqual(tileValues.slice(0, 3), ['1', '1', '100%'], 'visits, clicks and clicks per visit');
  assert.equal(await editor.textContent('#statsChartTitle'), 'Visits a day, last 30 days');
  assert.ok(await editor.locator('#statsChart svg').count() > 0, 'a chart');
  assert.match(await editor.textContent('#statsLinks'), /VK/, 'VK is the most clicked link');
  await editor.click('#statsSeries [data-series="clicks"]');
  assert.equal(await editor.textContent('#statsChartTitle'), 'Clicks a day, last 30 days');
  const weekLoaded = answerFrom(editor, '/api/me/stats');
  await editor.click('#statsPeriod [data-days="7"]');
  assert.equal((await weekLoaded).status(), 200);
  await waitForText(editor, '#statsChartTitle', 'Clicks a day, last 7 days');
  await editor.waitForSelector('#statsTiles:not([aria-busy])');
  assert.deepEqual((await editor.locator('#statsTiles .stat-tile .value').allTextContents()).slice(0, 2), ['1', '1'], 'today is in the last 7 days too');
  await editor.screenshot({ path: shot('edit-stats'), fullPage: true });
  passed('editor share and insights: the QR code; one visit and one click from the public page above, by visits or clicks, over 30 or 7 days');

  // Security: what is set up; a wrong password is refused; new backup codes;
  // the change password and delete dialogs open (and are left unsent); sign
  // out everywhere else.
  await editor.click('#tab-security');
  await editor.waitForSelector('#panel-security:not([hidden])');
  assert.equal(await editor.textContent('#totpState'), 'On');
  assert.ok(await editor.locator('#totpRemove').isDisabled(), 'the only second step cannot be removed');
  assert.equal(await editor.getAttribute('#totpRemove', 'title'), 'This is your only second step. Add another before removing it.');
  assert.equal(await editor.textContent('#passkeyState'), '0 passkeys');
  assert.equal(await editor.textContent('#codesState'), '10 codes left');
  assert.ok(await editor.locator('#telegramSection').isHidden(), 'no Telegram without a bot');
  assert.equal(await editor.textContent('#renameState'), 'links.gftv.asia/rando');
  await editor.click('#codesRegenerate');
  await editor.waitForSelector('#passwordModal:not(.hidden)');
  await editor.fill('#confirmPassword', 'not my password');
  await editor.click('#passwordSubmit');
  await waitForText(editor, '#passwordError', 'That password is not right.');
  await editor.fill('#confirmPassword', OWNER_PASSWORD);
  await editor.click('#passwordSubmit');
  await editor.waitForSelector('#codesModal:not(.hidden)');
  assert.equal(await editor.locator('#codesModal #backupCodes li').count(), 10, 'ten new backup codes');
  await editor.click('[data-close-modal="codesModal"]');
  await editor.waitForSelector('#codesModal.hidden', { state: 'attached' });
  await editor.click('#passwordChange');
  await editor.waitForSelector('#changePasswordModal:not(.hidden)');
  await editor.fill('#currentPassword', OWNER_PASSWORD);
  await editor.fill('#changeNewPassword', 'too short');
  await editor.fill('#changeNewPasswordConfirm', 'too short');
  await editor.click('#changePasswordSubmit');
  assert.equal(await editor.textContent('#changePasswordError'), 'Use at least 10 characters.');
  await editor.click('[data-close-modal="changePasswordModal"]');
  await editor.waitForSelector('#changePasswordModal.hidden', { state: 'attached' });
  await editor.click('#pageDelete');
  await editor.waitForSelector('#deleteModal:not(.hidden)');
  assert.equal(await editor.textContent('#deleteConfirmLabel'), 'Type rando to confirm');
  await editor.click('[data-close-modal="deleteModal"]');
  await editor.waitForSelector('#deleteModal.hidden', { state: 'attached' });
  await editor.click('#sessionsEnd');
  await editor.waitForSelector('#passwordModal:not(.hidden)');
  await editor.fill('#confirmPassword', OWNER_PASSWORD);
  await editor.click('#passwordSubmit');
  await waitForToast(editor, 'Signed out everywhere else');
  await editor.screenshot({ path: shot('edit-security'), fullPage: true });
  passed('editor security: the second step, passkeys, backup codes and page name are shown; a wrong password is refused; new backup codes; the change password and delete dialogs; sign out everywhere else');

  // A testimonial: sent with consent, shown as waiting, withdrawn after a
  // confirmation, and sent again for the staff checks below.
  const RANDO_QUOTE = 'OneLink keeps every link I have in one tidy place.';
  await editor.click('#tab-profile');
  await editor.waitForSelector('#panel-profile:not([hidden])');
  await editor.fill('#ownQuote', RANDO_QUOTE);
  await editor.check('#ownQuoteConsent');
  await editor.click('#ownQuoteSend');
  await waitForToast(editor, 'Sent. Thank you!');
  assert.equal(await editor.textContent('#ownQuoteStatus'), `Waiting for the GFTV team: “${RANDO_QUOTE}”`);
  assert.ok(await editor.locator('#ownQuoteWithdraw').isVisible());
  editor.once('dialog', (prompt) => prompt.accept());
  await editor.click('#ownQuoteWithdraw');
  await editor.waitForSelector('#ownQuoteStatus[hidden]', { state: 'attached' });
  assert.ok(await editor.locator('#ownQuoteWithdraw').isHidden());
  await editor.fill('#ownQuote', RANDO_QUOTE);
  await editor.check('#ownQuoteConsent');
  await editor.click('#ownQuoteSend');
  await editor.waitForSelector('#ownQuoteStatus:not([hidden])');
  passed('editor testimonial: sent with consent and shown as waiting, withdrawn after a confirmation, and sent again');

  // Asking for a higher link limit: shown as waiting, withdrawn after a
  // confirmation, and asked again for the staff checks below.
  await editor.click('#tab-links');
  await editor.waitForSelector('#panel-links:not([hidden])');
  assert.ok(await editor.locator('#capRequestBox').isVisible());
  const askForMore = async () => {
    await editor.fill('#capRequested', '30');
    await editor.fill('#capReason', 'Room for my shop and commission links.');
    assert.equal(await editor.textContent('#capReasonCount'), '38 of 500 characters');
    await editor.click('#capRequestSend');
    await editor.waitForSelector('#capWithdrawRow:not([hidden])');
  };
  await askForMore();
  await waitForToast(editor, 'Sent. The GFTV team will look at it.');
  assert.match(await editor.textContent('#capRequestStatus'), /^You asked for a limit of 30 on .+\. Waiting for the GFTV team\.$/);
  assert.ok(await editor.locator('#capRequestForm').isHidden(), 'one request at a time');
  editor.once('dialog', (prompt) => prompt.accept());
  await editor.click('#capRequestWithdraw');
  await editor.waitForSelector('#capWithdrawRow[hidden]', { state: 'attached' });
  assert.equal(await editor.textContent('#capRequestStatus'), '');
  assert.ok(await editor.locator('#capRequestForm').isVisible(), 'the form is back');
  await askForMore();
  passed('editor link limit: asking for 30 links shows the request as waiting; withdrawn after a confirmation, and asked again');

  // Two more pages for the staff checks, made through the real sign-up
  // handlers (seedPage in server.js): one whose name waits for approval and
  // one quarantined. Visitors are told both are being checked.
  await server.seedPage('waiting-fox', { needs_review: true, reviewed_at: null });
  await server.seedPage('quiet-fox', { quarantined_at: new Date().toISOString(), quarantine_reason: 'A second page from a banned connection' });
  for (const slug of ['waiting-fox', 'quiet-fox']) {
    const held = await localPage(b, `/${slug}`);
    const heldResponse = await held.goto(`${BASE}/${slug}`);
    assert.equal(heldResponse.status(), 404, `/${slug} is not shown yet`);
    await held.waitForSelector('#profile h1');
    assert.equal(await held.textContent('#profile h1'), 'This page is being checked');
    await held.context().close();
  }
  passed('a page whose name waits for approval, and a quarantined page, tell visitors they are being checked');

  // ---------------------------------------------------------------------------
  // The staff dashboard as an editor, signed in through the staff form. Admin
  // only: the Team, Block lists and Audit log tabs, the add form and
  // arranging on Testimonials, the default and per-page link limits, and
  // taking down or deleting pages and reports (js/pages/admin.js isAdmin,
  // api/_lib/staff.js requireStaff).
  // ---------------------------------------------------------------------------
  const editorDesk = await openLocal(b, '/admin', null, { viewport: { width: 1200, height: 900 } });
  await pageReady(editorDesk);
  await editorDesk.waitForSelector('#staffLogin:not([hidden])');
  assert.ok(await editorDesk.locator('#dashboard').isHidden(), 'nothing of the dashboard before signing in');
  await editorDesk.fill('#staffIdentifier', 'ed');
  await editorDesk.fill('#staffPassword', STAFF_PASSWORD);
  await editorDesk.click('#staffPasswordSubmit');
  await editorDesk.waitForSelector('#staffCodeForm:not([hidden])');
  assert.equal(await editorDesk.getAttribute('#staffMethods [data-method="totp"]', 'aria-pressed'), 'true', 'the authenticator app comes first');
  await editorDesk.fill('#staffCode', totpAt(server.staffSecrets.ed));
  await editorDesk.click('#staffCodeSubmit');
  await editorDesk.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await editorDesk.textContent('#staffWho'), 'Signed in as ED, editor');
  assert.deepEqual(await visibleTabs(editorDesk), ['overview', 'reports', 'pages', 'links', 'testimonials', 'caps', 'account']);
  await editorDesk.click('#atab-pages');
  await editorDesk.press('#atab-pages', 'ArrowRight');
  assert.equal(await editorDesk.getAttribute('#atab-links', 'aria-selected'), 'true', 'the arrow keys skip the Team tab editors do not have');
  passed('staff sign-in as an editor, with the password and an authenticator code: seven tabs, without Team, Block lists and Audit log, and the arrow keys skip those');

  // Overview: what waits, from the pages, reports, testimonial and request
  // above; a card opens its tab.
  await openAdminTab(editorDesk, 'overview');
  const waitingCounts = {
    'Open reports': '2',
    'Awaiting approval': '1',
    'Quarantined': '1',
    'Testimonials to approve': '1',
    'Requests for more links': '1',
    'Live pages': '5',
    'Pages setting up': '0',
    'Pages taken down': '0',
    'Links': '4',
    'Links removed': '0',
  };
  assert.deepEqual(await overviewCounts(editorDesk), waitingCounts);
  await editorDesk.screenshot({ path: shot('admin-editor-overview') });
  await editorDesk.locator('#stats .stat', { hasText: 'Open reports' }).click();
  await editorDesk.waitForSelector('#apanel-reports:not([hidden])');
  assert.equal(await editorDesk.getAttribute('#atab-reports', 'aria-selected'), 'true');
  passed('dashboard overview (editor): two open reports, a name awaiting approval, a quarantined page, a testimonial and a link limit request waiting; the Open reports card opens Reports');

  // Reports: both from the public page, with Resolve, Dismiss and View page
  // but no Delete; one resolved with a note, one dismissed.
  await editorDesk.waitForSelector('#reportList:not([aria-busy]) .data-row');
  assert.deepEqual(await rowButtons(editorDesk, '#reportList'), [['Resolve', 'Dismiss', 'View page'], ['Resolve', 'Dismiss', 'View page']], 'no Delete for editors');
  const linkReport = editorDesk.locator('#reportList .data-row', { hasText: 'https://vk.com/rando' });
  assert.match(await linkReport.textContent(), /\/rando · link "VK".*Scam or phishing/);
  await linkReport.getByRole('button', { name: 'Resolve' }).click();
  await editorDesk.waitForSelector('#reasonModal:not(.hidden)');
  assert.equal(await editorDesk.textContent('#reasonTitle'), 'Resolve report');
  assert.ok(await editorDesk.locator('#reasonRemoveRow').isVisible(), 'the link can be removed in the same step');
  await editorDesk.fill('#reasonText', 'Checked: the link is fine.');
  await editorDesk.click('#reasonSubmit');
  await editorDesk.waitForFunction(() => document.querySelectorAll('#reportList .data-row').length === 1);
  const pageReport = editorDesk.locator('#reportList .data-row', { hasText: 'Smoke test: a report on the whole page.' });
  assert.match(await pageReport.textContent(), /\/rando · whole page.*Spam/);
  await pageReport.getByRole('button', { name: 'Dismiss' }).click();
  await editorDesk.waitForSelector('#reasonModal:not(.hidden)');
  assert.ok(await editorDesk.locator('#reasonRemoveRow').isHidden(), 'nothing to remove for a whole page');
  await editorDesk.click('#reasonSubmit');
  await waitForText(editorDesk, '#reportList', 'No reports here.');
  await editorDesk.selectOption('#reportStatus', 'resolved');
  await editorDesk.waitForSelector('#reportList:not([aria-busy]) .data-row');
  assert.match(await editorDesk.textContent('#reportList'), /Note: Checked: the link is fine\./);
  assert.deepEqual(await rowButtons(editorDesk, '#reportList'), [['View page']]);
  passed('dashboard reports (editor): both reports with Resolve, Dismiss and View page but no Delete; the link one resolved with a note (its link could go in the same step), the page one dismissed');

  // Pages: the Awaiting approval card lists the waiting page, which an
  // editor approves; the quarantined page is released; every page has only
  // View page; search; the page dialog has no admin buttons.
  await openAdminTab(editorDesk, 'overview');
  await overviewCounts(editorDesk);
  await editorDesk.locator('#stats .stat', { hasText: 'Awaiting approval' }).click();
  await editorDesk.waitForSelector('#apanel-pages:not([hidden])');
  assert.equal(await editorDesk.inputValue('#pageStatus'), 'review', 'the card sets the filter');
  await editorDesk.waitForSelector('#pageList:not([aria-busy]) .data-row');
  assert.match(await editorDesk.textContent('#pageList'), /\/waiting-fox.*Awaiting approval/);
  assert.deepEqual(await rowButtons(editorDesk, '#pageList'), [['Approve', 'View page']]);
  await editorDesk.locator('#pageList').getByRole('button', { name: 'Approve' }).click();
  await waitForToast(editorDesk, 'Approved. /waiting-fox is live.');
  await waitForText(editorDesk, '#pageList', 'No pages match.');
  await editorDesk.selectOption('#pageStatus', 'quarantined');
  await editorDesk.waitForSelector('#pageList:not([aria-busy]) .data-row');
  assert.match(await editorDesk.textContent('#pageList'), /\/quiet-fox.*Quarantined: A second page from a banned connection/);
  assert.deepEqual(await rowButtons(editorDesk, '#pageList'), [['Release', 'View page']]);
  await editorDesk.locator('#pageList').getByRole('button', { name: 'Release' }).click();
  await waitForToast(editorDesk, 'Released. /quiet-fox is showing again.');
  await waitForText(editorDesk, '#pageList', 'No pages match.');
  await editorDesk.selectOption('#pageStatus', '');
  await editorDesk.waitForFunction(() => document.querySelectorAll('#pageList .data-row').length === 5);
  for (const buttons of await rowButtons(editorDesk, '#pageList')) {
    assert.deepEqual(buttons, ['View page'], 'editors cannot take pages down');
  }
  await editorDesk.fill('#pageQuery', 'fox');
  await editorDesk.press('#pageQuery', 'Enter');
  await editorDesk.waitForFunction(() => document.querySelectorAll('#pageList .data-row').length === 4);
  assert.deepEqual(await editorDesk.locator('#pageList .data-row .primary a').allTextContents(), ['/quiet-fox', '/waiting-fox', '/rando', '/augy-fox'], 'by name or display name (Rando the Fox), newest first');
  await editorDesk.fill('#pageQuery', '');
  await editorDesk.press('#pageQuery', 'Enter');
  await editorDesk.waitForFunction(() => document.querySelectorAll('#pageList .data-row').length === 5);
  await editorDesk.locator('#pageList .data-row', { hasText: '/rando' }).getByRole('button', { name: 'View page' }).click();
  await waitForText(editorDesk, '#pageModalTitle', '/rando');
  await editorDesk.waitForSelector('#pageModalBody .data-list');
  const editorDialogButtons = await dialog(editorDesk).locator('button').allTextContents();
  assert.deepEqual(editorDialogButtons.map((text) => text.trim()), ['Remove'], 'only removing its link: no take down, delete, team mark or link limit for editors');
  assert.match(await dialog(editorDesk).textContent(), /Link limit: uses 1 of 20, the default\./);
  await editorDesk.screenshot({ path: shot('admin-editor-page-dialog'), animations: 'disabled' });
  await editorDesk.click('[data-close-modal="pageModal"]');
  await editorDesk.waitForSelector('#pageModal.hidden', { state: 'attached' });
  const approved = await openLocal(b, '/waiting-fox');
  await waitForText(approved, '#profile h1', 'waiting-fox');
  await approved.context().close();
  passed('dashboard pages (editor): the Awaiting approval card lists the waiting page, approved and live; the quarantined page released; only View page on each page; search; no admin buttons in the page dialog');

  // Links: search finds one; removing it needs a reason and shows it as
  // removed; restoring brings it back.
  await openAdminTab(editorDesk, 'links');
  await editorDesk.waitForSelector('#adminLinkList:not([aria-busy]) .data-row');
  await editorDesk.fill('#linkQuery', 'vk.com/rando');
  await editorDesk.press('#linkQuery', 'Enter');
  await editorDesk.waitForFunction(() => document.querySelectorAll('#adminLinkList .data-row').length === 1);
  const vkRow = editorDesk.locator('#adminLinkList .data-row');
  assert.match(await vkRow.textContent(), /VK · \/rando.*https:\/\/vk\.com\/rando.*Shown.*1 click/);
  await vkRow.getByRole('button', { name: 'Remove' }).click();
  await editorDesk.waitForSelector('#reasonModal:not(.hidden)');
  assert.equal(await editorDesk.textContent('#reasonTitle'), 'Remove link');
  await editorDesk.click('#reasonSubmit');
  assert.equal(await editorDesk.textContent('#reasonError'), 'Give a reason.');
  await editorDesk.fill('#reasonText', 'Smoke test removal');
  await editorDesk.click('#reasonSubmit');
  await editorDesk.waitForFunction(() => document.getElementById('adminLinkList').textContent.includes('Removed: Smoke test removal'));
  assert.deepEqual(await rowButtons(editorDesk, '#adminLinkList'), [['Restore']]);
  await vkRow.getByRole('button', { name: 'Restore' }).click();
  await editorDesk.waitForSelector('#reasonModal:not(.hidden)');
  await editorDesk.click('#reasonSubmit');
  await editorDesk.waitForFunction(() => !document.getElementById('adminLinkList').textContent.includes('Removed'));
  assert.deepEqual(await rowButtons(editorDesk, '#adminLinkList'), [['Remove']]);
  passed('dashboard links (editor): search finds a link; removing it needs a reason and shows it as removed; restoring brings it back');

  // Testimonials: the owner's waits with Approve and Decline, and approving
  // publishes it; no add form and nothing to arrange for editors.
  await openAdminTab(editorDesk, 'testimonials');
  await editorDesk.waitForSelector('#testimonialPending:not([aria-busy]) .data-row');
  assert.ok(await editorDesk.locator('#testimonialForm').isHidden(), 'editors cannot add testimonials');
  assert.ok((await editorDesk.textContent('#testimonialPending')).includes(`“${RANDO_QUOTE}”Rando the Fox · /rando`));
  assert.deepEqual(await rowButtons(editorDesk, '#testimonialPending'), [['Approve', 'Decline']]);
  assert.equal(await editorDesk.textContent('#testimonialList'), 'No testimonials yet.');
  await editorDesk.locator('#testimonialPending').getByRole('button', { name: 'Approve' }).click();
  await waitForText(editorDesk, '#testimonialPending', 'Nothing waiting.');
  await editorDesk.waitForSelector('#testimonialList .data-row');
  assert.match(await editorDesk.textContent('#testimonialList'), /Sent by the owner/);
  assert.deepEqual(await rowButtons(editorDesk, '#testimonialList'), [[]], 'the published list as it is, with nothing to arrange');
  passed('dashboard testimonials (editor): the owner\'s testimonial waits with Approve and Decline, and approving publishes it; no add form and nothing to arrange for editors');

  // Link limits: the request waits with its reason; an editor gives at most
  // what was asked (more is refused) and approves it with a note; no default
  // limit or per-page list for editors.
  await openAdminTab(editorDesk, 'caps');
  await editorDesk.waitForSelector('#capRequestList:not([aria-busy]) .data-row');
  assert.ok(await editorDesk.locator('#capDefaultForm').isHidden(), 'no default limit for editors');
  assert.ok(await editorDesk.locator('#capCustomList').isHidden(), 'nor the pages with a limit of their own');
  assert.match(await editorDesk.textContent('#capRequestList'), /\/rando · Rando the Fox.*Asks for a limit of 30\. Uses 1 of 20 now\..*Room for my shop and commission links\./);
  await editorDesk.locator('#capRequestList').getByRole('button', { name: 'Approve' }).click();
  await editorDesk.waitForSelector('#capModal:not(.hidden)');
  assert.equal(await editorDesk.textContent('#capTitle'), 'More links for /rando');
  assert.equal(await editorDesk.inputValue('#capValue'), '30');
  await editorDesk.fill('#capValue', '31');
  await editorDesk.click('#capSubmit');
  assert.equal(await editorDesk.textContent('#capError'), 'Choose a limit from 21 to 30.', 'editors give at most what was asked');
  await editorDesk.fill('#capValue', '30');
  await editorDesk.fill('#capNote', 'Enjoy the extra room.');
  await editorDesk.click('#capSubmit');
  await editorDesk.waitForSelector('#capModal.hidden', { state: 'attached' });
  await waitForText(editorDesk, '#capRequestList', 'Nothing waiting.');
  passed('dashboard link limits (editor): the request waits with its reason; editors give at most what was asked (more is refused) and approve it with a note; no default limit or per-page list');

  // My passkeys, the API's answer to admin-only requests, and signing out.
  await openAdminTab(editorDesk, 'account');
  await waitForText(editorDesk, '#staffPasskeyList', 'No passkeys on this site yet.');
  assert.ok(await editorDesk.locator('#staffPasskeyAdd').isVisible());
  const refusals = await editorDesk.evaluate(async () => {
    const send = async (path, body) => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return response.status;
    };
    return {
      blockLists: (await fetch('/api/admin/blocklist')).status,
      auditLog: (await fetch('/api/admin/audit')).status,
      addTestimonial: await send('/api/admin/testimonials', { action: 'add', quote: 'Lovely', author: 'Someone' }),
      defaultLimit: await send('/api/admin/link-caps', { action: 'set-default', cap: 25 }),
      takeDown: await send('/api/admin/pages', { action: 'ban', id: '00000000-0000-4000-8000-000000000000', reason: 'test' }),
      deleteReport: await send('/api/admin/reports', { action: 'delete', id: '00000000-0000-4000-8000-000000000000' }),
    };
  });
  assert.deepEqual(refusals, { blockLists: 403, auditLog: 403, addTestimonial: 403, defaultLimit: 403, takeDown: 403, deleteReport: 403 });
  await editorDesk.click('#staffSignOut');
  await editorDesk.waitForSelector('#staffLogin:not([hidden])');
  assert.equal(await editorDesk.evaluate(async () => (await fetch('/api/admin/auth')).status), 401, 'the session has ended');
  await editorDesk.context().close();
  passed('dashboard as an editor: no passkeys yet; the API refuses editors the block lists, audit log, adding testimonials, the default link limit, taking pages down and deleting reports; signing out ends the session');

  // ---------------------------------------------------------------------------
  // The staff dashboard as an admin: every tab, and what only admins have.
  // ---------------------------------------------------------------------------
  const adminDesk = await openLocal(b, '/admin', 'boss', { viewport: { width: 1200, height: 900 } });
  await pageReady(adminDesk);
  await adminDesk.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await adminDesk.textContent('#staffWho'), 'Signed in as BOSS, admin');
  assert.deepEqual(await visibleTabs(adminDesk), ['overview', 'reports', 'pages', 'team', 'links', 'blocks', 'testimonials', 'caps', 'audit', 'account']);
  await adminDesk.click('#atab-pages');
  await adminDesk.press('#atab-pages', 'ArrowRight');
  assert.equal(await adminDesk.getAttribute('#atab-team', 'aria-selected'), 'true', 'the arrow keys reach Team');
  await openAdminTab(adminDesk, 'overview');
  const settledCounts = { ...waitingCounts, 'Open reports': '0', 'Awaiting approval': '0', 'Quarantined': '0', 'Testimonials to approve': '0', 'Requests for more links': '0' };
  assert.deepEqual(await overviewCounts(adminDesk), settledCounts);
  passed('dashboard as an admin: all ten tabs, and the arrow keys reach Team; the overview shows nothing left waiting after the editor\'s work');

  // Reports: resolved and dismissed ones, with Delete for admins; one deleted
  // after a confirmation.
  await openAdminTab(adminDesk, 'reports');
  await waitForText(adminDesk, '#reportList', 'No reports here.');
  await adminDesk.selectOption('#reportStatus', 'resolved');
  await adminDesk.waitForSelector('#reportList:not([aria-busy]) .data-row');
  assert.deepEqual(await rowButtons(adminDesk, '#reportList'), [['View page', 'Delete']]);
  await adminDesk.selectOption('#reportStatus', 'dismissed');
  await adminDesk.waitForSelector('#reportList:not([aria-busy]) .data-row');
  assert.match(await adminDesk.textContent('#reportList'), /\/rando · whole page/);
  const reportPrompts = [];
  adminDesk.once('dialog', (prompt) => {
    reportPrompts.push(prompt.message());
    prompt.accept();
  });
  await adminDesk.locator('#reportList').getByRole('button', { name: 'Delete' }).click();
  await waitForText(adminDesk, '#reportList', 'No reports here.');
  assert.deepEqual(reportPrompts, ['Delete this report for good? The audit log keeps a record of what it said.']);
  passed('dashboard reports (admin): resolved and dismissed reports, with Delete for admins; one deleted after a confirmation');

  // Pages and Team: Take down on every live page; the page dialog has the
  // team mark, take down, delete and link limit buttons; deleting needs the
  // name typed exactly, so a wrong one deletes nothing.
  await openAdminTab(adminDesk, 'pages');
  await adminDesk.waitForSelector('#pageList:not([aria-busy]) .data-row');
  const adminPageButtons = await rowButtons(adminDesk, '#pageList');
  assert.equal(adminPageButtons.length, 5);
  for (const buttons of adminPageButtons) {
    assert.deepEqual(buttons, ['View page', 'Take down']);
  }
  await adminDesk.locator('#pageList .data-row', { hasText: '/rando' }).getByRole('button', { name: 'View page' }).click();
  await waitForText(adminDesk, '#pageModalTitle', '/rando');
  await adminDesk.waitForSelector('#pageModalBody .actions.inline button');
  const adminDialogActions = await dialog(adminDesk).locator('.actions.inline button').allTextContents();
  assert.deepEqual(adminDialogActions.map((text) => text.trim()), ['Verify as GFTV team', 'Take down', 'Delete page']);
  assert.match(await dialog(adminDesk).textContent(), /Link limit: uses 1 of 30, a limit of its own\./, 'the limit the editor gave');
  assert.equal(await dialog(adminDesk).getByRole('button', { name: 'Change limit' }).count(), 1);
  await dialog(adminDesk).getByRole('button', { name: 'Delete page' }).click();
  await adminDesk.waitForSelector('#reasonModal:not(.hidden)');
  assert.equal(await adminDesk.textContent('#reasonTitle'), 'Delete /rando');
  assert.equal(await adminDesk.textContent('#reasonConfirmLabel'), 'Type rando to confirm');
  await adminDesk.fill('#reasonText', 'Smoke test: not really deleting.');
  await adminDesk.fill('#reasonConfirm', 'random');
  await adminDesk.click('#reasonSubmit');
  assert.equal(await adminDesk.textContent('#reasonError'), 'Type the page name exactly to confirm.');
  await adminDesk.screenshot({ path: shot('admin-delete-confirm'), animations: 'disabled' });
  await adminDesk.click('[data-close-modal="reasonModal"]');
  await adminDesk.waitForSelector('#reasonModal.hidden', { state: 'attached' });
  await adminDesk.click('[data-close-modal="pageModal"]');
  await adminDesk.waitForSelector('#pageModal.hidden', { state: 'attached' });
  assert.equal(await adminDesk.locator('#pageList .data-row').count(), 5, 'nothing was deleted');
  await openAdminTab(adminDesk, 'team');
  await adminDesk.waitForSelector('#adminTeamList:not([aria-busy]) .team-row');
  assert.deepEqual(await adminDesk.locator('#adminTeamList .team-row .primary a').allTextContents(), ['/augy-fox']);
  assert.equal(await adminDesk.textContent('#adminTeamTitle'), 'On the team: 1 page');
  passed('dashboard pages and team (admin): Take down on every page; the page dialog has the team mark, take down, delete and link limit buttons; a wrongly typed name deletes nothing; Team lists /augy-fox');

  // Links: every link, each with Remove; none removed now.
  await openAdminTab(adminDesk, 'links');
  await adminDesk.waitForSelector('#adminLinkList:not([aria-busy]) .data-row');
  const adminLinkButtons = await rowButtons(adminDesk, '#adminLinkList');
  assert.equal(adminLinkButtons.length, 4);
  for (const buttons of adminLinkButtons) {
    assert.deepEqual(buttons, ['Remove']);
  }
  await adminDesk.selectOption('#linkState', 'removed');
  await waitForText(adminDesk, '#adminLinkList', 'No links match.');
  passed('dashboard links (admin): all four links, each with Remove, and none removed');

  // Block lists: the threat lists are off here; names, domains, allowed
  // domains and patterns each take an entry and give it back; the review
  // names, flagged and banned lists; the pattern helper opens.
  await openAdminTab(adminDesk, 'blocks');
  await adminDesk.waitForSelector('#slugBlockList:not([aria-busy])');
  assert.equal(await adminDesk.textContent('#threatListInfo'), 'The domain lists are switched off (DOMAIN_BLOCKLISTS is "off").');
  assert.ok(await adminDesk.locator('#threatListRefresh').isHidden(), 'nothing to fetch while they are off');
  const emptyLists = {
    slugBlockList: 'Nothing blocked.',
    domainBlockList: 'Nothing blocked.',
    allowedBlockList: 'No domains allowed.',
    patternBlockList: 'Nothing blocked.',
    flaggedList: 'No connections are flagged.',
    flaggedDeviceList: 'No devices are flagged.',
    bannedList: 'No connections are banned.',
  };
  for (const [listId, emptyText] of Object.entries(emptyLists)) {
    assert.equal(await adminDesk.textContent(`#${listId}`), emptyText, listId);
  }
  assert.match(await adminDesk.textContent('#reviewBlockList .data-row .primary'), /^furcon$/, 'the review name added before the rename above');
  const addAndRemove = async (kind, value) => {
    const listId = `${kind}BlockList`;
    await adminDesk.fill(`#${kind}BlockValue`, value);
    await adminDesk.fill(`#${kind}BlockReason`, 'Smoke test');
    await adminDesk.locator(`#${kind}BlockForm button[type="submit"]`).click();
    await waitForText(adminDesk, `#${listId} .data-row .primary`, value);
    assert.match(await adminDesk.textContent(`#${listId} .data-row .secondary`), /^Smoke test · /);
    assert.equal(await adminDesk.inputValue(`#${kind}BlockValue`), '', 'the field clears');
    await adminDesk.locator(`#${listId} .data-row`).getByRole('button', { name: 'Remove' }).click();
    await waitForText(adminDesk, `#${listId}`, emptyLists[listId]);
  };
  await addAndRemove('slug', 'spammer');
  await addAndRemove('domain', 'bad.example');
  await addAndRemove('allowed', 'good.example');
  await adminDesk.selectOption('#patternBlockScope', 'names');
  await adminDesk.fill('#patternBlockValue', 'spam+er');
  await adminDesk.locator('#patternBlockForm button[type="submit"]').click();
  await waitForText(adminDesk, '#patternBlockList .data-row .primary', 'spam+er');
  assert.equal(await adminDesk.textContent('#patternBlockList .data-row .badge'), 'Page names');
  await adminDesk.locator('#patternBlockList .data-row').getByRole('button', { name: 'Remove' }).click();
  await waitForText(adminDesk, '#patternBlockList', 'Nothing blocked.');
  await adminDesk.click('#patternBlockHelp');
  await adminDesk.waitForSelector('#regexModal:not(.hidden)');
  assert.equal(await adminDesk.textContent('#regexTitle'), 'Pattern helper');
  await adminDesk.screenshot({ path: shot('admin-pattern-helper'), animations: 'disabled' });
  await adminDesk.click('[data-close-modal="regexModal"]');
  await adminDesk.waitForSelector('#regexModal.hidden', { state: 'attached' });
  await adminDesk.screenshot({ path: shot('admin-block-lists'), fullPage: true });
  passed('dashboard block lists (admin): the threat lists are off here; names, domains, allowed domains and patterns each take an entry and give it back; the review names, flagged and banned lists; the pattern helper opens');

  // Testimonials: the add form; a staff testimonial added and moved up; hide
  // and show.
  const STAFF_QUOTE = 'Setting up my page took two minutes.';
  await openAdminTab(adminDesk, 'testimonials');
  await adminDesk.waitForSelector('#testimonialList:not([aria-busy]) .data-row');
  assert.ok(await adminDesk.locator('#testimonialForm').isVisible(), 'admins can add testimonials');
  assert.equal(await adminDesk.textContent('#testimonialPending'), 'Nothing waiting.');
  assert.deepEqual(await rowButtons(adminDesk, '#testimonialList'), [['Move up', 'Move down', 'Hide', 'Remove']]);
  await adminDesk.fill('#testimonialQuote', STAFF_QUOTE);
  await adminDesk.fill('#testimonialAuthor', 'Sam');
  await adminDesk.click('#testimonialAdd');
  await adminDesk.waitForFunction(() => document.querySelectorAll('#testimonialList .data-row').length === 2);
  assert.equal(await adminDesk.inputValue('#testimonialQuote'), '', 'the form clears');
  const testimonialQuotes = () => adminDesk.locator('#testimonialList .data-row .primary').allTextContents();
  assert.deepEqual(await testimonialQuotes(), [`“${RANDO_QUOTE}”`, `“${STAFF_QUOTE}”`]);
  await adminDesk.locator('#testimonialList .data-row').nth(1).getByRole('button', { name: 'Move up' }).click();
  await waitForText(adminDesk, '#testimonialList .data-row .primary', `“${STAFF_QUOTE}”`);
  assert.deepEqual(await testimonialQuotes(), [`“${STAFF_QUOTE}”`, `“${RANDO_QUOTE}”`]);
  await adminDesk.locator('#testimonialList .data-row').nth(1).getByRole('button', { name: 'Hide' }).click();
  await adminDesk.waitForSelector('#testimonialList .data-row.off');
  assert.match(await adminDesk.textContent('#testimonialList .data-row.off'), /Hidden/);
  await adminDesk.locator('#testimonialList .data-row.off').getByRole('button', { name: 'Show' }).click();
  await adminDesk.waitForFunction(() => document.querySelectorAll('#testimonialList .data-row.off').length === 0);
  passed('dashboard testimonials (admin): the add form; a staff testimonial added and moved up; hide and show; arranging buttons on each');

  // Link limits: the default, and /rando with the limit of its own the editor
  // gave; its change dialog offers the default back; the default saves.
  await openAdminTab(adminDesk, 'caps');
  await adminDesk.waitForSelector('#capCustomList:not([aria-busy]) .data-row');
  assert.ok(await adminDesk.locator('#capDefaultForm').isVisible());
  assert.equal(await adminDesk.inputValue('#capDefault'), '20');
  assert.equal(await adminDesk.textContent('#capRequestList'), 'Nothing waiting.');
  assert.match(await adminDesk.textContent('#capCustomList'), /\/rando · Rando the Fox.*Uses 1 of 30/);
  await adminDesk.locator('#capCustomList').getByRole('button', { name: 'Change limit' }).click();
  await adminDesk.waitForSelector('#capModal:not(.hidden)');
  assert.equal(await adminDesk.inputValue('#capValue'), '30');
  assert.equal(await adminDesk.textContent('#capUseDefaultLabel'), 'Follow the default (20)');
  await adminDesk.click('[data-close-modal="capModal"]');
  await adminDesk.waitForSelector('#capModal.hidden', { state: 'attached' });
  const defaultSaved = answerFrom(adminDesk, '/api/admin/link-caps', 'POST');
  await adminDesk.click('#capDefaultSave');
  assert.equal((await defaultSaved).status(), 200);
  assert.equal(await adminDesk.inputValue('#capDefault'), '20');
  passed('dashboard link limits (admin): the default limit, and /rando with the limit of its own the editor gave; its change dialog offers the default back; the default saves');

  // Audit log: every entry, then only moderation, then only staff sign-ins.
  await openAdminTab(adminDesk, 'audit');
  await adminDesk.waitForSelector('#auditList:not([aria-busy]) .data-row');
  await adminDesk.selectOption('#auditFilter', 'mod.');
  await adminDesk.waitForSelector('#auditList:not([aria-busy]) .data-row');
  const moderation = await adminDesk.locator('#auditList .data-row .primary').allTextContents();
  for (const action of moderation) {
    assert.ok(action.startsWith('mod.'), action);
  }
  for (const action of ['mod.link_cap_default', 'mod.testimonial_added', 'mod.slug_blocked', 'mod.report_deleted', 'mod.link_removed', 'mod.link_restored']) {
    assert.ok(moderation.includes(action), `${action} is in the log`);
  }
  await adminDesk.selectOption('#auditFilter', 'staff.');
  await adminDesk.waitForSelector('#auditList:not([aria-busy]) .data-row');
  const staffEntries = await adminDesk.locator('#auditList .data-row .primary').allTextContents();
  for (const action of staffEntries) {
    assert.ok(action.startsWith('staff.'), action);
  }
  assert.ok(staffEntries.includes('staff.login'), 'the editor\'s sign-in');
  await adminDesk.screenshot({ path: shot('admin-audit') });
  await openAdminTab(adminDesk, 'account');
  await waitForText(adminDesk, '#staffPasskeyList', 'No passkeys on this site yet.');
  await adminDesk.context().close();
  passed('dashboard audit log and passkeys (admin): moderation entries only (the link limit, testimonial, block list, report and link actions above), then staff sign-ins only; no passkeys yet');

  // What the staff decisions change: the owner sees the raised limit with
  // the note, and the testimonial on the home page; the home page shows both
  // testimonials in the order staff set.
  await editor.reload();
  await editor.waitForSelector('#editorReady:not([hidden])');
  assert.equal(await editor.textContent('#linkCapUsage'), '1 of 30 links used');
  assert.equal(await editor.textContent('#capRequestStatus'), 'Approved: your limit was raised to 30. Note from the GFTV team: Enjoy the extra room.');
  await editor.waitForSelector('#ownQuoteStatus:not([hidden])', { state: 'attached' });
  assert.equal(await editor.textContent('#ownQuoteStatus'), `On the home page: “${RANDO_QUOTE}”. A new one replaces it and is checked again.`);
  await editor.context().close();
  const homeAgain = await openLocal(b, '/', null, { reducedMotion: 'reduce' });
  await homeAgain.waitForSelector('#lovedSection:not([hidden])');
  assert.deepEqual(await homeAgain.locator('#quoteRow blockquote').allTextContents(), [STAFF_QUOTE, RANDO_QUOTE]);
  assert.deepEqual(await homeAgain.locator('#quoteRow .quote-by').allTextContents(), ['Sam', 'Rando the Fox']);
  assert.equal(await homeAgain.locator('#quoteRow .quote-by').nth(1).getAttribute('href'), '/rando', 'an owner\'s testimonial links to their page');
  await homeAgain.locator('#lovedSection').screenshot({ path: shot('home-testimonials') });
  await homeAgain.context().close();
  passed('what staff decisions change: the owner sees the raised limit with the note and the testimonial on the home page; the home page shows both testimonials in the order staff set');
} catch (error) {
  console.error(`not ok ${step + 1} - ${error.message}`);
  process.exitCode = 1;
} finally {
  await b.close();
  await server.close();
}
if (problems.length) {
  console.error(`problems:\n${problems.join('\n')}`);
  process.exitCode = 1;
}
if (!process.exitCode) console.log('all browser checks passed: no page errors, console errors, CSP violations or 5xx');
