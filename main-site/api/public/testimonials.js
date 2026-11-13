// GET /api/public/testimonials
// The approved, visible testimonials, in order, for the home page. Cached at
// the edge for a minute: they change rarely and every home page visit asks.

import { route, guard, ok } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { publicTestimonial } from '../_lib/serialize.js';

export default route('public/testimonials', async (request, response) => {
  if (guard(request, response, ['GET'])) return;
  const { data, error } = await database()
    .from(TABLES.testimonials)
    .select('id, quote, author, page_slug, order_index')
    .eq('is_visible', true)
    .eq('status', 'approved')
    .order('order_index');
  if (error) throw error;
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  ok(response, { testimonials: (data ?? []).map(publicTestimonial) });
});
