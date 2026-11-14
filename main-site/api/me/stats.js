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
import { database, TABLES } from '../_lib/supabase.js';
import { limited } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';

const PERIODS = new Set([7, 30, 90]);

// YYYY-MM-DD in Singapore, the zone the database counts days in.
export function singaporeDay(date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

// The `limit` biggest entries of a key -> hits map, as [{ key, hits }]: most
// hits first, ties in key order.
function top(map, limit) {
  return [...map]
    .map(([key, hits]) => ({ key, hits }))
    .sort((first, second) => {
      const byHits = second.hits - first.hits;
      if (byHits) {
        return byHits;
      }
      return first.key.localeCompare(second.key);
    })
    .slice(0, limit);
}

// Signs the owner in and applies the read rate limit, reads the page's daily
// rows for the period (30 days unless 7 or 90 is asked for), and adds them up
// into totals, one entry per day and the top countries, devices and sites.
export default route('me/stats', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const owner = await requireOwner(request, response);
  if (!owner) {
    return;
  }
  if (await limited(request, response, 'ownerRead', [`page:${owner.page.id}`])) {
    return;
  }

  const asked = Number(query(request, 'days'));
  let days = 30;
  if (PERIODS.has(asked)) {
    days = asked;
  }
  const today = new Date();
  // Every day of the period, oldest first, ending today.
  const dayList = Array.from({ length: days }, (unused, dayIndex) => singaporeDay(new Date(today.getTime() - (days - 1 - dayIndex) * 86400_000)));

  const { data, error } = await database()
    .from(TABLES.pageStats)
    .select('day, kind, key, hits')
    .eq('page_id', owner.page.id)
    .gte('day', dayList[0]);
  if (error) {
    throw error;
  }

  const daily = new Map(dayList.map((day) => [day, { day, visits: 0, clicks: 0 }]));
  const breakdown = { country: new Map(), device: new Map(), referrer: new Map() };
  const totals = { visits: 0, clicks: 0 };
  let rows = [];
  if (data) {
    rows = data;
  }
  for (const row of rows) {
    let hits = Number(row.hits);
    if (!hits) {
      hits = 0;
    }
    const day = String(row.day).slice(0, 10);
    if (row.kind === 'visits' || row.kind === 'clicks') {
      totals[row.kind] += hits;
      const entry = daily.get(day);
      if (entry) {
        entry[row.kind] += hits;
      }
    } else if (breakdown[row.kind]) {
      const map = breakdown[row.kind];
      let previousHits = map.get(row.key);
      if (!previousHits) {
        previousHits = 0;
      }
      map.set(row.key, previousHits + hits);
    }
  }

  ok(response, {
    days,
    totals,
    daily: [...daily.values()],
    countries: top(breakdown.country, 10),
    devices: top(breakdown.device, 3),
    referrers: top(breakdown.referrer, 10),
  });
});
