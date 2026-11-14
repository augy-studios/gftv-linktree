// GET /api/cron/cleanup, run daily by Vercel Cron (vercel.json).
// Vercel sends Authorization: Bearer $CRON_SECRET; anything else is refused.
//
// Sweeps what expiry-on-read misses: sessions, challenges, Telegram link
// tokens, rate limit buckets (which include the day's flags on connections
// and devices), and pages abandoned before setup finished. Clears device
// hashes from audit entries older than VISITOR_HASH_DAYS; bans keep theirs
// until staff lift them.
// Rebuilds the domain blocklist index when it is older than
// DOMAIN_BLOCKLIST_REFRESH_DAYS (14 by default; domain-blocklist.js).
// Then sends the one Telegram reminder a page gets a month before it goes
// dormant (a year without a sign-in), when its owner linked Telegram, and
// checks every live link and redirect against the HaGeZi domain blocklist
// and Google Safe Browsing again, since an address that was fine when it
// was added can turn bad later. Domains staff have allowed are left alone.

import { route, send } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { DORMANT_AFTER_DAYS, DORMANCY_WARNING_DAYS, dormantFrom, linkHost, lookupUrl } from '../_lib/validate.js';
import { sendRichTelegram, telegramConfigured } from '../_lib/telegram.js';
import { dormancyMessage } from '../_lib/telegram-messages.js';
import { unsafeUrls, safeBrowsingConfigured } from '../_lib/safe-browsing.js';
import { blocklistCategory, domainBlocklists, rebuildDomainBlocklist } from '../_lib/domain-blocklist.js';
import { audit, addressRefusedInText, domainAllowed } from '../_lib/guards.js';

// How long the audit log keeps the device hash next to the address hash, for
// banning the devices used on a connection along with it (guards.js).
export const VISITOR_HASH_DAYS = 30;

const UNSAFE_REASON = 'Flagged as unsafe by Google Safe Browsing';
// Shown to the owner, by blocklist category (domain-blocklist.js).
const LISTED_REASONS = {
  unsafe: 'On the HaGeZi blocklist of harmful sites',
  gambling: 'A gambling site (HaGeZi gambling list)',
  adult: 'Adult content (HaGeZi NSFW list); OneLink is for all ages',
  piracy: 'A piracy site (HaGeZi anti-piracy list)',
  shortener: 'A shortened link (HaGeZi shortener list); use the full address',
};

// What to log for a thrown value: its message, or the value itself when it
// has none.
function causeDetail(cause) {
  if (cause !== null && cause !== undefined && cause.message !== null && cause.message !== undefined) {
    return cause.message;
  }
  return cause;
}

// Live links either list now catches are removed the way staff remove one
// (the owner sees why and cannot edit it back), and a flagged redirect is
// switched off so the page shows its links instead. Recorded as the system.
// Returns how many were removed, or null when no list is set up.
async function recheckAddresses() {
  if (!safeBrowsingConfigured() && domainBlocklists().length === 0) {
    return null;
  }
  const [{ data: links, error }, { data: pages, error: pageError }] = await Promise.all([
    database().from(TABLES.links).select('id, page_id, url').is('removed_at', null).limit(5000),
    database().from(TABLES.pages).select('id, slug, redirect_url').not('redirect_url', 'is', null).limit(5000),
  ]);
  if (error) {
    throw error;
  }
  if (pageError) {
    throw pageError;
  }
  let linkRows = [];
  if (links) {
    linkRows = links;
  }
  let pageRows = [];
  if (pages) {
    pageRows = pages;
  }
  // One Safe Browsing lookup for every address at once.
  const addresses = [...linkRows.map((link) => link.url), ...pageRows.map((page) => page.redirect_url)];
  const flagged = await unsafeUrls(addresses.map(lookupUrl));
  // Why a url should go, or null to keep it.
  const verdict = async (url) => {
    if (await domainAllowed(linkHost(url))) {
      return null;
    }
    if (flagged.has(lookupUrl(url))) {
      return UNSAFE_REASON;
    }
    const listed = await blocklistCategory(linkHost(url));
    if (listed) {
      return LISTED_REASONS[listed];
    }
    return null;
  };
  let removed = 0;
  for (const link of linkRows) {
    const reason = await verdict(link.url);
    if (!reason) {
      continue;
    }
    const { error: removeError } = await database()
      .from(TABLES.links)
      .update({ removed_at: new Date().toISOString(), removed_reason: reason, removed_by: null })
      .eq('id', link.id);
    if (removeError) {
      throw removeError;
    }
    await audit(null, { action: 'mod.link_removed', actorType: 'system', pageId: link.page_id, details: { linkId: link.id, url: link.url, reason } });
    removed += 1;
  }
  for (const page of pageRows) {
    const reason = await verdict(page.redirect_url);
    if (!reason) {
      continue;
    }
    const { error: clearError } = await database().from(TABLES.pages).update({ redirect_url: null }).eq('id', page.id);
    if (clearError) {
      throw clearError;
    }
    await audit(null, { action: 'mod.redirect_removed', actorType: 'system', pageId: page.id, details: { slug: page.slug, url: page.redirect_url, reason } });
    removed += 1;
  }
  return removed;
}

// Text cannot be taken down the way a link can, so an address in a name, bio
// or link title that the lists now catch is reported to staff instead, once
// while that report is open. Returns how many reports were made.
async function reportAddressesInText() {
  const [{ data: pages, error }, { data: titles, error: titleError }] = await Promise.all([
    database().from(TABLES.pages).select('id, display_name, bio').eq('status', 'active').limit(5000),
    database().from(TABLES.links).select('page_id, title').is('removed_at', null).limit(5000),
  ]);
  if (error) {
    throw error;
  }
  if (titleError) {
    throw titleError;
  }
  let titleRows = [];
  if (titles) {
    titleRows = titles;
  }
  const titlesByPage = new Map();
  for (const link of titleRows) {
    let pageTitles = titlesByPage.get(link.page_id);
    if (!pageTitles) {
      pageTitles = [];
    }
    titlesByPage.set(link.page_id, [...pageTitles, link.title]);
  }
  let pageRows = [];
  if (pages) {
    pageRows = pages;
  }
  let reported = 0;
  for (const page of pageRows) {
    let pageTitles = titlesByPage.get(page.id);
    if (!pageTitles) {
      pageTitles = [];
    }
    const refused = await addressRefusedInText(page.display_name, page.bio, ...pageTitles);
    if (!refused) {
      continue;
    }
    // The same text already reported and still open is not reported again.
    const details = `Automatic: the page's text mentions ${refused.host} (${refused.error}).`;
    const { data: openReports, error: openError } = await database().from(TABLES.reports).select('id').eq('page_id', page.id).eq('status', 'open').eq('details', details).limit(1);
    if (openError) {
      throw openError;
    }
    let openRows = [];
    if (openReports) {
      openRows = openReports;
    }
    if (openRows.length > 0) {
      continue;
    }
    const { error: insertError } = await database().from(TABLES.reports).insert({ page_id: page.id, reason: 'scam', details });
    if (insertError) {
      throw insertError;
    }
    reported += 1;
  }
  return reported;
}

// Pages inside the last month before going dormant that have not been told.
// Marked before sending, so a failed send is not retried every day.
// Returns how many reminders were sent.
async function remindDormant() {
  if (!telegramConfigured()) {
    return 0;
  }
  const cutoff = new Date(Date.now() - (DORMANT_AFTER_DAYS - DORMANCY_WARNING_DAYS) * 86400_000).toISOString();
  const alreadyDormant = new Date(Date.now() - DORMANT_AFTER_DAYS * 86400_000).toISOString();
  const { data, error } = await database()
    .from(TABLES.pages)
    .select('id, slug, telegram_chat_id, last_sign_in_at')
    .eq('status', 'active')
    .is('dormancy_warned_at', null)
    .not('telegram_chat_id', 'is', null)
    .lt('last_sign_in_at', cutoff)
    .gt('last_sign_in_at', alreadyDormant)
    .limit(200);
  if (error) {
    throw error;
  }
  let pageRows = [];
  if (data) {
    pageRows = data;
  }
  let sent = 0;
  for (const page of pageRows) {
    const { error: markError } = await database().from(TABLES.pages).update({ dormancy_warned_at: new Date().toISOString() }).eq('id', page.id);
    if (markError) {
      throw markError;
    }
    const date = dormantFrom(page.last_sign_in_at).slice(0, 10);
    try {
      await sendRichTelegram(page.telegram_chat_id, dormancyMessage({ slug: page.slug, date }));
      sent += 1;
    } catch (cause) {
      console.warn('[onelink] dormancy reminder:', page.slug, causeDetail(cause));
    }
  }
  return sent;
}

// Refuses anything without the cron secret. Then runs the expiry sweeps in
// order, and after them the dormancy reminders, the blocklist rebuild, the
// address re-check and the text check, each on its own so one failing does
// not stop the rest. Answers what each step did (null for a step that failed).
export default route('cron/cleanup', async (request, response) => {
  const secret = optionalEnv('CRON_SECRET');
  let authorization = request.headers.authorization;
  if (!authorization) {
    authorization = '';
  }
  const given = String(authorization);
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) {
    return send(response, 401, { ok: false });
  }

  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const visitorCutoff = new Date(Date.now() - VISITOR_HASH_DAYS * 86400_000).toISOString();

  // Built here, run one at a time below (a query runs when it is awaited).
  const jobs = {
    sessions: database().from(TABLES.sessions).delete().lt('expires_at', now).select('id'),
    staffSessions: database().from(TABLES.staffSessions).delete().lt('expires_at', now).select('id'),
    challenges: database().from(TABLES.challenges).delete().lt('expires_at', now).select('id'),
    webauthn: database().from(TABLES.webauthn).delete().lt('expires_at', now).select('id'),
    telegramLinks: database().from(TABLES.telegramLinks).delete().lt('expires_at', dayAgo).select('id'),
    rateLimits: database().from('gftvonelink_rate_limits').delete().lt('window_start', dayAgo).select('bucket'),
    abandonedPages: database().from(TABLES.pages).delete().eq('status', 'pending').lt('created_at', dayAgo).select('id'),
    visitorHashes: database().from(TABLES.audit).update({ visitor_hash: null }).not('visitor_hash', 'is', null).lt('created_at', visitorCutoff).select('id'),
  };

  const removed = {};
  for (const [name, job] of Object.entries(jobs)) {
    const { data, error } = await job;
    if (error) {
      console.error(`[onelink] cleanup ${name}:`, error.message);
      removed[name] = null;
    } else {
      let rows = [];
      if (data) {
        rows = data;
      }
      removed[name] = rows.length;
    }
  }
  let reminded = null;
  try {
    reminded = await remindDormant();
  } catch (cause) {
    console.error('[onelink] cleanup dormancy reminders:', causeDetail(cause));
  }
  let blocklist = null;
  try {
    const result = await rebuildDomainBlocklist();
    if (result.off) {
      blocklist = 'off';
    } else if (result.built) {
      blocklist = { rebuilt: result.categories };
    } else {
      blocklist = { current: result.meta.builtAt };
    }
  } catch (cause) {
    console.error('[onelink] cleanup domain blocklist:', causeDetail(cause));
  }
  let unsafe = null;
  try {
    unsafe = await recheckAddresses();
  } catch (cause) {
    console.error('[onelink] cleanup safe browsing:', causeDetail(cause));
  }
  // The staff lists apply to text even with the outside lists switched off.
  let textReports = null;
  try {
    textReports = await reportAddressesInText();
  } catch (cause) {
    console.error('[onelink] cleanup text addresses:', causeDetail(cause));
  }
  send(response, 200, { ok: true, removed, reminded, blocklist, unsafe, textReports });
});
