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
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, LIMITS } from '../_lib/validate.js';
import { limited, audit, addressRefusedInText, refusedForBan } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { ownerTestimonial } from '../_lib/serialize.js';

// The page's own testimonial row, or null.
async function mine(pageId) {
  const { data, error } = await database().from(TABLES.testimonials).select('id, quote, status, created_at, reviewed_at').eq('page_id', pageId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// Signs the owner in. GET answers at once; DELETE (after the write rate
// limit) withdraws the testimonial; POST (after the write rate limit and the
// ban check) checks consent and the quote, then replaces the page's one or
// adds it at the end, waiting for review either way.
export default route('me/testimonial', async (request, response) => {
  if (guard(request, response, ['GET', 'POST', 'DELETE'])) {
    return;
  }
  const owner = await requireOwner(request, response);
  if (!owner) {
    return;
  }
  const page = owner.page;
  const answer = async () => ok(response, { testimonial: ownerTestimonial(await mine(page.id)) });
  if (request.method === 'GET') {
    return answer();
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'ownerWrite', [`page:${page.id}`])) {
    return;
  }

  if (request.method === 'DELETE') {
    const { error } = await database().from(TABLES.testimonials).delete().eq('page_id', page.id);
    if (error) {
      throw error;
    }
    return answer();
  }

  if (await refusedForBan(request, response, { pageId: owner.page.id })) {
    return;
  }
  if (body.consent !== true) {
    return fail(response, 400, 'testimonial_consent');
  }
  const quote = cleanText(body.quote, LIMITS.quote, { multiline: true });
  if (!quote) {
    return fail(response, 400, 'own_testimonial_required');
  }
  const refused = await addressRefusedInText(quote);
  if (refused) {
    return fail(response, 400, 'text_address', { host: refused.host });
  }

  // Credited to the display name, or the page name when there is none.
  let authorName = page.slug;
  if (page.display_name) {
    authorName = page.display_name;
  }
  const fields = {
    quote,
    author: cleanText(authorName, LIMITS.author),
    page_slug: page.slug,
    status: 'pending',
    is_visible: true,
    consented_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null,
  };
  const existing = await mine(page.id);
  if (existing) {
    const { error } = await database().from(TABLES.testimonials).update(fields).eq('id', existing.id);
    if (error) {
      throw error;
    }
  } else {
    const { data: last, error: lastError } = await database().from(TABLES.testimonials).select('order_index').order('order_index', { ascending: false }).limit(1);
    if (lastError) {
      throw lastError;
    }
    // A new one goes after every other testimonial, or first when there are
    // none.
    let highest;
    if (last) {
      highest = last[0];
    }
    let lastIndex = -1;
    if (highest && highest.order_index !== null && highest.order_index !== undefined) {
      lastIndex = highest.order_index;
    }
    const { error } = await database().from(TABLES.testimonials).insert({ ...fields, page_id: page.id, order_index: lastIndex + 1 });
    if (error) {
      throw error;
    }
  }
  await audit(request, { action: 'page.testimonial_sent', actorType: 'owner', actorId: page.id, pageId: page.id });
  return answer();
});
