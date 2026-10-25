// Blocked slugs, domains and patterns. Admin only.
//
// GET                                         -> { slugs, domains, patterns }
// POST { action: "add-slug", value, reason }
// POST { action: "remove-slug", value }
// POST { action: "add-domain", value, reason }
// POST { action: "remove-domain", value }
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

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, normaliseSlug, normaliseDomain, checkPattern, isUuid, PATTERN_SCOPES, LIMITS } from '../_lib/validate.js';
import { limited, audit, forgetBlockedDomains, forgetBlockedPatterns, forgetReviewPatterns, flaggedConnections, unflagConnection, bannedConnections, banFlaggedConnection, unbanConnection, flaggedVisitors, unflagVisitor, banFlaggedVisitor } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { rebuildDomainBlocklist, domainBlocklistInfo } from '../_lib/domain-blocklist.js';

async function lists() {
  const [{ data: slugs, error }, { data: domains, error: domainError }, { data: patterns, error: patternError }, { data: reviews, error: reviewError }] = await Promise.all([
    db().from(T.blockedSlugs).select('slug, reason, created_at').order('slug'),
    db().from(T.blockedDomains).select('domain, reason, created_at').order('domain'),
    db().from(T.blockedPatterns).select('id, pattern, applies_to, reason, created_at').order('created_at'),
    db().from(T.reviewPatterns).select('id, pattern, reason, created_at').order('created_at'),
  ]);
  if (error || domainError || patternError || reviewError) throw error || domainError || patternError || reviewError;
  return {
    slugs: (slugs ?? []).map((r) => ({ value: r.slug, reason: r.reason, createdAt: r.created_at })),
    domains: (domains ?? []).map((r) => ({ value: r.domain, reason: r.reason, createdAt: r.created_at })),
    patterns: (patterns ?? []).map((r) => ({ id: r.id, value: r.pattern, appliesTo: r.applies_to, reason: r.reason, createdAt: r.created_at })),
    reviews: (reviews ?? []).map((r) => ({ id: r.id, value: r.pattern, reason: r.reason, createdAt: r.created_at })),
    threatList: await domainBlocklistInfo(),
    flagged: await flaggedConnections(),
    flaggedVisitors: await flaggedVisitors(),
    banned: await bannedConnections(),
  };
}

export default route('admin/blocklist', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const staff = await requireStaff(req, res, { admin: true });
  if (!staff) return;
  if (req.method === 'GET') return ok(res, await lists());

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'staffWrite', [`staff:${staff.user.id}`])) return;
  const reason = cleanText(body.reason, LIMITS.reason) || null;
  const actor = { actorType: 'staff', actorId: staff.user.id };

  switch (body.action) {
    case 'add-slug': {
      const slug = normaliseSlug(body.value);
      if (!/^[a-z0-9-]{1,32}$/.test(slug)) return fail(res, 400, 'slug_invalid');
      const { error } = await db().from(T.blockedSlugs).upsert({ slug, reason, created_by: staff.user.id });
      if (error) throw error;
      await audit(req, { action: 'mod.slug_blocked', ...actor, details: { slug, reason } });
      break;
    }
    case 'remove-slug': {
      const slug = normaliseSlug(body.value);
      const { error } = await db().from(T.blockedSlugs).delete().eq('slug', slug);
      if (error) throw error;
      await audit(req, { action: 'mod.slug_unblocked', ...actor, details: { slug } });
      break;
    }
    case 'add-domain': {
      const domain = normaliseDomain(body.value);
      if (!domain) return fail(res, 400, 'domain_invalid');
      const { error } = await db().from(T.blockedDomains).upsert({ domain, reason, created_by: staff.user.id });
      if (error) throw error;
      forgetBlockedDomains();
      await audit(req, { action: 'mod.domain_blocked', ...actor, details: { domain, reason } });
      break;
    }
    case 'remove-domain': {
      const domain = normaliseDomain(body.value);
      if (!domain) return fail(res, 400, 'domain_invalid');
      const { error } = await db().from(T.blockedDomains).delete().eq('domain', domain);
      if (error) throw error;
      forgetBlockedDomains();
      await audit(req, { action: 'mod.domain_unblocked', ...actor, details: { domain } });
      break;
    }
    case 'add-pattern': {
      const check = checkPattern(body.value);
      if (!check.ok) return fail(res, 400, check.error);
      const appliesTo = PATTERN_SCOPES.has(body.appliesTo) ? body.appliesTo : 'links';
      const { error } = await db().from(T.blockedPatterns).insert({ pattern: check.pattern, applies_to: appliesTo, reason, created_by: staff.user.id });
      if (error) {
        if (error.code === '23505') return fail(res, 409, 'pattern_exists');
        throw error;
      }
      forgetBlockedPatterns();
      await audit(req, { action: 'mod.pattern_blocked', ...actor, details: { pattern: check.pattern, appliesTo, reason } });
      break;
    }
    case 'remove-pattern': {
      if (!isUuid(body.id)) return fail(res, 400, 'bad_request');
      const { data, error } = await db().from(T.blockedPatterns).delete().eq('id', body.id).select('pattern');
      if (error) throw error;
      forgetBlockedPatterns();
      if (data?.[0]) await audit(req, { action: 'mod.pattern_unblocked', ...actor, details: { pattern: data[0].pattern } });
      break;
    }
    case 'unflag-connection': {
      if (!(await unflagConnection(body.id))) return fail(res, 404, 'not_flagged');
      await audit(req, { action: 'mod.connection_unflagged', ...actor, details: { connection: body.id } });
      break;
    }
    case 'ban-connection': {
      if (!(await banFlaggedConnection(body.id, staff.user.id, reason))) return fail(res, 404, 'not_flagged');
      await audit(req, { action: 'mod.connection_banned', ...actor, details: { connection: body.id, reason } });
      break;
    }
    case 'unban-connection': {
      if (!(await unbanConnection(body.id))) return fail(res, 404, 'not_banned_connection');
      await audit(req, { action: 'mod.connection_unbanned', ...actor, details: { connection: body.id } });
      break;
    }
    case 'unflag-visitor': {
      if (!(await unflagVisitor(body.id))) return fail(res, 404, 'not_flagged_visitor');
      await audit(req, { action: 'mod.visitor_unflagged', ...actor, details: { device: String(body.id).slice(0, 16) } });
      break;
    }
    case 'ban-visitor': {
      if (!(await banFlaggedVisitor(body.id, staff.user.id, reason))) return fail(res, 404, 'not_flagged_visitor');
      await audit(req, { action: 'mod.visitor_banned', ...actor, details: { device: String(body.id).slice(0, 16), connection: String(body.id).slice(16), reason } });
      break;
    }
    case 'refresh-threat-list': {
      const result = await rebuildDomainBlocklist({ force: true });
      await audit(req, { action: 'mod.threat_list_refreshed', ...actor, details: { categories: result.categories ?? null } });
      break;
    }
    case 'add-review': {
      const check = checkPattern(body.value);
      if (!check.ok) return fail(res, 400, check.error);
      const { error } = await db().from(T.reviewPatterns).insert({ pattern: check.pattern, reason, created_by: staff.user.id });
      if (error) {
        if (error.code === '23505') return fail(res, 409, 'pattern_exists');
        throw error;
      }
      forgetReviewPatterns();
      await audit(req, { action: 'mod.review_name_added', ...actor, details: { pattern: check.pattern, reason } });
      break;
    }
    case 'remove-review': {
      if (!isUuid(body.id)) return fail(res, 400, 'bad_request');
      const { data, error } = await db().from(T.reviewPatterns).delete().eq('id', body.id).select('pattern');
      if (error) throw error;
      forgetReviewPatterns();
      if (data?.[0]) await audit(req, { action: 'mod.review_name_removed', ...actor, details: { pattern: data[0].pattern } });
      break;
    }
    default:
      return fail(res, 400, 'bad_request');
  }
  ok(res, await lists());
});
