// POST /api/public/click { id }
// Counts a click on a link. The link button itself goes straight to the
// destination; this is sent alongside it with keepalive, so counting never
// sits between a visitor and where they are going.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db } from '../_lib/supabase.js';
import { isUuid } from '../_lib/validate.js';
import { limited } from '../_lib/guards.js';

export default route('public/click', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (!isUuid(body.id)) return fail(res, 400, 'bad_request');
  if (await limited(req, res, 'click', [`link:${body.id}`])) return;
  const { error } = await db().rpc('gftvonelink_link_click', { p_link_id: body.id });
  if (error) throw error;
  ok(res);
});
