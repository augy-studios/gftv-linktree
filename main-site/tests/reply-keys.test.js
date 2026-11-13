// The exact keys of every answer the API sends (help desk #17).
//
// Each list below is what a reply carries today. A later change that adds or
// drops a field fails here, so a readability rewrite can't change what leaves
// the server by accident. When a field is added or removed on purpose, update
// its list in the same commit.
import { browser } from './harness.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { useTestClient } from '../api/_lib/supabase.js';
import { createFakeDb } from './fake-db.js';
import { totpAt, generateTotpSecret } from '../api/_lib/totp.js';
import { forgetBlockedDomains, forgetAllowedDomains, forgetBlockedPatterns, forgetReviewPatterns, IP_FLAG_AFTER } from '../api/_lib/guards.js';
import * as serialize from '../api/_lib/serialize.js';
import { publicStaff } from '../api/_lib/staff.js';

import slug from '../api/slug.js';
import register from '../api/auth/register.js';
import enrol from '../api/auth/enrol.js';
import login from '../api/auth/login.js';
import verify from '../api/auth/verify.js';
import recover from '../api/auth/recover.js';
import session from '../api/auth/session.js';
import mePage from '../api/me/page.js';
import meLinks from '../api/me/links.js';
import meAvatar from '../api/me/avatar.js';
import security from '../api/me/security.js';
import meStats from '../api/me/stats.js';
import meTestimonial from '../api/me/testimonial.js';
import meLinkCap from '../api/me/link-cap.js';
import publicPage from '../api/public/page.js';
import click from '../api/public/click.js';
import report from '../api/public/report.js';
import visit from '../api/public/visit.js';
import publicTeam from '../api/public/team.js';
import publicTestimonials from '../api/public/testimonials.js';
import publicInsights from '../api/public/insights.js';
import publicTurnstile from '../api/public/turnstile.js';
import render from '../api/render.js';
import adminAuth from '../api/admin/auth.js';
import adminOverview from '../api/admin/overview.js';
import adminPages from '../api/admin/pages.js';
import adminLinks from '../api/admin/links.js';
import adminReports from '../api/admin/reports.js';
import adminBlocklist from '../api/admin/blocklist.js';
import adminAudit from '../api/admin/audit.js';
import adminTestimonials from '../api/admin/testimonials.js';
import adminLinkCaps from '../api/admin/link-caps.js';
import adminPasskeys from '../api/admin/passkeys.js';

// The keys of one object, sorted, so each list reads in a fixed order.
function keysOf(value) {
  assert.ok(value !== null && typeof value === 'object', `expected an object, got ${JSON.stringify(value)}`);
  return Object.keys(value).sort();
}

// ---------------------------------------------------------------------------
// The shapes, one list per answer
// ---------------------------------------------------------------------------

const PUBLIC_LINK = ['icon', 'id', 'title', 'url'];
const PUBLIC_PAGE = ['avatarUrl', 'bio', 'displayName', 'links', 'redirectUrl', 'slug', 'team'];
const TEAM = ['role', 'verifiedAt'];
const TEAM_MEMBER = ['avatarUrl', 'displayName', 'role', 'slug', 'verifiedAt'];
const PUBLIC_TESTIMONIAL = ['author', 'pageSlug', 'quote'];

const OWNER_LINK = ['clicks', 'icon', 'id', 'isActive', 'removed', 'removedReason', 'title', 'url'];
const OWNER_PASSKEY = ['createdAt', 'id', 'label', 'lastUsedAt'];
const OWNER_LINK_CAP = ['custom', 'limit', 'used'];
const OWNER_CAP_REQUEST = ['granted', 'note', 'reason', 'requested', 'reviewedAt', 'sentAt', 'status'];
const OWNER_PAGE = [
  'avatarUrl', 'awaitingReview', 'bio', 'createdAt', 'displayName', 'dormantFrom', 'lastSignInAt', 'linkCap',
  'linkCapRequest', 'links', 'quarantined', 'redirectUrl', 'rename', 'security', 'slug', 'team',
];
const OWNER_SECURITY = ['backupCodesLeft', 'passkeys', 'telegram', 'telegramAvailable', 'totp'];
const OWNER_TESTIMONIAL = ['quote', 'reviewedAt', 'sentAt', 'status'];

const ADMIN_PAGE = [
  'activatedAt', 'avatarUrl', 'awaitingReview', 'banReason', 'bannedAt', 'bio', 'createdAt', 'displayName', 'dormant',
  'id', 'lastSignInAt', 'quarantineReason', 'quarantined', 'redirectUrl', 'slug', 'status', 'team', 'telegramLinked',
];
const ADMIN_LINK = ['clicks', 'createdAt', 'icon', 'id', 'isActive', 'removedAt', 'removedReason', 'slug', 'title', 'url'];
const ADMIN_REPORT = ['createdAt', 'details', 'id', 'link', 'pageId', 'pageStatus', 'reason', 'resolutionNote', 'resolvedAt', 'slug', 'status'];
const ADMIN_REPORT_LINK = ['removed', 'title', 'url'];
const ADMIN_AUDIT = ['action', 'actorId', 'actorType', 'createdAt', 'details'];
const ADMIN_TESTIMONIAL = ['author', 'createdAt', 'id', 'isVisible', 'pageSlug', 'quote', 'reviewedAt', 'sentByOwner', 'status'];
const ADMIN_CAP_REQUEST = [
  'capWhenAsked', 'createdAt', 'displayName', 'granted', 'id', 'limit', 'note', 'reason', 'requested', 'reviewedAt',
  'slug', 'status', 'used',
];
const ADMIN_CAP_PAGE = ['displayName', 'id', 'limit', 'slug', 'used'];
const STAFF = ['displayName', 'role', 'username'];

// ---------------------------------------------------------------------------
// Each serializer, given a full row
// ---------------------------------------------------------------------------

const NOW = '2026-11-13T00:00:00.000Z';

const pageRow = {
  id: 'page-1', slug: 'augy', display_name: 'Augy', bio: 'Hi', avatar_path: 'a/b.webp', status: 'active',
  ban_reason: null, banned_at: null, created_at: NOW, activated_at: NOW, telegram_chat_id: null, telegram_username: null,
  redirect_url: null, last_sign_in_at: NOW, needs_review: false, reviewed_at: null, quarantined_at: null,
  quarantine_reason: null, team_verified_at: NOW, team_role: 'Moderator', totp_secret: 'v1:x', links_cap: 25,
};
const linkRow = {
  id: 'link-1', page_id: 'page-1', page: { slug: 'augy' }, title: 'Site', url: 'https://example.com', icon: 'link',
  is_active: true, click_count: 3, removed_at: null, removed_reason: null, created_at: NOW, order_index: 0,
};

test('serializers: the public shapes', () => {
  assert.deepEqual(keysOf(serialize.publicLink(linkRow)), PUBLIC_LINK);
  assert.deepEqual(keysOf(serialize.servableLinks([linkRow], { domains: [], patterns: [] })[0]), PUBLIC_LINK);
  const page = serialize.publicPage(pageRow, [linkRow], { domains: [], patterns: [] });
  assert.deepEqual(keysOf(page), PUBLIC_PAGE);
  assert.deepEqual(keysOf(page.team), TEAM);
  assert.deepEqual(keysOf(serialize.publicTeam(pageRow)), TEAM);
  assert.equal(serialize.publicTeam({ ...pageRow, team_verified_at: null }), null);
  assert.deepEqual(keysOf(serialize.publicTeamMember(pageRow)), TEAM_MEMBER);
  assert.deepEqual(keysOf(serialize.publicTestimonial({ id: 't-1', quote: 'q', author: 'a', page_slug: 'augy' })), PUBLIC_TESTIMONIAL);
});

test('serializers: the owner shapes', () => {
  assert.deepEqual(keysOf(serialize.ownerLink(linkRow)), OWNER_LINK);
  assert.deepEqual(keysOf(serialize.ownerPasskey({ id: 'k-1', label: 'Phone', created_at: NOW, last_used_at: NOW })), OWNER_PASSKEY);
  assert.deepEqual(keysOf(serialize.ownerLinkCap({ limit: 20, override: null }, 3)), OWNER_LINK_CAP);

  const capRequest = { status: 'approved', requested_cap: 30, reason: 'More', granted_cap: 30, review_note: 'ok', created_at: NOW, reviewed_at: NOW };
  assert.deepEqual(keysOf(serialize.ownerCapRequest(capRequest)), OWNER_CAP_REQUEST);
  assert.deepEqual(keysOf(serialize.ownerCapRequest({ ...capRequest, status: 'pending' })), OWNER_CAP_REQUEST);
  assert.equal(serialize.ownerCapRequest({ ...capRequest, status: 'withdrawn' }), null);
  assert.equal(serialize.ownerCapRequest(null), null);

  const securityParts = { passkeys: [{ id: 'k-1', label: null, created_at: NOW, last_used_at: null }], backupCodesLeft: 10, telegramReady: true };
  const limits = { linkCap: { used: 1, limit: 20, custom: false }, capRequest: null, rename: { available: true, nextAt: null, previous: null } };
  const view = serialize.ownerPage(pageRow, [linkRow], securityParts, limits);
  assert.deepEqual(keysOf(view), OWNER_PAGE);
  assert.deepEqual(keysOf(view.security), OWNER_SECURITY);
  assert.deepEqual(keysOf(view.security.passkeys[0]), OWNER_PASSKEY);
  assert.deepEqual(keysOf(view.security.telegram), ['linked']);
  assert.deepEqual(keysOf(view.links[0]), OWNER_LINK);
  const linked = serialize.ownerPage({ ...pageRow, telegram_chat_id: 123, telegram_username: 'augy' }, [], securityParts);
  assert.deepEqual(keysOf(linked.security.telegram), ['linked', 'username']);
  assert.deepEqual(keysOf(linked), OWNER_PAGE, 'the same keys without limits');

  assert.deepEqual(keysOf(serialize.ownerTestimonial({ quote: 'q', status: 'pending', created_at: NOW, reviewed_at: null })), OWNER_TESTIMONIAL);
  assert.equal(serialize.ownerTestimonial(null), null);
});

test('serializers: the staff shapes', () => {
  assert.deepEqual(keysOf(serialize.adminPageRow(pageRow)), ADMIN_PAGE);
  assert.deepEqual(keysOf(serialize.adminPageRow(pageRow, { linkCount: 1 })), [...ADMIN_PAGE, 'linkCount'].sort());
  assert.deepEqual(keysOf(serialize.adminLinkRow(linkRow)), ADMIN_LINK);

  const reportRow = {
    id: 'r-1', page_id: 'page-1', page: { slug: 'augy', status: 'active' },
    link: { id: 'link-1', title: 'Site', url: 'https://example.com', removed_at: null },
    reason: 'scam', details: 'x', status: 'open', resolution_note: null, resolved_at: null, created_at: NOW,
  };
  const reported = serialize.adminReportRow(reportRow);
  assert.deepEqual(keysOf(reported), ADMIN_REPORT);
  assert.deepEqual(keysOf(reported.link), ADMIN_REPORT_LINK);
  assert.equal(serialize.adminReportRow({ ...reportRow, link: null }).link, null);

  const auditRow = { id: 'a-1', action: 'login.ok', actor_type: 'owner', actor_id: 'page-1', page_id: 'page-1', details: {}, created_at: NOW };
  assert.deepEqual(keysOf(serialize.adminAuditRow(auditRow)), ADMIN_AUDIT);

  const testimonialRow = { id: 't-1', quote: 'q', author: 'a', page_slug: 'augy', page_id: 'page-1', is_visible: true, status: 'approved', created_at: NOW, reviewed_at: NOW };
  assert.deepEqual(keysOf(serialize.adminTestimonialRow(testimonialRow)), ADMIN_TESTIMONIAL);

  const capRequestRow = {
    id: 'c-1', page_id: 'page-1', page: { slug: 'augy', display_name: 'Augy' }, status: 'pending', requested_cap: 30,
    current_cap: 20, reason: 'More', granted_cap: null, review_note: null, created_at: NOW, reviewed_at: null,
  };
  assert.deepEqual(keysOf(serialize.adminCapRequestRow(capRequestRow, { used: 3, limit: 20 })), ADMIN_CAP_REQUEST);
  assert.deepEqual(keysOf(serialize.adminCapPageRow(pageRow, 3)), ADMIN_CAP_PAGE);

  assert.deepEqual(keysOf(publicStaff({ id: 'u-1', username: 'mod', display_name: 'MOD', is_admin: true })), STAFF);
});

// ---------------------------------------------------------------------------
// Each route's answer, end to end on the fake database
// ---------------------------------------------------------------------------

let fake;
beforeEach(() => {
  fake = createFakeDb();
  useTestClient(fake);
  forgetBlockedDomains();
  forgetAllowedDomains();
  forgetBlockedPatterns();
  forgetReviewPatterns();
});

// A live page with an authenticator, signed in on the browser given.
async function makePage(owner, name = 'augy', password = 'correct horse battery') {
  const registered = await owner.call(register, { method: 'POST', body: { slug: name, password } });
  assert.equal(registered.status, 200, registered.body);
  const started = await owner.call(enrol, { method: 'POST', body: { challenge: registered.json.challenge, action: 'totp-start' } });
  const finished = await owner.call(enrol, { method: 'POST', body: { challenge: registered.json.challenge, action: 'totp-finish', code: totpAt(started.json.secret) } });
  assert.equal(finished.status, 200, finished.body);
  return { registered, started, finished, secret: started.json.secret, password };
}

// A staff account on the shared gftvhello_users table.
async function makeStaff(username, role) {
  const secret = generateTotpSecret();
  fake.table('gftvhello_users').push({
    id: crypto.randomUUID(), username, display_name: username.toUpperCase(), email: `${username}@gftv.asia`,
    password_hash: await bcrypt.hash('staff password 1', 10), is_admin: role === 'admin', is_editor: role === 'editor',
    is_approved: true, totp_secret: secret,
  });
  return secret;
}

async function staffSignIn(staff, username, secret) {
  const step = await staff.call(adminAuth, { method: 'POST', body: { action: 'login', identifier: username, password: 'staff password 1' } });
  assert.equal(step.status, 200, step.body);
  const signedIn = await staff.call(adminAuth, { method: 'POST', body: { action: 'verify', challenge: step.json.challenge, method: 'totp', code: totpAt(secret) } });
  assert.equal(signedIn.status, 200, signedIn.body);
  return { step, signedIn };
}

test('replies: checking a name, signing up, signing in', async () => {
  const visitor = browser();
  assert.deepEqual(keysOf((await visitor.call(slug, { query: { slug: 'augy' } })).json), ['available', 'ok', 'reason', 'review', 'slug']);
  assert.deepEqual(keysOf((await visitor.call(slug, { query: { slug: 'a' } })).json), ['available', 'ok', 'reason']);

  const owner = browser();
  const { registered, started, finished, secret, password } = await makePage(owner);
  assert.deepEqual(keysOf(registered.json), ['challenge', 'ok', 'review', 'slug']);
  assert.deepEqual(keysOf(started.json), ['ok', 'secret', 'uri']);
  assert.deepEqual(keysOf(finished.json), ['backupCodes', 'ok', 'slug']);

  assert.deepEqual(keysOf((await owner.call(session)).json), ['ok', 'signedIn', 'slug']);
  assert.deepEqual(keysOf((await browser().call(session)).json), ['ok', 'signedIn']);

  const other = browser();
  const step = await other.call(login, { method: 'POST', body: { slug: 'augy', password } });
  assert.deepEqual(keysOf(step.json), ['challenge', 'methods', 'ok']);
  const verified = await other.call(verify, { method: 'POST', body: { challenge: step.json.challenge, method: 'totp', code: totpAt(secret) } });
  assert.deepEqual(keysOf(verified.json), ['backupCodesLeft', 'ok', 'slug']);

  assert.deepEqual(keysOf((await browser().call(recover, { method: 'POST', body: { action: 'start', slug: 'augy' } })).json), ['ok', 'telegram']);
});

test('replies: the editor page, links and security', async () => {
  const owner = browser();
  const { password } = await makePage(owner);
  const added = await owner.call(meLinks, { method: 'POST', body: { title: 'Site', url: 'https://example.com' } });
  assert.deepEqual(keysOf(added.json), ['linkCap', 'links', 'ok']);
  assert.deepEqual(keysOf(added.json.links[0]), OWNER_LINK);
  assert.deepEqual(keysOf(added.json.linkCap), OWNER_LINK_CAP);

  const view = await owner.call(mePage);
  assert.deepEqual(keysOf(view.json), ['ok', 'page']);
  assert.deepEqual(keysOf(view.json.page), OWNER_PAGE);
  assert.deepEqual(keysOf(view.json.page.linkCap), OWNER_LINK_CAP);
  assert.equal(view.json.page.linkCapRequest, null);
  assert.deepEqual(keysOf(view.json.page.rename), ['available', 'nextAt', 'previous']);
  assert.deepEqual(keysOf(view.json.page.security), OWNER_SECURITY);
  assert.deepEqual(keysOf(view.json.page.security.telegram), ['linked']);
  assert.deepEqual(keysOf(view.json.page.links[0]), OWNER_LINK);

  const saved = await owner.call(mePage, { method: 'PATCH', body: { displayName: 'Augy' } });
  assert.deepEqual(keysOf(saved.json), ['ok', 'page']);
  assert.deepEqual(keysOf((await owner.call(meAvatar, { method: 'DELETE', body: {} })).json), ['ok', 'page']);

  const codes = await owner.call(security, { method: 'POST', body: { action: 'backup-regenerate', password } });
  assert.deepEqual(keysOf(codes.json), ['backupCodes', 'ok', 'page']);
  assert.deepEqual(keysOf(codes.json.page), OWNER_PAGE);

  const names = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET'];
  const before = names.map((name) => process.env[name]);
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'onelink_test_bot';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret';
  try {
    const telegramLink = await owner.call(security, { method: 'POST', body: { action: 'telegram-link', password } });
    assert.deepEqual(keysOf(telegramLink.json), ['expiresInMinutes', 'ok', 'url']);
  } finally {
    names.forEach((name, index) => {
      if (before[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = before[index];
      }
    });
  }
});

test('replies: stats, testimonial and the link limit request', async () => {
  const owner = browser();
  await makePage(owner);
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Site', url: 'https://example.com' } })).json;
  await browser().call(visit, {
    method: 'POST', ip: '203.0.113.1', body: { slug: 'augy', referrer: 'https://www.instagram.com/' },
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', 'x-vercel-ip-country': 'SG' },
  });
  await browser().call(click, { method: 'POST', body: { id: links[0].id } });

  const stats = (await owner.call(meStats, { query: { days: '7' } })).json;
  assert.deepEqual(keysOf(stats), ['countries', 'daily', 'days', 'devices', 'ok', 'referrers', 'totals']);
  assert.deepEqual(keysOf(stats.totals), ['clicks', 'visits']);
  assert.deepEqual(keysOf(stats.daily[0]), ['clicks', 'day', 'visits']);
  assert.deepEqual(keysOf(stats.countries[0]), ['hits', 'key']);
  assert.deepEqual(keysOf(stats.devices[0]), ['hits', 'key']);
  assert.deepEqual(keysOf(stats.referrers[0]), ['hits', 'key']);

  assert.deepEqual(keysOf((await owner.call(meTestimonial)).json), ['ok', 'testimonial']);
  const sent = await owner.call(meTestimonial, { method: 'POST', body: { quote: 'Made my con badge QR in a minute', consent: true } });
  assert.deepEqual(keysOf(sent.json), ['ok', 'testimonial']);
  assert.deepEqual(keysOf(sent.json.testimonial), OWNER_TESTIMONIAL);

  assert.deepEqual(keysOf((await owner.call(meLinkCap)).json), ['linkCap', 'ok', 'request']);
  const asked = await owner.call(meLinkCap, { method: 'POST', body: { requested: 30, reason: 'More conventions' } });
  assert.deepEqual(keysOf(asked.json), ['linkCap', 'ok', 'request']);
  assert.deepEqual(keysOf(asked.json.linkCap), OWNER_LINK_CAP);
  assert.deepEqual(keysOf(asked.json.request), OWNER_CAP_REQUEST);
  assert.deepEqual(keysOf((await owner.call(mePage)).json.page.linkCapRequest), OWNER_CAP_REQUEST);
});

test('replies: what visitors see', async () => {
  const owner = browser();
  await makePage(owner);
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Site', url: 'https://example.com' } })).json;

  const shown = await browser().call(publicPage, { query: { slug: 'augy' } });
  assert.deepEqual(keysOf(shown.json), ['ok', 'page']);
  assert.deepEqual(keysOf(shown.json.page), PUBLIC_PAGE);
  assert.deepEqual(keysOf(shown.json.page.links[0]), PUBLIC_LINK);
  assert.equal(shown.json.page.team, null);

  // The page drawn on the server carries the same page in its data block.
  const html = (await browser().call(render, { query: { slug: 'augy' } })).body;
  const data = JSON.parse(html.match(/<script type="application\/json" id="pageData">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(keysOf(data), ['page', 'state']);
  assert.deepEqual(keysOf(data.page), PUBLIC_PAGE);
  assert.deepEqual(keysOf(data.page.links[0]), PUBLIC_LINK);

  const visitor = browser();
  const counted = await visitor.call(visit, {
    method: 'POST', ip: '203.0.113.1', body: { slug: 'augy', referrer: 'https://www.instagram.com/' },
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', 'x-vercel-ip-country': 'SG' },
  });
  assert.deepEqual(keysOf(counted.json), ['counted', 'ok']);
  assert.deepEqual(keysOf((await visitor.call(click, { method: 'POST', body: { id: links[0].id } })).json), ['ok']);
  const reported = await visitor.call(report, { method: 'POST', body: { slug: 'augy', linkId: links[0].id, reason: 'scam' } });
  assert.deepEqual(keysOf(reported.json), ['ok', 'received']);

  const insights = (await browser().call(publicInsights)).json;
  assert.deepEqual(keysOf(insights), ['clicks', 'country', 'daily', 'devices', 'ok', 'pages', 'referrer', 'visits']);
  assert.deepEqual(keysOf(insights.daily[0]), ['clicks', 'day']);
  assert.deepEqual(keysOf(insights.devices), ['desktop', 'mobile', 'others', 'tablet']);
  assert.deepEqual(keysOf(insights.country), ['hits', 'key']);
  assert.deepEqual(keysOf(insights.referrer), ['hits', 'key', 'share']);

  assert.deepEqual(keysOf((await browser().call(publicTurnstile)).json), ['ok', 'siteKey']);

  fake.table('gftvonelink_pages')[0].team_verified_at = new Date().toISOString();
  const team = (await browser().call(publicTeam)).json;
  assert.deepEqual(keysOf(team), ['members', 'ok']);
  assert.deepEqual(keysOf(team.members[0]), TEAM_MEMBER);
  assert.deepEqual(keysOf((await browser().call(publicPage, { query: { slug: 'augy' } })).json.page.team), TEAM);

  const secret = await makeStaff('boss', 'admin');
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  await admin.call(adminTestimonials, { method: 'POST', body: { action: 'add', quote: 'Lovely', author: 'Someone' } });
  const quotes = (await browser().call(publicTestimonials)).json;
  assert.deepEqual(keysOf(quotes), ['ok', 'testimonials']);
  assert.equal(quotes.testimonials.length, 1);
  assert.deepEqual(keysOf(quotes.testimonials[0]), PUBLIC_TESTIMONIAL);
});

test('replies: the staff dashboard', async () => {
  const owner = browser();
  await makePage(owner);
  const { links } = (await owner.call(meLinks, { method: 'POST', body: { title: 'Site', url: 'https://example.com' } })).json;
  await browser().call(report, { method: 'POST', body: { slug: 'augy', linkId: links[0].id, reason: 'scam', details: 'fake shop' } });
  await owner.call(meLinkCap, { method: 'POST', body: { requested: 30, reason: 'More conventions' } });
  await owner.call(meTestimonial, { method: 'POST', body: { quote: 'Made my con badge QR in a minute', consent: true } });
  const pageId = fake.table('gftvonelink_pages')[0].id;

  const secret = await makeStaff('boss', 'admin');
  const admin = browser();
  const { step, signedIn } = await staffSignIn(admin, 'boss', secret);
  assert.deepEqual(keysOf(step.json), ['challenge', 'methods', 'ok']);
  assert.deepEqual(keysOf(signedIn.json), ['ok', 'staff']);
  assert.deepEqual(keysOf(signedIn.json.staff), STAFF);
  const current = await admin.call(adminAuth);
  assert.deepEqual(keysOf(current.json), ['ok', 'staff']);
  assert.deepEqual(keysOf(current.json.staff), STAFF);

  const overview = (await admin.call(adminOverview)).json;
  assert.deepEqual(keysOf(overview), ['counts', 'ok', 'staff']);
  assert.deepEqual(keysOf(overview.staff), STAFF);
  assert.deepEqual(keysOf(overview.counts), [
    'active', 'awaitingReview', 'banned', 'linkCapRequests', 'links', 'openReports', 'pending', 'pendingTestimonials',
    'quarantined', 'removed',
  ]);

  const pages = (await admin.call(adminPages)).json;
  assert.deepEqual(keysOf(pages), ['offset', 'ok', 'pageSize', 'pages', 'total']);
  assert.deepEqual(keysOf(pages.pages[0]), [...ADMIN_PAGE, 'linkCount', 'renamedFrom', 'reportCount'].sort());

  const detail = (await admin.call(adminPages, { query: { id: pageId } })).json;
  assert.deepEqual(keysOf(detail), ['linkCap', 'links', 'ok', 'page', 'reports']);
  assert.deepEqual(keysOf(detail.page), [...ADMIN_PAGE, 'renamedFrom'].sort());
  assert.deepEqual(keysOf(detail.links[0]), ADMIN_LINK);
  assert.deepEqual(keysOf(detail.reports[0]), ADMIN_REPORT);
  assert.deepEqual(keysOf(detail.reports[0].link), ADMIN_REPORT_LINK);
  assert.deepEqual(keysOf(detail.linkCap), ['custom', 'defaultCap', 'limit', 'used']);

  const verified = (await admin.call(adminPages, { method: 'POST', body: { action: 'verify', id: pageId } })).json;
  assert.deepEqual(keysOf(verified), ['ok', 'page']);
  assert.deepEqual(keysOf(verified.page), ADMIN_PAGE);

  const linkList = (await admin.call(adminLinks)).json;
  assert.deepEqual(keysOf(linkList), ['links', 'offset', 'ok', 'pageSize', 'total']);
  assert.deepEqual(keysOf(linkList.links[0]), ADMIN_LINK);

  const reportList = (await admin.call(adminReports)).json;
  assert.deepEqual(keysOf(reportList), ['offset', 'ok', 'pageSize', 'reports', 'total']);
  assert.deepEqual(keysOf(reportList.reports[0]), ADMIN_REPORT);
  assert.deepEqual(keysOf(reportList.reports[0].link), ADMIN_REPORT_LINK);
  const resolved = (await admin.call(adminReports, { method: 'POST', body: { action: 'resolve', id: reportList.reports[0].id, note: 'phishing', removeLink: true } })).json;
  assert.deepEqual(keysOf(resolved), ['ok', 'report']);
  assert.deepEqual(keysOf(resolved.report), ADMIN_REPORT);

  const restored = (await admin.call(adminLinks, { method: 'POST', body: { action: 'restore', id: links[0].id } })).json;
  assert.deepEqual(keysOf(restored), ['link', 'ok']);
  assert.deepEqual(keysOf(restored.link), ADMIN_LINK);

  const audit = (await admin.call(adminAudit)).json;
  assert.deepEqual(keysOf(audit), ['entries', 'offset', 'ok', 'pageSize', 'total']);
  assert.deepEqual(keysOf(audit.entries[0]), [...ADMIN_AUDIT, 'actorName'].sort());

  const testimonials = (await admin.call(adminTestimonials)).json;
  assert.deepEqual(keysOf(testimonials), ['ok', 'testimonials']);
  assert.deepEqual(keysOf(testimonials.testimonials[0]), ADMIN_TESTIMONIAL);

  await admin.call(adminLinkCaps, { method: 'POST', body: { action: 'set-page', id: pageId, cap: 25 } });
  const caps = (await admin.call(adminLinkCaps)).json;
  assert.deepEqual(keysOf(caps), ['custom', 'defaultCap', 'maxCap', 'ok', 'pending']);
  assert.deepEqual(keysOf(caps.pending[0]), ADMIN_CAP_REQUEST);
  assert.deepEqual(keysOf(caps.custom[0]), ADMIN_CAP_PAGE);
  const editorSecret = await makeStaff('ed', 'editor');
  const editor = browser();
  await staffSignIn(editor, 'ed', editorSecret);
  assert.deepEqual(keysOf((await editor.call(adminLinkCaps)).json), ['defaultCap', 'maxCap', 'ok', 'pending'], 'editors get no custom list');

  assert.deepEqual(keysOf((await admin.call(adminPasskeys)).json), ['ok', 'passkeys']);
});

test('replies: the block lists', async () => {
  const owner = browser();
  await makePage(owner);
  const created = new Date().toISOString();
  fake.table('gftvonelink_blocked_slugs').push({ slug: 'squatter', reason: 'x', created_at: created });
  fake.table('gftvonelink_blocked_domains').push({ domain: 'evil.example', reason: 'x', created_at: created });
  fake.table('gftvonelink_allowed_domains').push({ domain: 'good.example', reason: 'x', created_at: created });
  fake.table('gftvonelink_blocked_patterns').push({ id: crypto.randomUUID(), pattern: 'promo', applies_to: 'links', reason: null, created_at: created });
  fake.table('gftvonelink_review_patterns').push({ id: crypto.randomUUID(), pattern: 'furcon', reason: null, created_at: created });
  const connection = 'c'.repeat(64);
  const device = 'd'.repeat(64);
  fake.table('gftvonelink_rate_limits').push({ bucket: `badlink:ip:${connection}`, hits: IP_FLAG_AFTER, window_start: created });
  fake.table('gftvonelink_rate_limits').push({ bucket: `badvisitor:${device}:${connection}`, hits: 3, window_start: created });
  fake.table('gftvonelink_ip_bans').push({ ip_hash: connection, reason: 'x', page_ids: [fake.table('gftvonelink_pages')[0].id], created_by: null, created_at: created });

  const secret = await makeStaff('boss', 'admin');
  const admin = browser();
  await staffSignIn(admin, 'boss', secret);
  const lists = (await admin.call(adminBlocklist)).json;
  assert.deepEqual(keysOf(lists), ['allowed', 'banned', 'domains', 'flagged', 'flaggedVisitors', 'ok', 'patterns', 'reviews', 'slugs', 'threatList']);
  for (const name of ['slugs', 'domains', 'allowed']) {
    assert.deepEqual(keysOf(lists[name][0]), ['createdAt', 'reason', 'value'], name);
  }
  assert.deepEqual(keysOf(lists.patterns[0]), ['appliesTo', 'createdAt', 'id', 'reason', 'value']);
  assert.deepEqual(keysOf(lists.reviews[0]), ['createdAt', 'id', 'reason', 'value']);
  assert.deepEqual(keysOf(lists.threatList), ['off']);
  assert.deepEqual(keysOf(lists.flagged[0]), ['attempts', 'id', 'since', 'slug']);
  assert.deepEqual(keysOf(lists.flaggedVisitors[0]), ['connection', 'device', 'id', 'requests', 'since', 'slug']);
  assert.deepEqual(keysOf(lists.banned[0]), ['byStaff', 'devices', 'id', 'reason', 'since', 'slugs']);

  const removed = (await admin.call(adminBlocklist, { method: 'POST', body: { action: 'remove-slug', value: 'squatter' } })).json;
  assert.deepEqual(keysOf(removed), keysOf(lists), 'a change answers with the lists again');
});
