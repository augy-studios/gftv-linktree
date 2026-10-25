// The signed-in owner's testimonial for the home page (migration 010).
//
// GET                         -> { testimonial } or { testimonial: null }
// POST { quote, consent }     send one; it waits for an admin or editor.
//                             Sending again replaces it and it waits again.
// DELETE                      withdraw it
//
// It is shown under the page's display name (or its name), linked to the
// page, so the owner has to agree to that (consent: true).

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { cleanText, LIMITS } from '../_lib/validate.js';
import { limited, audit, addressRefusedInText, refusedForBan } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { ownerTestimonial } from '../_lib/serialize.js';

async function mine(pageId) {
  const { data, error } = await db().from(T.testimonials).select('id, quote, status, created_at, reviewed_at').eq('page_id', pageId).maybeSingle();
  if (error) throw error;
  return data;
}

export default route('me/testimonial', async (req, res) => {
  if (guard(req, res, ['GET', 'POST', 'DELETE'])) return;
  const owner = await requireOwner(req, res);
  if (!owner) return;
  const page = owner.page;
  const answer = async () => ok(res, { testimonial: ownerTestimonial(await mine(page.id)) });
  if (req.method === 'GET') return answer();

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'ownerWrite', [`page:${page.id}`])) return;

  if (req.method === 'DELETE') {
    const { error } = await db().from(T.testimonials).delete().eq('page_id', page.id);
    if (error) throw error;
    return answer();
  }

  if (await refusedForBan(req, res, { pageId: owner.page.id })) return;
  if (body.consent !== true) return fail(res, 400, 'testimonial_consent');
  const quote = cleanText(body.quote, LIMITS.quote, { multiline: true });
  if (!quote) return fail(res, 400, 'testimonial_required');
  const refused = await addressRefusedInText(quote);
  if (refused) return fail(res, 400, 'text_address', { host: refused.host });

  const fields = {
    quote,
    author: cleanText(page.display_name || page.slug, LIMITS.author),
    page_slug: page.slug,
    status: 'pending',
    is_visible: true,
    consented_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null,
  };
  const existing = await mine(page.id);
  if (existing) {
    const { error } = await db().from(T.testimonials).update(fields).eq('id', existing.id);
    if (error) throw error;
  } else {
    const { data: last, error: lastError } = await db().from(T.testimonials).select('order_index').order('order_index', { ascending: false }).limit(1);
    if (lastError) throw lastError;
    const { error } = await db().from(T.testimonials).insert({ ...fields, page_id: page.id, order_index: (last?.[0]?.order_index ?? -1) + 1 });
    if (error) throw error;
  }
  await audit(req, { action: 'page.testimonial_sent', actorType: 'owner', actorId: page.id, pageId: page.id });
  return answer();
});
