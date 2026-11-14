// GET /api/public/insights
// The site-wide numbers on the home page's insight tiles, from the
// gftvonelink_site_insights() database function (migration 008), which also
// counts the GFTV short links' visit log while OneLink is new. Totals only.
// Cached at the edge for ten minutes.
//
//   visits    OneLink page visits, all time
//   clicks    link clicks, all time, OneLink and GFTV short links together
//   pages     live pages
//   daily     [{ day, clicks }], the last 30 Singapore days, oldest first
//   devices   { mobile, tablet, desktop, others } visits and clicks
//   country   { key, hits } the country most OneLink visits come from, or null
//   referrer  { key, hits, share } the site that sends most OneLink visits,
//             with its share of all visits, or null

import { route, guard, ok } from '../_lib/http.js';
import { database } from '../_lib/supabase.js';

// A number from the database, never below 0, and 0 when it is missing or not
// a number.
const count = (value) => {
  let number = Number(value);
  if (!number) {
    number = 0;
  }
  return Math.max(0, number);
};

// Reads the site totals from the database function, then answers each number
// cleaned up, with edge caching. The top country and referrer are null when
// there are none.
export default route('public/insights', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const { data, error } = await database().rpc('gftvonelink_site_insights');
  if (error) {
    throw error;
  }
  let raw = {};
  if (data !== null && data !== undefined) {
    raw = data;
  }
  const visits = count(raw.visits);
  const devices = {};
  for (const key of ['mobile', 'tablet', 'desktop', 'others']) {
    let deviceHits;
    if (raw.devices !== null && raw.devices !== undefined) {
      deviceHits = raw.devices[key];
    }
    devices[key] = count(deviceHits);
  }
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600');

  let dailyRows = [];
  if (raw.daily !== null && raw.daily !== undefined) {
    dailyRows = raw.daily;
  }
  const daily = dailyRows.map((entry) => ({ day: String(entry.day).slice(0, 10), clicks: count(entry.clicks) }));

  let country = null;
  if (raw.country !== null && raw.country !== undefined && raw.country.key) {
    country = { key: String(raw.country.key), hits: count(raw.country.hits) };
  }

  let referrer = null;
  if (raw.referrer !== null && raw.referrer !== undefined && raw.referrer.key) {
    // The referrer's share of all visits, as a whole percentage.
    let share = 0;
    if (visits > 0) {
      share = Math.round((count(raw.referrer.hits) / visits) * 100);
    }
    referrer = { key: String(raw.referrer.key), hits: count(raw.referrer.hits), share };
  }

  ok(response, {
    visits,
    clicks: count(raw.clicks),
    pages: count(raw.pages),
    daily,
    devices,
    country,
    referrer,
  });
});
