// POST /api/public/visit { slug, referrer? }
//
// Counts a visit to a public page for its owner's insights. Sent by the page
// itself with keepalive once it has drawn, because the server-rendered
// /<slug> is cached at the edge for a few seconds and would miss visits.
//
// Only daily totals are kept (gftvonelink_page_stats): the country from
// Vercel's geo header, the kind of device from the user agent, and the host
// of the referring site the browser reports. Nothing that identifies the
// visitor is stored. One visitor counts once per page per half hour, and
// crawlers and link previews are not counted at all.

import { route, guard, readJson, ok, clientIp } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { normaliseSlug, isDormant } from '../_lib/validate.js';
import { hashIp } from '../_lib/crypto.js';
import { limited, firstHit } from '../_lib/guards.js';
import { siteUrl } from '../_lib/env.js';

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|headless|lighthouse/i;

export function deviceOf(userAgent) {
  const ua = String(userAgent || '');
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Two capital letters, or XX when Vercel did not say (local runs, tests).
export function countryOf(header) {
  const value = String(header || '').toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : 'XX';
}

// The referring site's host without www., or '' for a direct visit, a
// referrer the browser withheld, or a visit from this site's own pages.
export function referrerOf(input) {
  let host;
  try {
    host = new URL(String(input || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '').replace(/^(m|l|lm|out)\./, '');
  const own = new URL(siteUrl()).hostname.replace(/^www\./, '');
  if (host === own || !/^[a-z0-9.-]{3,64}$/.test(host) || !host.includes('.')) return '';
  return host;
}

export default route('public/visit', async (req, res) => {
  if (guard(req, res, ['POST'])) return;
  const body = await readJson(req, res);
  if (!body) return;
  if (BOT.test(String(req.headers['user-agent'] || ''))) return ok(res, { counted: false });
  if (await limited(req, res, 'visit')) return;

  const { data: page, error } = await db()
    .from(T.pages)
    .select('id, status, last_sign_in_at, needs_review, reviewed_at, quarantined_at')
    .eq('slug', normaliseSlug(body.slug))
    .maybeSingle();
  if (error) throw error;
  const shown = page && page.status === 'active' && !isDormant(page.last_sign_in_at) && !(page.needs_review && !page.reviewed_at) && !page.quarantined_at;
  if (!shown) return ok(res, { counted: false });

  if (!(await firstHit(`visit:${hashIp(clientIp(req))}:${page.id}`, 1800))) return ok(res, { counted: false });

  const { data: counted, error: rpcError } = await db().rpc('gftvonelink_page_visit', {
    p_page_id: page.id,
    p_country: countryOf(req.headers['x-vercel-ip-country']),
    p_device: deviceOf(req.headers['user-agent']),
    p_referrer: referrerOf(body.referrer),
  });
  if (rpcError) throw rpcError;
  ok(res, { counted: Boolean(counted) });
});
