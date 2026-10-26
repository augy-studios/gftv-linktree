// The owner's editor view of their page, assembled from a handful of reads.

import { db, T } from './supabase.js';
import { listPasskeys } from './webauthn.js';
import { backupCodesLeft } from './factors.js';
import { telegramConfigured } from './telegram.js';
import { linkCapFor, latestCapRequest, linksUsed } from './link-cap.js';
import { ownerPage, ownerLinkCap, ownerCapRequest } from './serialize.js';

const LINK_COLUMNS = 'id, title, url, icon, order_index, is_active, click_count, removed_at, removed_reason';

export async function loadOwnerView(pageId) {
  const [{ data: page, error: pageError }, { data: links, error }, passkeys, left, cap, request] = await Promise.all([
    db()
      .from(T.pages)
      .select('id, slug, display_name, bio, avatar_path, totp_secret, telegram_chat_id, telegram_username, created_at, redirect_url, last_sign_in_at, needs_review, reviewed_at, quarantined_at')
      .eq('id', pageId)
      .single(),
    db().from(T.links).select(LINK_COLUMNS).eq('page_id', pageId),
    listPasskeys('owner', pageId),
    backupCodesLeft(pageId),
    linkCapFor(pageId),
    latestCapRequest(pageId),
  ]);
  if (pageError) throw pageError;
  if (error) throw error;
  return ownerPage(
    page,
    links,
    { passkeys, backupCodesLeft: left, telegramReady: telegramConfigured() },
    { linkCap: ownerLinkCap(cap, linksUsed(links)), capRequest: ownerCapRequest(request) },
  );
}
