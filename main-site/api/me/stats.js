// GET /api/me/stats?days=7|30|90
//
// The signed-in owner's insights over the last 7, 30 or 90 Singapore days:
//
//   totals     { visits, clicks }
//   daily      [{ day, visits, clicks }], one entry per day, oldest first,
//              zeros included so a chart has no gaps
//   countries  [{ key, hits }]  top ten, XX for unknown
//   devices    [{ key, hits }]  mobile, tablet, desktop
//   referrers  [{ key, hits }]  top ten sites, '' for direct
//
// Clicks per link, all time, are on the links themselves (/api/me/page).

import { route, guard, ok, query } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { limited } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';

const PERIODS = new Set([7, 30, 90]);

// YYYY-MM-DD in Singapore, the zone the database counts days in.
export function singaporeDay(date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function top(map, n) {
  return [...map].map(([key, hits]) => ({ key, hits })).sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key)).slice(0, n);
}

export default route('me/stats', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  const owner = await requireOwner(req, res);
  if (!owner) return;
  if (await limited(req, res, 'ownerRead', [`page:${owner.page.id}`])) return;

  const asked = Number(query(req, 'days'));
  const days = PERIODS.has(asked) ? asked : 30;
  const today = new Date();
  const dayList = Array.from({ length: days }, (_, i) => singaporeDay(new Date(today.getTime() - (days - 1 - i) * 86400_000)));

  const { data, error } = await db()
    .from(T.pageStats)
    .select('day, kind, key, hits')
    .eq('page_id', owner.page.id)
    .gte('day', dayList[0]);
  if (error) throw error;

  const daily = new Map(dayList.map((day) => [day, { day, visits: 0, clicks: 0 }]));
  const breakdown = { country: new Map(), device: new Map(), referrer: new Map() };
  const totals = { visits: 0, clicks: 0 };
  for (const row of data ?? []) {
    const hits = Number(row.hits) || 0;
    const day = String(row.day).slice(0, 10);
    if (row.kind === 'visits' || row.kind === 'clicks') {
      totals[row.kind] += hits;
      const entry = daily.get(day);
      if (entry) entry[row.kind] += hits;
    } else if (breakdown[row.kind]) {
      const map = breakdown[row.kind];
      map.set(row.key, (map.get(row.key) || 0) + hits);
    }
  }

  ok(res, {
    days,
    totals,
    daily: [...daily.values()],
    countries: top(breakdown.country, 10),
    devices: top(breakdown.device, 3),
    referrers: top(breakdown.referrer, 10),
  });
});
