// POST /api/public/click { id }
// Counts a click on a link. The link button itself goes straight to the
// destination; this is sent alongside it with keepalive, so counting never
// sits between a visitor and where they are going.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database } from '../_lib/supabase.js';
import { isUuid } from '../_lib/validate.js';
import { limited } from '../_lib/guards.js';

export default route('public/click', async (request, response) => {
  if (guard(request, response, ['POST'])) return;
  const body = await readJson(request, response);
  if (!body) return;
  if (!isUuid(body.id)) return fail(response, 400, 'bad_request');
  if (await limited(request, response, 'click', [`link:${body.id}`])) return;
  const { error } = await database().rpc('gftvonelink_link_click', { p_link_id: body.id });
  if (error) throw error;
  ok(response);
});
