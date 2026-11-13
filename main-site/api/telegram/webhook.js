// POST /api/telegram/webhook, called by Telegram for every bot update.
//
// Telegram proves the call is genuine by echoing the secret_token given to
// setWebhook in the X-Telegram-Bot-Api-Secret-Token header. That shared
// secret is compared in constant time; there is no request signing.
//
//   /start <token>   link this chat to the page that issued the token
//   /unlink          unlink this chat from every page it is linked to
//   anything else    the help message, as a rich message
//
// /chatid answers with the chat's id, for TELEGRAM_STAFF_CHAT_ID (staff
// alerts, _lib/telegram.js): in a group, the group's; in a DM, the person's.
// In a group the bot answers nothing else. A private message from someone
// listed in TELEGRAM_STAFF_CHAT_ID by @username also lets the bot DM them
// alerts from then on.
//
// The one-line confirmations stay plain text; only the help, which has
// headings and a table, goes out as a rich message.
//
// Always answers 200 once the secret matches, so Telegram does not retry an
// update that was understood and refused.

import { route, readJson, send } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { safeEqual } from '../_lib/crypto.js';
import { audit } from '../_lib/guards.js';
import { sendTelegram, sendRichTelegram, spendLinkToken, rememberStaffChat } from '../_lib/telegram.js';
import { helpMessage } from '../_lib/telegram-messages.js';

export default route('telegram/webhook', async (request, response) => {
  if (request.method !== 'POST') return send(response, 405, { ok: false });
  const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
  const given = String(request.headers['x-telegram-bot-api-secret-token'] || '');
  // Logged, because a webhook Telegram cannot get through to is otherwise
  // invisible: the bot just goes quiet. getWebhookInfo shows the same 401.
  if (!secret) {
    console.warn('[onelink] telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set; refusing the update');
    return send(response, 401, { ok: false });
  }
  if (!safeEqual(given, secret)) {
    console.warn(`[onelink] telegram webhook: secret token ${given ? 'does not match' : 'missing'}; check setWebhook's secret_token`);
    return send(response, 401, { ok: false });
  }
  if (!optionalEnv('TELEGRAM_BOT_TOKEN')) {
    console.warn('[onelink] telegram webhook: TELEGRAM_BOT_TOKEN is not set, so the bot cannot reply');
  }

  const update = await readJson(request, response);
  if (!update) return;
  const message = update.message;
  const chat = message?.chat;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (chat && (chat.type === 'group' || chat.type === 'supergroup') && /^\/chatid(?:@\w+)?$/.test(text)) {
    await sendTelegram(chat.id, `This chat's id is ${chat.id}. Set TELEGRAM_STAFF_CHAT_ID to it to send staff alerts here.`).catch((cause) =>
      console.warn('[onelink] telegram chatid:', cause?.message ?? cause)
    );
    return send(response, 200, { ok: true });
  }
  // Private chats only: a code must never land in a group.
  if (!chat || chat.type !== 'private' || !text) return send(response, 200, { ok: true });

  const reply = (body) =>
    sendTelegram(chat.id, body).catch((cause) => console.warn('[onelink] telegram reply:', cause?.message ?? cause));

  const staff = await rememberStaffChat(message.from?.username, chat.id);
  if (/^\/chatid(?:@\w+)?$/.test(text)) {
    await reply(staff
      ? `Your chat id is ${chat.id}. You are on the staff alert list, so alerts will come here.`
      : `Your chat id is ${chat.id}. Add it to TELEGRAM_STAFF_CHAT_ID to get staff alerts here.`);
    return send(response, 200, { ok: true });
  }

  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (start && start[1]) {
    const pageId = await spendLinkToken(start[1]);
    if (!pageId) {
      await reply('That link has expired or was already used. Make a new one from the Security section of your page editor.');
      return send(response, 200, { ok: true });
    }
    const username = typeof message.from?.username === 'string' ? message.from.username.slice(0, 64) : null;
    const { data: page, error } = await database()
      .from(TABLES.pages)
      .update({ telegram_chat_id: chat.id, telegram_username: username })
      .eq('id', pageId)
      .eq('status', 'active')
      .select('slug')
      .maybeSingle();
    if (error) throw error;
    if (page) {
      await audit(null, { action: 'security.telegram_linked', actorType: 'owner', actorId: pageId, pageId });
      await reply(`Linked to links.gftv.asia/${page.slug}. Sign-in and recovery codes for that page will arrive here.`);
    }
    return send(response, 200, { ok: true });
  }

  if (/^\/unlink(?:@\w+)?$/.test(text)) {
    const { data, error } = await database()
      .from(TABLES.pages)
      .update({ telegram_chat_id: null, telegram_username: null })
      .eq('telegram_chat_id', chat.id)
      .select('id');
    if (error) throw error;
    for (const row of data ?? []) {
      await audit(null, { action: 'security.telegram_unlinked', actorType: 'owner', actorId: row.id, pageId: row.id, details: { via: 'bot' } });
    }
    await reply((data ?? []).length > 0 ? 'Unlinked. This chat will not receive codes any more.' : 'This chat is not linked to any page.');
    return send(response, 200, { ok: true });
  }

  await sendRichTelegram(chat.id, helpMessage()).catch((cause) =>
    console.warn('[onelink] telegram help:', cause?.message ?? cause)
  );
  send(response, 200, { ok: true });
});
