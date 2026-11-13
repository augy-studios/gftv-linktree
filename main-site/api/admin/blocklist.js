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

async function lists() {
  const [{ data: slugs, error }, { data: domains, error: domainError }, { data: allowed, error: allowedError }, { data: patterns, error: patternError }, { data: reviews, error: reviewError }] = await Promise.all([
    database().from(TABLES.blockedSlugs).select('slug, reason, created_at').order('slug'),
    database().from(TABLES.blockedDomains).select('domain, reason, created_at').order('domain'),
    database().from(TABLES.allowedDomains).select('domain, reason, created_at').order('domain'),
    database().from(TABLES.blockedPatterns).select('id, pattern, applies_to, reason, created_at').order('created_at'),
    database().from(TABLES.reviewPatterns).select('id, pattern, reason, created_at').order('created_at'),
  ]);
  // Before migration 014 the allowed list is empty rather than an error.
  const allowedFailed = allowedError && !missingSchema(allowedError) ? allowedError : null;
  if (error || domainError || allowedFailed || patternError || reviewError) throw error || domainError || allowedFailed || patternError || reviewError;
  return {
    slugs: (slugs ?? []).map((r) => ({ value: r.slug, reason: r.reason, createdAt: r.created_at })),
    domains: (domains ?? []).map((r) => ({ value: r.domain, reason: r.reason, createdAt: r.created_at })),
    allowed: (allowedError ? [] : allowed ?? []).map((r) => ({ value: r.domain, reason: r.reason, createdAt: r.created_at })),
    patterns: (patterns ?? []).map((r) => ({ id: r.id, value: r.pattern, appliesTo: r.applies_to, reason: r.reason, createdAt: r.created_at })),
    reviews: (reviews ?? []).map((r) => ({ id: r.id, value: r.pattern, reason: r.reason, createdAt: r.created_at })),
    threatList: await domainBlocklistInfo(),
    flagged: await flaggedConnections(),
    flaggedVisitors: await flaggedVisitors(),
    banned: await bannedConnections(),
  };
}

export default route('admin/blocklist', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) return;
  const staff = await requireStaff(request, response, { admin: true });
  if (!staff) return;
  if (request.method === 'GET') return ok(response, await lists());

  const body = await readJson(request, response);
  if (!body) return;
  if (await limited(request, response, 'staffWrite', [`staff:${staff.user.id}`])) return;
  const reason = cleanText(body.reason, LIMITS.reason) || null;
  const actor = { actorType: 'staff', actorId: staff.user.id };

  switch (body.action) {
    case 'add-slug': {
      const slug = normaliseSlug(body.value);
      if (!/^[a-z0-9-]{1,32}$/.test(slug)) return fail(response, 400, 'slug_invalid');
      const { error } = await database().from(TABLES.blockedSlugs).upsert({ slug, reason, created_by: staff.user.id });
      if (error) throw error;
      await audit(request, { action: 'mod.slug_blocked', ...actor, details: { slug, reason } });
      break;
    }
    case 'remove-slug': {
      const slug = normaliseSlug(body.value);
      const { error } = await database().from(TABLES.blockedSlugs).delete().eq('slug', slug);
      if (error) throw error;
      await audit(request, { action: 'mod.slug_unblocked', ...actor, details: { slug } });
      break;
    }
    case 'add-domain': {
      const domain = normaliseDomain(body.value);
      if (!domain) return fail(response, 400, 'domain_invalid');
      const { error } = await database().from(TABLES.blockedDomains).upsert({ domain, reason, created_by: staff.user.id });
      if (error) throw error;
      forgetBlockedDomains();
      await audit(request, { action: 'mod.domain_blocked', ...actor, details: { domain, reason } });
      break;
    }
    case 'remove-domain': {
      const domain = normaliseDomain(body.value);
      if (!domain) return fail(response, 400, 'domain_invalid');
      const { error } = await database().from(TABLES.blockedDomains).delete().eq('domain', domain);
      if (error) throw error;
      forgetBlockedDomains();
      await audit(request, { action: 'mod.domain_unblocked', ...actor, details: { domain } });
      break;
    }
    case 'add-allowed': {
      const domain = normaliseDomain(body.value);
      if (!domain) return fail(response, 400, 'domain_invalid');
      const { error } = await database().from(TABLES.allowedDomains).upsert({ domain, reason, created_by: staff.user.id });
      if (error) throw error;
      forgetAllowedDomains();
      await audit(request, { action: 'mod.domain_allowed', ...actor, details: { domain, reason } });
      break;
    }
    case 'remove-allowed': {
      const domain = normaliseDomain(body.value);
      if (!domain) return fail(response, 400, 'domain_invalid');
      const { error } = await database().from(TABLES.allowedDomains).delete().eq('domain', domain);
      if (error) throw error;
      forgetAllowedDomains();
      await audit(request, { action: 'mod.domain_unallowed', ...actor, details: { domain } });
      break;
    }
    case 'add-pattern': {
      const check = checkPattern(body.value);
      if (!check.ok) return fail(response, 400, check.error);
      const appliesTo = PATTERN_SCOPES.has(body.appliesTo) ? body.appliesTo : 'links';
      const { error } = await database().from(TABLES.blockedPatterns).insert({ pattern: check.pattern, applies_to: appliesTo, reason, created_by: staff.user.id });
      if (error) {
        if (error.code === '23505') return fail(response, 409, 'pattern_exists');
        throw error;
      }
      forgetBlockedPatterns();
      await audit(request, { action: 'mod.pattern_blocked', ...actor, details: { pattern: check.pattern, appliesTo, reason } });
      break;
    }
    case 'remove-pattern': {
      if (!isUuid(body.id)) return fail(response, 400, 'bad_request');
      const { data, error } = await database().from(TABLES.blockedPatterns).delete().eq('id', body.id).select('pattern');
      if (error) throw error;
      forgetBlockedPatterns();
      if (data?.[0]) await audit(request, { action: 'mod.pattern_unblocked', ...actor, details: { pattern: data[0].pattern } });
      break;
    }
    case 'unflag-connection': {
      if (!(await unflagConnection(body.id))) return fail(response, 404, 'not_flagged');
      await audit(request, { action: 'mod.connection_unflagged', ...actor, details: { connection: body.id } });
      break;
    }
    case 'ban-connection': {
      if (!(await banFlaggedConnection(body.id, staff.user.id, reason))) return fail(response, 404, 'not_flagged');
      await audit(request, { action: 'mod.connection_banned', ...actor, details: { connection: body.id, reason } });
      break;
    }
    case 'unban-connection': {
      if (!(await unbanConnection(body.id))) return fail(response, 404, 'not_banned_connection');
      await audit(request, { action: 'mod.connection_unbanned', ...actor, details: { connection: body.id } });
      break;
    }
    case 'unflag-visitor': {
      if (!(await unflagVisitor(body.id))) return fail(response, 404, 'not_flagged_visitor');
      await audit(request, { action: 'mod.visitor_unflagged', ...actor, details: { device: String(body.id).slice(0, 16) } });
      break;
    }
    case 'ban-visitor': {
      if (!(await banFlaggedVisitor(body.id, staff.user.id, reason))) return fail(response, 404, 'not_flagged_visitor');
      await audit(request, { action: 'mod.visitor_banned', ...actor, details: { device: String(body.id).slice(0, 16), connection: String(body.id).slice(16), reason } });
      break;
    }
    case 'refresh-threat-list': {
      const result = await rebuildDomainBlocklist({ force: true });
      await audit(request, { action: 'mod.threat_list_refreshed', ...actor, details: { categories: result.categories ?? null } });
      break;
    }
    case 'add-review': {
      const check = checkPattern(body.value);
      if (!check.ok) return fail(response, 400, check.error);
      const { error } = await database().from(TABLES.reviewPatterns).insert({ pattern: check.pattern, reason, created_by: staff.user.id });
      if (error) {
        if (error.code === '23505') return fail(response, 409, 'pattern_exists');
        throw error;
      }
      forgetReviewPatterns();
      await audit(request, { action: 'mod.review_name_added', ...actor, details: { pattern: check.pattern, reason } });
      break;
    }
    case 'remove-review': {
      if (!isUuid(body.id)) return fail(response, 400, 'bad_request');
      const { data, error } = await database().from(TABLES.reviewPatterns).delete().eq('id', body.id).select('pattern');
      if (error) throw error;
      forgetReviewPatterns();
      if (data?.[0]) await audit(request, { action: 'mod.review_name_removed', ...actor, details: { pattern: data[0].pattern } });
      break;
    }
    default:
      return fail(response, 400, 'bad_request');
  }
  ok(response, await lists());
});
