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

// ---------------------------------------------------------------------------
// Staff alerts: things staff should look at soon. TELEGRAM_STAFF_CHAT_ID is a
// list, separated by commas, spaces or new lines, of where they go:
//
//   -1001234567890   a group (negative; /chatid in the group shows it)
//   123456789        a person's DMs, by their Telegram id (/chatid in a DM
//                    with the bot shows it)
//   @name            a public channel or group, or a person by username
//
// A bot cannot start a conversation, so each person must message the bot
// once before it can DM them. A username is not enough to send to either:
// when a listed @name messages the bot privately, the webhook remembers that
// person's chat id (rememberStaffChat, gftvonelink_settings key
// staff_telegram_chats) and alerts go there. An @name never seen in a DM is
// sent to as a channel or group name.
//
// Unset, nothing is sent; the admin dashboard has it all anyway.
// ---------------------------------------------------------------------------

const STAFF_CHATS_SETTING = 'staff_telegram_chats';
const NUMERIC_CHAT = /^-?\d{1,16}$/;
const NAMED_CHAT = /^@[A-Za-z0-9_]{5,32}$/;
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);

// The listed targets, in order, without repeats: numeric ids as strings and
// @names lowercased. Anything else is skipped with a warning.
export function staffChatTargets(raw = optionalEnv('TELEGRAM_STAFF_CHAT_ID')) {
  const targets = [];
  for (const entry of String(raw ?? '').split(/[\s,;]+/).filter(Boolean)) {
    let target = null;
    if (NUMERIC_CHAT.test(entry)) target = entry;
    else if (NAMED_CHAT.test(entry)) target = entry.toLowerCase();
    if (!target) {
      console.warn(`[onelink] TELEGRAM_STAFF_CHAT_ID: skipping "${entry.slice(0, 40)}", not a chat id or @name`);
      continue;
    }
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

// { "@name": chatId } for listed people who have messaged the bot. Empty
// before migration 013 (the settings table) is run.
async function rememberedStaffChats() {
  const { data, error } = await db().from(T.settings).select('value').eq('key', STAFF_CHATS_SETTING).maybeSingle();
  if (error) {
    if (!MISSING_TABLE.has(error.code)) console.warn('[onelink] staff chats:', error.message);
    return {};
  }
  return data?.value && typeof data.value === 'object' ? data.value : {};
}

// From the webhook, for every private message: when the sender's @username is
// in TELEGRAM_STAFF_CHAT_ID, keep their chat id so alerts can reach their
// DMs. True when it was saved or already known.
export async function rememberStaffChat(username, chatId) {
  if (typeof username !== 'string' || !username) return false;
  const name = `@${username.toLowerCase()}`;
  if (!staffChatTargets().includes(name)) return false;
  const known = await rememberedStaffChats();
  if (known[name] === chatId) return true;
  const { error } = await db()
    .from(T.settings)
    .upsert({ key: STAFF_CHATS_SETTING, value: { ...known, [name]: chatId }, updated_at: new Date().toISOString() });
  if (error) {
    console.warn('[onelink] staff chats:', error.message);
    return false;
  }
  return true;
}

// Sends rich to every staff target, all at once. Returns how many it reached:
// 0 when staff alerts are off or every send failed. A failure is logged and
// never thrown, so it cannot undo the change it is about.
export async function notifyStaff(rich) {
  const targets = staffChatTargets();
  if (targets.length === 0 || !optionalEnv('TELEGRAM_BOT_TOKEN')) return 0;
  const known = targets.some((t) => t.startsWith('@')) ? await rememberedStaffChats() : {};
  const chats = [...new Set(targets.map((t) => (t.startsWith('@') && known[t] !== undefined ? String(known[t]) : t)))];
  const results = await Promise.all(chats.map(async (chatId) => {
    try {
      await sendRichTelegram(chatId, rich);
      return true;
    } catch (cause) {
      console.warn(`[onelink] staff alert to ${chatId}:`, cause?.message ?? cause);
      return false;
    }
  }));
  return results.filter(Boolean).length;
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
