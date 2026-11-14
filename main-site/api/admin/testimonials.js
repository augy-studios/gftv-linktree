// Testimonials for the home page's community section.
//
// GET                                                  -> { testimonials }
// POST { action: "approve" | "decline", id }           any staff
// POST { action: "add", quote, author, pageSlug? }     admins from here on
// POST { action: "update", id, quote?, author?, pageSlug?, isVisible? }
// POST { action: "move", id, delta: -1 | 1 }
// POST { action: "remove", id }
//
// Every answer is the full list in display order, sent in by owners
// (me/testimonial.js, waiting until approved) and entered by staff from what
// people actually said. The home page shows the approved, visible ones.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { cleanText, normaliseSlug, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminTestimonialRow } from '../_lib/serialize.js';

// Every testimonial, in display order.
async function allTestimonials() {
  const { data, error } = await database()
    .from(TABLES.testimonials)
    .select('id, quote, author, page_slug, page_id, status, is_visible, order_index, created_at, reviewed_at')
    .order('order_index');
  if (error) {
    throw error;
  }
  if (data) {
    return data;
  }
  return [];
}

// '' clears it; anything else must look like a page name.
function slugField(input) {
  const slug = normaliseSlug(input);
  if (!slug) {
    return { ok: true, value: null };
  }
  if (/^[a-z0-9-]{2,32}$/.test(slug)) {
    return { ok: true, value: slug };
  }
  return { ok: false };
}

// Checks the caller is staff. GET answers the list. POST counts against the
// staff write limit, keeps everything but approve and decline for admins,
// runs the action, and answers the list again.
export default route('admin/testimonials', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  // Editors approve and decline what owners send; the rest is for admins.
  const staff = await requireStaff(request, response);
  if (!staff) {
    return;
  }
  const answer = async () => ok(response, { testimonials: (await allTestimonials()).map(adminTestimonialRow) });
  if (request.method === 'GET') {
    return answer();
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'staffWrite', [`staff:${staff.user.id}`])) {
    return;
  }
  const actor = { actorType: 'staff', actorId: staff.user.id };
  let reviewing = false;
  if (body.action === 'approve' || body.action === 'decline') {
    reviewing = true;
  }
  if (!reviewing && staff.user.is_admin !== true) {
    return fail(response, 403, 'admin_only');
  }

  if (body.action === 'add') {
    const quote = cleanText(body.quote, LIMITS.quote, { multiline: true });
    const author = cleanText(body.author, LIMITS.author);
    if (!quote || !author) {
      return fail(response, 400, 'testimonial_required');
    }
    const slug = slugField(body.pageSlug);
    if (!slug.ok) {
      return fail(response, 400, 'slug_invalid');
    }
    // A new one goes at the end of the list.
    const rows = await allTestimonials();
    const nextIndex = rows.reduce((highest, testimonial) => Math.max(highest, testimonial.order_index), -1) + 1;
    const { data, error } = await database()
      .from(TABLES.testimonials)
      .insert({ quote, author, page_slug: slug.value, order_index: nextIndex, created_by: staff.user.id })
      .select('id')
      .single();
    if (error) {
      throw error;
    }
    await audit(request, { action: 'mod.testimonial_added', ...actor, details: { id: data.id, author } });
    return answer();
  }

  if (!isUuid(body.id)) {
    return fail(response, 400, 'bad_request');
  }
  const rows = await allTestimonials();
  const row = rows.find((testimonial) => testimonial.id === body.id);
  if (!row) {
    return fail(response, 404, 'testimonial_not_found');
  }

  if (reviewing) {
    let status;
    if (body.action === 'approve') {
      status = 'approved';
    } else {
      status = 'declined';
    }
    const { error } = await database()
      .from(TABLES.testimonials)
      .update({ status, reviewed_by: staff.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) {
      throw error;
    }
    let testimonialPageId = null;
    if (row.page_id !== null && row.page_id !== undefined) {
      testimonialPageId = row.page_id;
    }
    await audit(request, { action: `mod.testimonial_${status}`, ...actor, pageId: testimonialPageId, details: { id: row.id, author: row.author } });
    return answer();
  }

  if (body.action === 'update') {
    // Only the fields sent change; each is checked as it is read.
    const fields = {};
    if (body.quote !== undefined) {
      fields.quote = cleanText(body.quote, LIMITS.quote, { multiline: true });
      if (!fields.quote) {
        return fail(response, 400, 'testimonial_required');
      }
    }
    if (body.author !== undefined) {
      fields.author = cleanText(body.author, LIMITS.author);
      if (!fields.author) {
        return fail(response, 400, 'testimonial_required');
      }
    }
    if (body.pageSlug !== undefined) {
      const slug = slugField(body.pageSlug);
      if (!slug.ok) {
        return fail(response, 400, 'slug_invalid');
      }
      fields.page_slug = slug.value;
    }
    if (body.isVisible !== undefined) {
      fields.is_visible = body.isVisible === true;
    }
    if (Object.keys(fields).length > 0) {
      const { error } = await database().from(TABLES.testimonials).update(fields).eq('id', row.id);
      if (error) {
        throw error;
      }
      await audit(request, { action: 'mod.testimonial_updated', ...actor, details: { id: row.id, fields: Object.keys(fields) } });
    }
    return answer();
  }

  if (body.action === 'move') {
    // One place up (delta -1) or down; past either end changes nothing.
    const fromIndex = rows.indexOf(row);
    let step = 1;
    if (body.delta === -1) {
      step = -1;
    }
    const toIndex = fromIndex + step;
    if (toIndex < 0 || toIndex >= rows.length) {
      return answer();
    }
    const moved = rows.splice(fromIndex, 1)[0];
    rows.splice(toIndex, 0, moved);
    // Then write the new position of every row that moved.
    for (const [orderIndex, testimonial] of rows.entries()) {
      if (testimonial.order_index === orderIndex) {
        continue;
      }
      const { error } = await database().from(TABLES.testimonials).update({ order_index: orderIndex }).eq('id', testimonial.id);
      if (error) {
        throw error;
      }
    }
    return answer();
  }

  if (body.action === 'remove') {
    const { error } = await database().from(TABLES.testimonials).delete().eq('id', row.id);
    if (error) {
      throw error;
    }
    await audit(request, { action: 'mod.testimonial_removed', ...actor, details: { id: row.id, author: row.author } });
    return answer();
  }

  fail(response, 400, 'bad_request');
});
