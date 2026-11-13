// The signed-in owner's link limit, and asking for a higher one (migration 013).
//
// GET                          -> { linkCap, request }
// POST { requested, reason }   ask an admin for a limit of `requested` links.
//                              One open request at a time.
// DELETE                       withdraw the open request
//
// linkCap is { used, limit, custom }; request is the latest one, whatever an
// admin decided, or null (see ownerCapRequest in serialize.js).

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, LIMITS, MAX_LINKS } from '../_lib/validate.js';
import { limited, audit, refusedForBan } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { ownerLinkCap, ownerCapRequest } from '../_lib/serialize.js';
import { linkCapFor, linksUsed, latestCapRequest, checkCap } from '../_lib/link-cap.js';

async function usedLinks(pageId) {
  const { data, error } = await database().from(TABLES.links).select('id, removed_at').eq('page_id', pageId);
  if (error) throw error;
  return linksUsed(data);
}

export default route('me/link-cap', async (request, response) => {
  if (guard(request, response, ['GET', 'POST', 'DELETE'])) return;
  const owner = await requireOwner(request, response);
  if (!owner) return;
  const pageId = owner.page.id;
  const answer = async () => {
    const [cap, used, capRequest] = await Promise.all([linkCapFor(pageId), usedLinks(pageId), latestCapRequest(pageId)]);
    return ok(response, { linkCap: ownerLinkCap(cap, used), request: ownerCapRequest(capRequest) });
  };
  if (request.method === 'GET') return answer();

  const body = await readJson(request, response);
  if (!body) return;
  if (await limited(request, response, 'ownerWrite', [`page:${pageId}`])) return;

  if (request.method === 'DELETE') {
    const { error } = await database()
      .from(TABLES.linkCapRequests)
      .update({ status: 'withdrawn' })
      .eq('page_id', pageId)
      .eq('status', 'pending');
    if (error) throw error;
    return answer();
  }

  if (await refusedForBan(request, response, { pageId })) return;
  const cap = await linkCapFor(pageId);
  const requested = checkCap(body.requested);
  if (requested === null) return fail(response, 400, 'cap_invalid', { max: MAX_LINKS });
  if (requested <= cap.limit) return fail(response, 400, 'cap_not_higher', { limit: cap.limit });
  const reason = cleanText(body.reason, LIMITS.reason, { multiline: true });
  if (!reason) return fail(response, 400, 'cap_reason_required');
  const open = await latestCapRequest(pageId);
  if (open?.status === 'pending') return fail(response, 409, 'cap_request_open');
  if (await limited(request, response, 'capRequest', [`page:${pageId}`])) return;

  const { error } = await database()
    .from(TABLES.linkCapRequests)
    .insert({ page_id: pageId, requested_cap: requested, current_cap: cap.limit, reason });
  // Two sent at once: the unique index on open requests lets one through.
  if (error?.code === '23505') return fail(response, 409, 'cap_request_open');
  if (error) throw error;
  await audit(request, { action: 'page.link_cap_requested', actorType: 'owner', actorId: pageId, pageId, details: { requested, from: cap.limit } });
  return answer();
});
