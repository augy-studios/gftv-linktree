// GET /api/cron/cleanup, run daily by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sweeps what expiry-on-read misses: sessions, challenges, Telegram link
// tokens, rate limit buckets, and pages abandoned before setup finished.
// Rebuilds the domain blocklist index when it is older than
// DOMAIN_BLOCKLIST_REFRESH_DAYS (14 by default; domain-blocklist.js).
// Then sends the one Telegram reminder a page gets a month before it goes
// dormant (a year without a sign-in), when its owner linked Telegram, and
// checks every live link and redirect against the HaGeZi domain blocklist
// and Google Safe Browsing again, since an address that was fine when it
// was added can turn bad later.

import { route, send } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { DORMANT_AFTER_DAYS, DORMANCY_WARNING_DAYS, dormantFrom } from '../_lib/validate.js';
import { sendRichTelegram, telegramConfigured } from '../_lib/telegram.js';
import { dormancyMessage } from '../_lib/telegram-messages.js';
import { unsafeUrls, safeBrowsingConfigured } from '../_lib/safe-browsing.js';
import { blocklistCategory, domainBlocklists, rebuildDomainBlocklist } from '../_lib/domain-blocklist.js';
import { audit, addressRefusedInText } from '../_lib/guards.js';

const UNSAFE_REASON = 'Flagged as unsafe by Google Safe Browsing';
// Shown to the owner, by blocklist category (domain-blocklist.js).
const LISTED_REASONS = {
  unsafe: 'On the HaGeZi blocklist of harmful sites',
  gambling: 'A gambling site (HaGeZi gambling list)',
  adult: 'Adult content (HaGeZi NSFW list); OneLink is for all ages',
  piracy: 'A piracy site (HaGeZi anti-piracy list)',
  shortener: 'A shortened link (HaGeZi shortener list); use the full address',
};

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Live links either list now catches are removed the way staff remove one
// (the owner sees why and cannot edit it back), and a flagged redirect is
// switched off so the page shows its links instead. Recorded as the system.
async function recheckAddresses() {
  if (!safeBrowsingConfigured() && domainBlocklists().length === 0) return null;
  const [{ data: links, error }, { data: pages, error: pageError }] = await Promise.all([
    db().from(T.links).select('id, page_id, url').is('removed_at', null).limit(5000),
    db().from(T.pages).select('id, slug, redirect_url').not('redirect_url', 'is', null).limit(5000),
  ]);
  if (error || pageError) throw error || pageError;
  const flagged = await unsafeUrls([...(links ?? []).map((l) => l.url), ...(pages ?? []).map((p) => p.redirect_url)]);
  // Why a url should go, or null to keep it.
  const verdict = async (url) => {
    if (flagged.has(url)) return UNSAFE_REASON;
    const listed = await blocklistCategory(hostOf(url));
    return listed ? LISTED_REASONS[listed] : null;
  };
  let removed = 0;
  for (const link of links ?? []) {
    const reason = await verdict(link.url);
    if (!reason) continue;
    const { error: removeError } = await db()
      .from(T.links)
      .update({ removed_at: new Date().toISOString(), removed_reason: reason, removed_by: null })
      .eq('id', link.id);
    if (removeError) throw removeError;
    await audit(null, { action: 'mod.link_removed', actorType: 'system', pageId: link.page_id, details: { linkId: link.id, url: link.url, reason } });
    removed += 1;
  }
  for (const page of pages ?? []) {
    const reason = await verdict(page.redirect_url);
    if (!reason) continue;
    const { error: clearError } = await db().from(T.pages).update({ redirect_url: null }).eq('id', page.id);
    if (clearError) throw clearError;
    await audit(null, { action: 'mod.redirect_removed', actorType: 'system', pageId: page.id, details: { slug: page.slug, url: page.redirect_url, reason } });
    removed += 1;
  }
  return removed;
}

// Text cannot be taken down the way a link can, so an address in a name, bio
// or link title that the lists now catch is reported to staff instead, once
// while that report is open.
async function reportAddressesInText() {
  const [{ data: pages, error }, { data: titles, error: titleError }] = await Promise.all([
    db().from(T.pages).select('id, display_name, bio').eq('status', 'active').limit(5000),
    db().from(T.links).select('page_id, title').is('removed_at', null).limit(5000),
  ]);
  if (error || titleError) throw error || titleError;
  const titlesByPage = new Map();
  for (const link of titles ?? []) titlesByPage.set(link.page_id, [...(titlesByPage.get(link.page_id) ?? []), link.title]);
  let reported = 0;
  for (const page of pages ?? []) {
    const refused = await addressRefusedInText(page.display_name, page.bio, ...(titlesByPage.get(page.id) ?? []));
    if (!refused) continue;
    const details = `Automatic: the page's text mentions ${refused.host} (${refused.error}).`;
    const { data: open, error: openError } = await db().from(T.reports).select('id').eq('page_id', page.id).eq('status', 'open').eq('details', details).limit(1);
    if (openError) throw openError;
    if ((open ?? []).length > 0) continue;
    const { error: insertError } = await db().from(T.reports).insert({ page_id: page.id, reason: 'scam', details });
    if (insertError) throw insertError;
    reported += 1;
  }
  return reported;
}

// Pages inside the last month before going dormant that have not been told.
// Marked before sending, so a failed send is not retried every day.
async function remindDormant() {
  if (!telegramConfigured()) return 0;
  const cutoff = new Date(Date.now() - (DORMANT_AFTER_DAYS - DORMANCY_WARNING_DAYS) * 86400_000).toISOString();
  const alreadyDormant = new Date(Date.now() - DORMANT_AFTER_DAYS * 86400_000).toISOString();
  const { data, error } = await db()
    .from(T.pages)
    .select('id, slug, telegram_chat_id, last_sign_in_at')
    .eq('status', 'active')
    .is('dormancy_warned_at', null)
    .not('telegram_chat_id', 'is', null)
    .lt('last_sign_in_at', cutoff)
    .gt('last_sign_in_at', alreadyDormant)
    .limit(200);
  if (error) throw error;
  let sent = 0;
  for (const page of data ?? []) {
    const { error: markError } = await db().from(T.pages).update({ dormancy_warned_at: new Date().toISOString() }).eq('id', page.id);
    if (markError) throw markError;
    const date = dormantFrom(page.last_sign_in_at).slice(0, 10);
    try {
      await sendRichTelegram(page.telegram_chat_id, dormancyMessage({ slug: page.slug, date }));
      sent += 1;
    } catch (cause) {
      console.warn('[onelink] dormancy reminder:', page.slug, cause?.message ?? cause);
    }
  }
  return sent;
}

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
  let reminded = null;
  try {
    reminded = await remindDormant();
  } catch (cause) {
    console.error('[onelink] cleanup dormancy reminders:', cause?.message ?? cause);
  }
  let blocklist = null;
  try {
    const result = await rebuildDomainBlocklist();
    blocklist = result.off ? 'off' : result.built ? { rebuilt: result.categories } : { current: result.meta.builtAt };
  } catch (cause) {
    console.error('[onelink] cleanup domain blocklist:', cause?.message ?? cause);
  }
  let unsafe = null;
  try {
    unsafe = await recheckAddresses();
  } catch (cause) {
    console.error('[onelink] cleanup safe browsing:', cause?.message ?? cause);
  }
  // The staff lists apply to text even with the outside lists switched off.
  let textReports = null;
  try {
    textReports = await reportAddressesInText();
  } catch (cause) {
    console.error('[onelink] cleanup text addresses:', cause?.message ?? cause);
  }
  send(res, 200, { ok: true, removed, reminded, blocklist, unsafe, textReports });
});
