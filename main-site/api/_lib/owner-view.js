// The owner's editor view of their page, assembled from four reads.

import { db, T } from './supabase.js';
import { ownerPage } from './serialize.js';
import { listPasskeys } from './webauthn.js';
import { backupCodesLeft } from './factors.js';
import { telegramConfigured } from './telegram.js';

const LINK_COLUMNS = 'id, title, url, icon, order_index, is_active, click_count, removed_at, removed_reason';

export async function loadOwnerView(pageId) {
  const [{ data: page, error: pageError }, { data: links, error }, passkeys, left] = await Promise.all([
    db()
      .from(T.pages)
      .select('id, slug, display_name, bio, avatar_path, totp_secret, telegram_chat_id, telegram_username, created_at')
      .eq('id', pageId)
      .single(),
    db().from(T.links).select(LINK_COLUMNS).eq('page_id', pageId),
    listPasskeys('owner', pageId),
    backupCodesLeft(pageId),
  ]);
  if (pageError) throw pageError;
  if (error) throw error;
  return ownerPage(page, links, { passkeys, backupCodesLeft: left, telegramReady: telegramConfigured() });
}
