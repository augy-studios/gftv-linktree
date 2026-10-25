// Telegram Bot API: the optional recovery channel for page owners.
//
// Linking: a signed-in owner gets a one-time t.me deep link. Tapping Start in
// the bot sends "/start <token>" to the webhook, which saves the chat id.
// Codes: the bot sends a six digit code to that chat, for signing in without
// the usual second factor or for resetting a forgotten password.

import { db, T } from './supabase.js';
import { optionalEnv } from './env.js';
import { randomToken, sha256 } from './crypto.js';

export const LINK_TOKEN_MINUTES = 10;
export const CODE_MINUTES = 5;

export function telegramConfigured() {
  return optionalEnv('TELEGRAM_BOT_TOKEN') !== '' && optionalEnv('TELEGRAM_BOT_USERNAME') !== '';
}

async function callBot(method, payload) {
  const token = optionalEnv('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`telegram ${method} ${response.status}: ${body.slice(0, 200)}`);
  }
}

// Plain text, no parse_mode. For one-line notices ("Linked.", "Unlinked.").
export function sendTelegram(chatId, text) {
  return callBot('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

// ---------------------------------------------------------------------------
// Rich Messages (Bot API 10.1, sendRichMessage), per
// telethon-richmessage-retrofit.md adapted to the HTTP Bot API.
//
// Every structured message is { markdown, fallback }: Rich Markdown for
// clients that render it, and plain text carrying the same information.
// sendRichMessage has no plain field of its own, so the fallback is sent with
// sendMessage whenever the rich send is refused, and the reason is logged.
// A rich failure never surfaces as an error to the route.
// ---------------------------------------------------------------------------

export async function sendRichTelegram(chatId, rich) {
  if (!rich || !rich.fallback) throw new Error('a rich message needs a plain fallback');
  try {
    await callBot('sendRichMessage', { chat_id: chatId, rich_message: { markdown: rich.markdown } });
  } catch (err) {
    console.warn(`[onelink] rich send failed, falling back: ${err?.message ?? err}`);
    await sendTelegram(chatId, rich.fallback);
  }
}

// Escape data for Rich Markdown: the spec's set, plus "<", since Rich
// Markdown also accepts HTML tags and a stray "<" in data could open one.
// Literal markup written in the builders is not escaped.
const MD_SPECIAL = /([\\*_~`|[\]#>=<])/g;

export function escapeMd(text) {
  return String(text).replace(MD_SPECIAL, '\\$1');
}

// For a table cell: also flattens newlines so the row stays one line.
export function escapeCell(text) {
  return escapeMd(String(text).replace(/\r?\n/g, ' '));
}

// The spec's table template: a blank corner cell over the row labels, so each
// row is [label, ...values] for one header per value column.
export function richTable(headers, rows) {
  const lines = [
    `| ${['', ...headers].join(' | ')} |`,
    `| ${Array(headers.length + 1).fill('---').join(' | ')} |`,
  ];
  for (const row of rows) lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
  return lines.join('\n');
}

export async function createLinkToken(pageId) {
  await db().from(T.telegramLinks).delete().eq('page_id', pageId).is('used_at', null);
  const token = randomToken(24);
  const { error } = await db().from(T.telegramLinks).insert({
    page_id: pageId,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + LINK_TOKEN_MINUTES * 60_000).toISOString(),
  });
  if (error) throw error;
  return {
    url: `https://t.me/${optionalEnv('TELEGRAM_BOT_USERNAME')}?start=${token}`,
    expiresInMinutes: LINK_TOKEN_MINUTES,
  };
}

// The page a deep link token belongs to, spending the token, or null.
export async function spendLinkToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { data, error } = await db()
    .from(T.telegramLinks)
    .select('id, page_id, expires_at, used_at')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.used_at || new Date(data.expires_at).getTime() <= Date.now()) return null;
  await db().from(T.telegramLinks).update({ used_at: new Date().toISOString() }).eq('id', data.id);
  return data.page_id;
}
