// Service role client. Server only: the key bypasses RLS, which is enabled on
// every gftvonelink_ table with no policies, so nothing else can read them.

import { createClient } from '@supabase/supabase-js';
import { requiredEnv } from './env.js';

let client = null;

// Tests run every route against an in-memory stand-in (tests/fake-db.js).
export function useTestClient(fake) {
  client = fake;
}

export function db() {
  if (!client) {
    client = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Table names, written once.
export const T = Object.freeze({
  pages: 'gftvonelink_pages',
  links: 'gftvonelink_links',
  passkeys: 'gftvonelink_passkeys',
  recoveryCodes: 'gftvonelink_recovery_codes',
  sessions: 'gftvonelink_sessions',
  staffSessions: 'gftvonelink_staff_sessions',
  staffPasskeys: 'gftvonelink_staff_passkeys',
  challenges: 'gftvonelink_auth_challenges',
  webauthn: 'gftvonelink_webauthn_challenges',
  telegramLinks: 'gftvonelink_telegram_links',
  reports: 'gftvonelink_reports',
  blockedSlugs: 'gftvonelink_blocked_slugs',
  blockedDomains: 'gftvonelink_blocked_domains',
  blockedPatterns: 'gftvonelink_blocked_patterns',
  reviewPatterns: 'gftvonelink_review_patterns',
  ipBans: 'gftvonelink_ip_bans',
  pageStats: 'gftvonelink_page_stats',
  testimonials: 'gftvonelink_testimonials',
  audit: 'gftvonelink_audit_logs',
  // Owned by gftv.asia. Read here, and the only write is spending a staff
  // backup code, which every GFTV site that accepts them does.
  staffUsers: 'gftvhello_users',
  staffBackupCodes: 'gftvhello_backup_codes',
});
