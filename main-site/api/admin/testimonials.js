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
import { db, T } from '../_lib/supabase.js';
import { cleanText, normaliseSlug, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { adminTestimonialRow } from '../_lib/serialize.js';

async function all() {
  const { data, error } = await db()
    .from(T.testimonials)
    .select('id, quote, author, page_slug, page_id, status, is_visible, order_index, created_at, reviewed_at')
    .order('order_index');
  if (error) throw error;
  return data ?? [];
}

// '' clears it; anything else must look like a page name.
function slugField(input) {
  const slug = normaliseSlug(input);
  if (!slug) return { ok: true, value: null };
  return /^[a-z0-9-]{2,32}$/.test(slug) ? { ok: true, value: slug } : { ok: false };
}

export default route('admin/testimonials', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  // Editors approve and decline what owners send; the rest is for admins.
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const answer = async () => ok(res, { testimonials: (await all()).map(adminTestimonialRow) });
  if (req.method === 'GET') return answer();

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'staffWrite', [`staff:${staff.user.id}`])) return;
  const actor = { actorType: 'staff', actorId: staff.user.id };
  const reviewing = body.action === 'approve' || body.action === 'decline';
  if (!reviewing && staff.user.is_admin !== true) return fail(res, 403, 'admin_only');

  if (body.action === 'add') {
    const quote = cleanText(body.quote, LIMITS.quote, { multiline: true });
    const author = cleanText(body.author, LIMITS.author);
    if (!quote || !author) return fail(res, 400, 'testimonial_required');
    const slug = slugField(body.pageSlug);
    if (!slug.ok) return fail(res, 400, 'slug_invalid');
    const rows = await all();
    const next = rows.reduce((max, r) => Math.max(max, r.order_index), -1) + 1;
    const { data, error } = await db()
      .from(T.testimonials)
      .insert({ quote, author, page_slug: slug.value, order_index: next, created_by: staff.user.id })
      .select('id')
      .single();
    if (error) throw error;
    await audit(req, { action: 'mod.testimonial_added', ...actor, details: { id: data.id, author } });
    return answer();
  }

  if (!isUuid(body.id)) return fail(res, 400, 'bad_request');
  const rows = await all();
  const row = rows.find((r) => r.id === body.id);
  if (!row) return fail(res, 404, 'testimonial_not_found');

  if (reviewing) {
    const status = body.action === 'approve' ? 'approved' : 'declined';
    const { error } = await db()
      .from(T.testimonials)
      .update({ status, reviewed_by: staff.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) throw error;
    await audit(req, { action: `mod.testimonial_${status}`, ...actor, pageId: row.page_id ?? null, details: { id: row.id, author: row.author } });
    return answer();
  }

  if (body.action === 'update') {
    const fields = {};
    if (body.quote !== undefined) {
      fields.quote = cleanText(body.quote, LIMITS.quote, { multiline: true });
      if (!fields.quote) return fail(res, 400, 'testimonial_required');
    }
    if (body.author !== undefined) {
      fields.author = cleanText(body.author, LIMITS.author);
      if (!fields.author) return fail(res, 400, 'testimonial_required');
    }
    if (body.pageSlug !== undefined) {
      const slug = slugField(body.pageSlug);
      if (!slug.ok) return fail(res, 400, 'slug_invalid');
      fields.page_slug = slug.value;
    }
    if (body.isVisible !== undefined) fields.is_visible = body.isVisible === true;
    if (Object.keys(fields).length > 0) {
      const { error } = await db().from(T.testimonials).update(fields).eq('id', row.id);
      if (error) throw error;
      await audit(req, { action: 'mod.testimonial_updated', ...actor, details: { id: row.id, fields: Object.keys(fields) } });
    }
    return answer();
  }

  if (body.action === 'move') {
    const from = rows.indexOf(row);
    const to = from + (body.delta === -1 ? -1 : 1);
    if (to < 0 || to >= rows.length) return answer();
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    for (const [i, r] of rows.entries()) {
      if (r.order_index === i) continue;
      const { error } = await db().from(T.testimonials).update({ order_index: i }).eq('id', r.id);
      if (error) throw error;
    }
    return answer();
  }

  if (body.action === 'remove') {
    const { error } = await db().from(T.testimonials).delete().eq('id', row.id);
    if (error) throw error;
    await audit(req, { action: 'mod.testimonial_removed', ...actor, details: { id: row.id, author: row.author } });
    return answer();
  }

  fail(res, 400, 'bad_request');
});
