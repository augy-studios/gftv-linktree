// GET /api/cron/cleanup, run daily by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sweeps what expiry-on-read misses: sessions, challenges, Telegram link
// tokens, rate limit buckets, and pages abandoned before setup finished.

import { route, send } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';

export default route('cron/cleanup', async (req, res) => {
  const secret = optionalEnv('CRON_SECRET');
  const given = String(req.headers.authorization || '');
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) return send(res, 401, { ok: false });

  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();

  const jobs = {
    sessions: db().from(T.sessions).delete().lt('expires_at', now).select('id'),
    staffSessions: db().from(T.staffSessions).delete().lt('expires_at', now).select('id'),
    challenges: db().from(T.challenges).delete().lt('expires_at', now).select('id'),
    webauthn: db().from(T.webauthn).delete().lt('expires_at', now).select('id'),
    telegramLinks: db().from(T.telegramLinks).delete().lt('expires_at', dayAgo).select('id'),
    rateLimits: db().from('gftvonelink_rate_limits').delete().lt('window_start', dayAgo).select('bucket'),
    abandonedPages: db().from(T.pages).delete().eq('status', 'pending').lt('created_at', dayAgo).select('id'),
  };

  const removed = {};
  for (const [name, job] of Object.entries(jobs)) {
    const { data, error } = await job;
    if (error) console.error(`[onelink] cleanup ${name}:`, error.message);
    removed[name] = error ? null : (data ?? []).length;
  }
  send(res, 200, { ok: true, removed });
});
