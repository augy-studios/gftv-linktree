// Second factors for page owners, shared by sign in, recovery and the
// security settings.

import { db, T } from './supabase.js';
import { decryptSecret, findMatchingCode, generateBackupCodes, hashCode, randomDigits, verifyPassword } from './crypto.js';
import { verifyTotp } from './totp.js';
import { countPasskeys } from './webauthn.js';
import { sendRichTelegram, CODE_MINUTES } from './telegram.js';
import { codeMessage } from './telegram-messages.js';
import { updateChallenge } from './session.js';
import bcrypt from 'bcryptjs';

export function ownerTotpOk(page, code) {
  const secret = decryptSecret(page.totp_secret);
  return Boolean(secret) && verifyTotp(code, secret);
}

// Spend a backup code. True if one matched.
export async function spendBackupCode(pageId, typed) {
  const { data, error } = await db()
    .from(T.recoveryCodes)
    .select('id, code_hash')
    .eq('page_id', pageId)
    .eq('used', false);
  if (error) throw error;
  const match = await findMatchingCode(typed, data ?? []);
  if (!match) return false;
  // Conditional on used = false, so two requests racing the same code cannot
  // both succeed.
  const { data: spent, error: spendError } = await db()
    .from(T.recoveryCodes)
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', match.id)
    .eq('used', false)
    .select('id');
  if (spendError) throw spendError;
  return (spent ?? []).length === 1;
}

// A fresh set of ten, replacing any old set. Returns the plain codes, which
// are shown once and never again.
export async function issueBackupCodes(pageId) {
  const codes = generateBackupCodes(10);
  const rows = await Promise.all(codes.map(async (code) => ({ page_id: pageId, code_hash: await hashCode(code) })));
  const { error: deleteError } = await db().from(T.recoveryCodes).delete().eq('page_id', pageId);
  if (deleteError) throw deleteError;
  const { error } = await db().from(T.recoveryCodes).insert(rows);
  if (error) throw error;
  return codes;
}

export async function backupCodesLeft(pageId) {
  const { count, error } = await db()
    .from(T.recoveryCodes)
    .select('id', { count: 'exact', head: true })
    .eq('page_id', pageId)
    .eq('used', false);
  if (error) throw error;
  return count ?? 0;
}

// How many real second factors the page has: the authenticator app counts
// as one, each passkey as one. Backup codes and Telegram do not count, since
// they are ways back in rather than the lock itself.
export async function secondFactorCount(page) {
  return (page.totp_secret ? 1 : 0) + (await countPasskeys('owner', page.id));
}

// Send a fresh Telegram code for a challenge, as a rich message with a plain
// fallback. Replaces any earlier code. purpose: "sign-in" | "reset".
export async function sendTelegramCode(challenge, page, purpose) {
  const code = randomDigits();
  await updateChallenge(challenge, {
    telegram_code_hash: await bcrypt.hash(code, 10),
    telegram_code_expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
  });
  await sendRichTelegram(page.telegram_chat_id, codeMessage({ purpose, slug: page.slug, code, minutes: CODE_MINUTES }));
}

export async function telegramCodeOk(challenge, typed) {
  if (!challenge.telegram_code_hash || !challenge.telegram_code_expires_at) return false;
  if (new Date(challenge.telegram_code_expires_at).getTime() <= Date.now()) return false;
  const digits = String(typed ?? '').replace(/\D/g, '');
  if (digits.length !== 6) return false;
  return bcrypt.compare(digits, challenge.telegram_code_hash);
}

export async function pagePasswordOk(pageId, password) {
  const { data, error } = await db().from(T.pages).select('password_hash').eq('id', pageId).single();
  if (error) throw error;
  return verifyPassword(password, data.password_hash);
}
