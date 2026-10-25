// GET /api/public/testimonials
// The visible testimonials, in order, for the home page. Cached at the edge
// for a minute: they change rarely and every home page visit asks.

import { route, guard, ok } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { publicTestimonial } from '../_lib/serialize.js';

export default route('public/testimonials', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  const { data, error } = await db()
    .from(T.testimonials)
    .select('id, quote, author, page_slug, order_index')
    .eq('is_visible', true)
    .order('order_index');
  if (error) throw error;
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  ok(res, { testimonials: (data ?? []).map(publicTestimonial) });
});
