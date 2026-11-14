// POST /api/public/report { slug, linkId?, reason, details?, cf-turnstile-response }
// A visitor flags a page, or one link on it, for staff to look at.
// cf-turnstile-response is the Cloudflare Turnstile token for action "report"
// (_lib/turnstile.js).

import { route, guard, readJson, ok, fail, clientIp } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { normaliseSlug, isUuid, cleanText, REPORT_REASONS, LIMITS } from '../_lib/validate.js';
import { hashIp } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { refusedForTurnstile } from '../_lib/turnstile.js';

// Applies the report rate limit and the Turnstile check, checks the reason,
// finds the live page (and the link, when one is named), then stores the
// report and writes it to the audit log.
export default route('public/report', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'report')) {
    return;
  }
  if (await refusedForTurnstile(request, response, body, 'report')) {
    return;
  }

  if (!REPORT_REASONS.has(body.reason)) {
    return fail(response, 400, 'report_reason');
  }
  const { data: page, error } = await database()
    .from(TABLES.pages)
    .select('id, status')
    .eq('slug', normaliseSlug(body.slug))
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!page || page.status !== 'active') {
    return fail(response, 404, 'page_not_found');
  }

  let linkId = null;
  if (body.linkId !== undefined && body.linkId !== null) {
    if (!isUuid(body.linkId)) {
      return fail(response, 400, 'bad_request');
    }
    const { data: link, error: linkError } = await database()
      .from(TABLES.links)
      .select('id')
      .eq('id', body.linkId)
      .eq('page_id', page.id)
      .maybeSingle();
    if (linkError) {
      throw linkError;
    }
    if (!link) {
      return fail(response, 404, 'link_not_found');
    }
    linkId = link.id;
  }

  const { data: report, error: insertError } = await database()
    .from(TABLES.reports)
    .insert({
      page_id: page.id,
      link_id: linkId,
      reason: body.reason,
      details: cleanText(body.details, LIMITS.reportDetails, { multiline: true }),
      reporter_hash: hashIp(clientIp(request)),
    })
    .select('id')
    .single();
  if (insertError) {
    throw insertError;
  }

  await audit(request, { action: 'report.created', actorType: 'visitor', pageId: page.id, details: { reportId: report.id, reason: body.reason, linkId } });
  ok(response, { received: true });
});
