// Blocked slugs and blocked domains. Admin only.
//
// GET                                         -> { slugs, domains }
// POST { action: "add-slug", value, reason }
// POST { action: "remove-slug", value }
// POST { action: "add-domain", value, reason }
// POST { action: "remove-domain", value }
//
// Blocking a slug stops it being registered; a page already on it is banned
// separately. Blocking a domain refuses new links to it and hides existing
// ones from visitors within a minute.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, normaliseSlug, normaliseDomain, LIMITS } from '../_lib/validate.js';
import { limited, audit, forgetBlockedDomains } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';

async function lists() {
  const [{ data: slugs, error }, { data: domains, error: domainError }] = await Promise.all([
    db().from(T.blockedSlugs).select('slug, reason, created_at').order('slug'),
    db().from(T.blockedDomains).select('domain, reason, created_at').order('domain'),
  ]);
  if (error || domainError) throw error || domainError;
  return {
    slugs: (slugs ?? []).map((r) => ({ value: r.slug, reason: r.reason, createdAt: r.created_at })),
    domains: (domains ?? []).map((r) => ({ value: r.domain, reason: r.reason, createdAt: r.created_at })),
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
    default:
      return fail(res, 400, 'bad_request');
  }
  ok(res, await lists());
});
