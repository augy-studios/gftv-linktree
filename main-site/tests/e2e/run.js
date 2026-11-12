// Browser tests: npm run e2e (from main-site/).
//
// Drives the real pages in Chromium against tests/e2e/server.js. Needs
// Playwright with Chromium where Node can find it (npm i -g playwright &&
// npx playwright install chromium); it is not a dependency of the site.
// Screenshots go to tests/e2e/out/ (ignored by git). Fails on any failed
// check, page error, console error (including a CSP violation) or 5xx.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startServer } from './server.js';
import { forgetReviewPatterns } from '../../api/_lib/guards.js';
import { randomToken, sha256 } from '../../api/_lib/crypto.js';
import { OWNER_COOKIE } from '../../api/_lib/session.js';

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
function watch(page, label) {
  page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/googletagmanager|gtag|Failed to load resource/.test(m.text())) problems.push(`${label} console: ${m.text()}`);
  });
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${label} ${r.status()} ${r.url()}`); });
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
