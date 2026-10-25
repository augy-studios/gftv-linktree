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
import { db } from '../_lib/supabase.js';

const count = (value) => Math.max(0, Number(value) || 0);

export default route('public/insights', async (req, res) => {
  if (guard(req, res, ['GET'])) return;
  const { data, error } = await db().rpc('gftvonelink_site_insights');
  if (error) throw error;
  const raw = data ?? {};
  const visits = count(raw.visits);
  const devices = {};
  for (const key of ['mobile', 'tablet', 'desktop', 'others']) devices[key] = count(raw.devices?.[key]);
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600');
  ok(res, {
    visits,
    clicks: count(raw.clicks),
    pages: count(raw.pages),
    daily: (raw.daily ?? []).map((d) => ({ day: String(d.day).slice(0, 10), clicks: count(d.clicks) })),
    devices,
    country: raw.country?.key ? { key: String(raw.country.key), hits: count(raw.country.hits) } : null,
    referrer: raw.referrer?.key
      ? { key: String(raw.referrer.key), hits: count(raw.referrer.hits), share: visits > 0 ? Math.round((count(raw.referrer.hits) / visits) * 100) : 0 }
      : null,
  });
});
