// Blocked slugs, domains and patterns. Admin only.
//
// GET                                         -> { slugs, domains, patterns }
// POST { action: "add-slug", value, reason }
// POST { action: "remove-slug", value }
// POST { action: "add-domain", value, reason }
// POST { action: "remove-domain", value }
// POST { action: "add-allowed", value, reason }  a domain that skips the
//                                                threat lists (014)
// POST { action: "remove-allowed", value }
// POST { action: "add-pattern", value, appliesTo, reason }
// POST { action: "remove-pattern", id }
// POST { action: "add-review", value, reason }    names that need approval
// POST { action: "remove-review", id }
// POST { action: "refresh-threat-list" }        rebuild the domain blocklist
//                                                index now (domain-blocklist.js)
// POST { action: "unflag-connection", id }       lift a connection's flag for
//                                                repeated harmful addresses
// POST { action: "ban-connection", id, reason }  ban a flagged connection
// POST { action: "unban-connection", id }        lift a ban (009), and the
//                                                devices banned with it (012)
// POST { action: "unflag-visitor", id }          a flagged device is not the
//                                                banned person: lift its bans
// POST { action: "ban-visitor", id, reason }     it is: ban the connection it
//                                                was flagged on
//
// Blocking a slug stops it being registered; a page already on it is banned
// separately. Blocking a domain refuses new links to it and hides existing
// ones from visitors within a minute. A pattern is a regular expression
// (validate.js checkPattern) matched without regard to case against link
// addresses, page names, or both; for links it works like a domain block,
// for names like a slug block.
//
// An allowed domain, and any subdomain of it, skips the threat lists (the
// HaGeZi blocklists and Google Safe Browsing) when a link is saved and in the
// daily re-check, for a site they caught by mistake. The staff lists above
// still apply to it.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, normaliseSlug, normaliseDomain, checkPattern, isUuid, PATTERN_SCOPES, LIMITS } from '../_lib/validate.js';
import { limited, audit, forgetBlockedDomains, forgetAllowedDomains, forgetBlockedPatterns, forgetReviewPatterns, flaggedConnections, unflagConnection, bannedConnections, banFlaggedConnection, unbanConnection, flaggedVisitors, unflagVisitor, banFlaggedVisitor } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { rebuildDomainBlocklist, domainBlocklistInfo } from '../_lib/domain-blocklist.js';
import { missingSchema } from '../_lib/link-cap.js';

// Everything the block lists tab shows: the five staff lists, the threat
// list's state, and the flagged and banned connections and devices.
async function lists() {
  const [{ data: slugs, error }, { data: domains, error: domainError }, { data: allowed, error: allowedError }, { data: patterns, error: patternError }, { data: reviews, error: reviewError }] = await Promise.all([
    database().from(TABLES.blockedSlugs).select('slug, reason, created_at').order('slug'),
    database().from(TABLES.blockedDomains).select('domain, reason, created_at').order('domain'),
    database().from(TABLES.allowedDomains).select('domain, reason, created_at').order('domain'),
    database().from(TABLES.blockedPatterns).select('id, pattern, applies_to, reason, created_at').order('created_at'),
    database().from(TABLES.reviewPatterns).select('id, pattern, reason, created_at').order('created_at'),
  ]);
  // Before migration 014 the allowed list is empty rather than an error.
  let allowedFailed = null;
  if (allowedError && !missingSchema(allowedError)) {
    allowedFailed = allowedError;
  }
  if (error) {
    throw error;
  }
  if (domainError) {
    throw domainError;
  }
  if (allowedFailed) {
    throw allowedFailed;
  }
  if (patternError) {
    throw patternError;
  }
  if (reviewError) {
    throw reviewError;
  }
  let slugRows = [];
  if (slugs) {
    slugRows = slugs;
  }
  let domainRows = [];
  if (domains) {
    domainRows = domains;
  }
  let allowedRows = [];
  if (!allowedError && allowed) {
    allowedRows = allowed;
  }
  let patternRows = [];
  if (patterns) {
    patternRows = patterns;
  }
  let reviewRows = [];
  if (reviews) {
    reviewRows = reviews;
  }
  return {
    slugs: slugRows.map((row) => ({ value: row.slug, reason: row.reason, createdAt: row.created_at })),
    domains: domainRows.map((row) => ({ value: row.domain, reason: row.reason, createdAt: row.created_at })),
    allowed: allowedRows.map((row) => ({ value: row.domain, reason: row.reason, createdAt: row.created_at })),
    patterns: patternRows.map((row) => ({ id: row.id, value: row.pattern, appliesTo: row.applies_to, reason: row.reason, createdAt: row.created_at })),
    reviews: reviewRows.map((row) => ({ id: row.id, value: row.pattern, reason: row.reason, createdAt: row.created_at })),
    threatList: await domainBlocklistInfo(),
    flagged: await flaggedConnections(),
    flaggedVisitors: await flaggedVisitors(),
    banned: await bannedConnections(),
  };
}

// Every action that succeeds answers with all the lists again.
async function answerWithLists(response) {
  ok(response, await lists());
}

// The actions. Each one ends the request: with an error, or with all the
// lists again.

// add-slug: a name nobody can register.
async function addSlug({ request, response, body, staff, reason, actor }) {
  const slug = normaliseSlug(body.value);
  if (!/^[a-z0-9-]{1,32}$/.test(slug)) {
    return fail(response, 400, 'slug_invalid');
  }
  const { error } = await database().from(TABLES.blockedSlugs).upsert({ slug, reason, created_by: staff.user.id });
  if (error) {
    throw error;
  }
  await audit(request, { action: 'mod.slug_blocked', ...actor, details: { slug, reason } });
  return answerWithLists(response);
}

// remove-slug
async function removeSlug({ request, response, body, actor }) {
  const slug = normaliseSlug(body.value);
  const { error } = await database().from(TABLES.blockedSlugs).delete().eq('slug', slug);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'mod.slug_unblocked', ...actor, details: { slug } });
  return answerWithLists(response);
}

// add-domain: refuses new links to it and hides existing ones.
async function addDomain({ request, response, body, staff, reason, actor }) {
  const domain = normaliseDomain(body.value);
  if (!domain) {
    return fail(response, 400, 'domain_invalid');
  }
  const { error } = await database().from(TABLES.blockedDomains).upsert({ domain, reason, created_by: staff.user.id });
  if (error) {
    throw error;
  }
  forgetBlockedDomains();
  await audit(request, { action: 'mod.domain_blocked', ...actor, details: { domain, reason } });
  return answerWithLists(response);
}

// remove-domain
async function removeDomain({ request, response, body, actor }) {
  const domain = normaliseDomain(body.value);
  if (!domain) {
    return fail(response, 400, 'domain_invalid');
  }
  const { error } = await database().from(TABLES.blockedDomains).delete().eq('domain', domain);
  if (error) {
    throw error;
  }
  forgetBlockedDomains();
  await audit(request, { action: 'mod.domain_unblocked', ...actor, details: { domain } });
  return answerWithLists(response);
}

// add-allowed: a domain that skips the threat lists.
async function addAllowed({ request, response, body, staff, reason, actor }) {
  const domain = normaliseDomain(body.value);
  if (!domain) {
    return fail(response, 400, 'domain_invalid');
  }
  const { error } = await database().from(TABLES.allowedDomains).upsert({ domain, reason, created_by: staff.user.id });
  if (error) {
    throw error;
  }
  forgetAllowedDomains();
  await audit(request, { action: 'mod.domain_allowed', ...actor, details: { domain, reason } });
  return answerWithLists(response);
}

// remove-allowed
async function removeAllowed({ request, response, body, actor }) {
  const domain = normaliseDomain(body.value);
  if (!domain) {
    return fail(response, 400, 'domain_invalid');
  }
  const { error } = await database().from(TABLES.allowedDomains).delete().eq('domain', domain);
  if (error) {
    throw error;
  }
  forgetAllowedDomains();
  await audit(request, { action: 'mod.domain_unallowed', ...actor, details: { domain } });
  return answerWithLists(response);
}

// add-pattern: a regular expression for link addresses, page names or both.
async function addPattern({ request, response, body, staff, reason, actor }) {
  const check = checkPattern(body.value);
  if (!check.ok) {
    return fail(response, 400, check.error);
  }
  let appliesTo;
  if (PATTERN_SCOPES.has(body.appliesTo)) {
    appliesTo = body.appliesTo;
  } else {
    appliesTo = 'links';
  }
  const { error } = await database().from(TABLES.blockedPatterns).insert({ pattern: check.pattern, applies_to: appliesTo, reason, created_by: staff.user.id });
  if (error) {
    if (error.code === '23505') {
      return fail(response, 409, 'pattern_exists');
    }
    throw error;
  }
  forgetBlockedPatterns();
  await audit(request, { action: 'mod.pattern_blocked', ...actor, details: { pattern: check.pattern, appliesTo, reason } });
  return answerWithLists(response);
}

// remove-pattern: audited only when a pattern was there to remove.
async function removePattern({ request, response, body, actor }) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const { data, error } = await database().from(TABLES.blockedPatterns).delete().eq('id', body.id).select('pattern');
  if (error) {
    throw error;
  }
  forgetBlockedPatterns();
  if (data && data[0]) {
    await audit(request, { action: 'mod.pattern_unblocked', ...actor, details: { pattern: data[0].pattern } });
  }
  return answerWithLists(response);
}

// unflag-connection: lift a connection's flag for repeated harmful addresses.
async function liftConnectionFlag({ request, response, body, actor }) {
  if (!(await unflagConnection(body.id))) {
    return fail(response, 404, 'not_flagged');
  }
  await audit(request, { action: 'mod.connection_unflagged', ...actor, details: { connection: body.id } });
  return answerWithLists(response);
}

// ban-connection: ban a flagged connection.
async function banConnection({ request, response, body, staff, reason, actor }) {
  if (!(await banFlaggedConnection(body.id, staff.user.id, reason))) {
    return fail(response, 404, 'not_flagged');
  }
  await audit(request, { action: 'mod.connection_banned', ...actor, details: { connection: body.id, reason } });
  return answerWithLists(response);
}

// unban-connection: lift a ban, and the devices banned with it.
async function liftConnectionBan({ request, response, body, actor }) {
  if (!(await unbanConnection(body.id))) {
    return fail(response, 404, 'not_banned_connection');
  }
  await audit(request, { action: 'mod.connection_unbanned', ...actor, details: { connection: body.id } });
  return answerWithLists(response);
}

// unflag-visitor: a flagged device is not the banned person.
async function liftVisitorFlag({ request, response, body, actor }) {
  if (!(await unflagVisitor(body.id))) {
    return fail(response, 404, 'not_flagged_visitor');
  }
  await audit(request, { action: 'mod.visitor_unflagged', ...actor, details: { device: String(body.id).slice(0, 16) } });
  return answerWithLists(response);
}

// ban-visitor: it is; ban the connection it was flagged on. The id is the
// device (16 characters) followed by the connection.
async function banVisitor({ request, response, body, staff, reason, actor }) {
  if (!(await banFlaggedVisitor(body.id, staff.user.id, reason))) {
    return fail(response, 404, 'not_flagged_visitor');
  }
  await audit(request, { action: 'mod.visitor_banned', ...actor, details: { device: String(body.id).slice(0, 16), connection: String(body.id).slice(16), reason } });
  return answerWithLists(response);
}

// refresh-threat-list: rebuild the domain blocklist index now.
async function refreshThreatList({ request, response, actor }) {
  const result = await rebuildDomainBlocklist({ force: true });
  let categories = null;
  if (result.categories !== null && result.categories !== undefined) {
    categories = result.categories;
  }
  await audit(request, { action: 'mod.threat_list_refreshed', ...actor, details: { categories } });
  return answerWithLists(response);
}

// add-review: a name pattern that needs staff approval.
async function addReview({ request, response, body, staff, reason, actor }) {
  const check = checkPattern(body.value);
  if (!check.ok) {
    return fail(response, 400, check.error);
  }
  const { error } = await database().from(TABLES.reviewPatterns).insert({ pattern: check.pattern, reason, created_by: staff.user.id });
  if (error) {
    if (error.code === '23505') {
      return fail(response, 409, 'pattern_exists');
    }
    throw error;
  }
  forgetReviewPatterns();
  await audit(request, { action: 'mod.review_name_added', ...actor, details: { pattern: check.pattern, reason } });
  return answerWithLists(response);
}

// remove-review: audited only when a pattern was there to remove.
async function removeReview({ request, response, body, actor }) {
  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const { data, error } = await database().from(TABLES.reviewPatterns).delete().eq('id', body.id).select('pattern');
  if (error) {
    throw error;
  }
  forgetReviewPatterns();
  if (data && data[0]) {
    await audit(request, { action: 'mod.review_name_removed', ...actor, details: { pattern: data[0].pattern } });
  }
  return answerWithLists(response);
}

// Admins only. GET answers with all the lists. A POST checks the body and
// the staff write limit, then runs the action's step, which ends the
// request.
export default route('admin/blocklist', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const staff = await requireStaff(request, response, { admin: true });
  if (!staff) {
    return;
  }
  if (request.method === 'GET') {
    return ok(response, await lists());
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'staffWrite', [`staff:${staff.user.id}`])) {
    return;
  }
  let reason = cleanText(body.reason, LIMITS.reason);
  if (!reason) {
    reason = null;
  }
  const actor = { actorType: 'staff', actorId: staff.user.id };

  const context = { request, response, body, staff, reason, actor };
  switch (body.action) {
    case 'add-slug':
      return addSlug(context);
    case 'remove-slug':
      return removeSlug(context);
    case 'add-domain':
      return addDomain(context);
    case 'remove-domain':
      return removeDomain(context);
    case 'add-allowed':
      return addAllowed(context);
    case 'remove-allowed':
      return removeAllowed(context);
    case 'add-pattern':
      return addPattern(context);
    case 'remove-pattern':
      return removePattern(context);
    case 'unflag-connection':
      return liftConnectionFlag(context);
    case 'ban-connection':
      return banConnection(context);
    case 'unban-connection':
      return liftConnectionBan(context);
    case 'unflag-visitor':
      return liftVisitorFlag(context);
    case 'ban-visitor':
      return banVisitor(context);
    case 'refresh-threat-list':
      return refreshThreatList(context);
    case 'add-review':
      return addReview(context);
    case 'remove-review':
      return removeReview(context);
    default:
      return fail(response, 400, 'bad_request');
  }
});
