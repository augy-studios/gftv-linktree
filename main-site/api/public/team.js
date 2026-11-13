// GET /api/public/team
// Every page an admin has marked as someone on the GFTV team (migration 015),
// for the /team list people use to check that someone is on the team. Only
// pages a visitor could open are listed: live, approved, not quarantined and
// not dormant.

import { route, guard, ok } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { isDormant } from '../_lib/validate.js';
import { publicTeamMember } from '../_lib/serialize.js';

export default route('public/team', async (request, response) => {
  if (guard(request, response, ['GET'])) return;
  const { data, error } = await database()
    .from(TABLES.pages)
    .select('slug, display_name, avatar_path, status, last_sign_in_at, needs_review, reviewed_at, quarantined_at, team_verified_at, team_role')
    .eq('status', 'active')
    .not('team_verified_at', 'is', null)
    .is('quarantined_at', null)
    .order('slug');
  if (error) throw error;
  const members = (data ?? [])
    .filter((p) => !(p.needs_review && !p.reviewed_at) && !isDormant(p.last_sign_in_at))
    .map(publicTeamMember);
  // A few seconds at the edge, like a page: removing someone shows quickly.
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30');
  ok(response, { members });
});
