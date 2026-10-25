# Retrofit: real Telegram Rich Messages (headings/tables) for this Telethon bot

This bot uses Telethon (MTProto). I want structured replies sent as genuine Telegram
Rich Messages (Bot API 10.1+ feature: https://core.telegram.org/bots/features#rich-messages)
instead of parse_mode Markdown/HTML approximations. Telethon's high-level
`send_message`/`edit_message` don't expose the `rich_message` field, so use the raw
TL requests. Follow this design exactly; it is proven in production.

## 1. Dependency
- Bump `telethon>=1.44.0` (first TL layer with `rich_message` on
  `messages.SendMessageRequest` / `messages.EditMessageRequest` /
  `messages.EditInlineBotMessageRequest`, plus `types.InputRichMessageMarkdown`
  and `types.InputBotInlineMessageRichMessage`). Verify these names import.

## 2. Message contract
Every view/builder that produces structured content returns a dict:
    rich = {"markdown": <Rich Markdown string>, "fallback": <plain text string>}
- `markdown`: GitHub-Flavored Markdown as Telegram's Rich Markdown dialect —
  `# Heading`, `## Subheading`, `*italic*`, `_italic_`, `**bold**`, bullet lists,
  and pipe tables (`| A | B |` / `| --- | --- |` / rows).
- `fallback`: plain text conveying the same information. It goes in the request's
  REQUIRED `message=` field and is what old clients see / what gets sent if the
  rich payload is rejected. Never leave it empty.
- Keep one-line notices ("Nothing found.") as ordinary `event.respond(...)`.
  Only content with headings/tables/sections needs the rich path.

## 3. Create `reply.py` with these helpers (no parse_mode anywhere in them)

    from telethon import types
    from telethon.errors import MessageNotModifiedError
    from telethon.tl import functions

    def _rich_markdown(rich):
        return types.InputRichMessageMarkdown(markdown=rich["markdown"])

    # Editing without reply_markup keeps the old keyboard; an empty inline
    # keyboard is what actually removes it.
    _NO_BUTTONS = types.ReplyInlineMarkup(rows=[])

    def sent_message_id(result):
        """Id of the message a raw send created (bot sends come back as Updates)."""
        if isinstance(result, (types.Message, types.UpdateShortSentMessage)):
            return result.id
        for update in getattr(result, "updates", []):
            if isinstance(update, types.UpdateMessageID):
                return update.id
            if isinstance(update, (types.UpdateNewMessage, types.UpdateNewChannelMessage)):
                return update.message.id
        return None

    async def send_rich_message(client, entity, rich, buttons=None):
        markup = client.build_reply_markup(buttons) if buttons else None
        try:
            return await client(functions.messages.SendMessageRequest(
                peer=entity, message=rich["fallback"],
                rich_message=_rich_markdown(rich), reply_markup=markup))
        except Exception as err:
            print(f"[send_rich_message] rich send failed, falling back: {err}")
            return await client.send_message(entity, rich["fallback"], buttons=buttons)

    async def edit_rich_message_at(client, peer, msg_id, rich, buttons=None):
        """Edit by chat + message id. No buttons => keyboard removed."""
        markup = client.build_reply_markup(buttons) if buttons else _NO_BUTTONS
        try:
            await client(functions.messages.EditMessageRequest(
                peer=peer, id=msg_id, message=rich["fallback"],
                rich_message=_rich_markdown(rich), reply_markup=markup))
        except MessageNotModifiedError:
            return
        except Exception as err:
            print(f"[edit_rich_message_at] rich edit failed, falling back: {err}")
            await client.edit_message(peer, msg_id, text=rich["fallback"], buttons=buttons)

    async def edit_rich_message(client, event, rich, buttons=None):
        """Edit the message a CallbackQuery came from — regular chat or inline-mode."""
        markup = client.build_reply_markup(buttons) if buttons else None
        is_inline = isinstance(event.query, types.UpdateInlineBotCallbackQuery)
        try:
            if is_inline:
                await client(functions.messages.EditInlineBotMessageRequest(
                    id=event.query.msg_id, message=rich["fallback"],
                    rich_message=_rich_markdown(rich), reply_markup=markup))
            else:
                await client(functions.messages.EditMessageRequest(
                    peer=event.query.peer, id=event.query.msg_id, message=rich["fallback"],
                    rich_message=_rich_markdown(rich), reply_markup=markup))
        except MessageNotModifiedError:
            return
        except Exception as err:
            print(f"[edit_rich_message] rich edit failed, falling back: {err}")
            if is_inline:
                await client.edit_message(event.query.msg_id, text=rich["fallback"], buttons=buttons)
            else:
                await client.edit_message(event.query.peer, event.query.msg_id,
                                          text=rich["fallback"], buttons=buttons)

## 4. Escaping helpers (put next to the formatters)

    import re
    _MD_SPECIAL = re.compile(r"([\\*_~`|\[\]#>=])")

    def escape_md(text) -> str:
        """Escape user/data text for Telegram's Rich Markdown dialect."""
        return _MD_SPECIAL.sub(r"\\\1", str(text))

    def escape_cell(text) -> str:
        """Escape for a GFM table cell; also flattens newlines so the row stays intact."""
        return escape_md(str(text).replace("\n", " "))

Run every piece of dynamic data (names, user input, API strings) through
`escape_md`, and table cell contents through `escape_cell`. Literal markup you
author yourself (`#`, `|`, `*`) is NOT escaped.

Table template:
    lines = ["| " + " | ".join(["", *headers]) + " |",
             "| " + " | ".join(["---"] * (len(headers) + 1)) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(escape_cell(v) for v in row) + " |")


## 5. Migrate call sites
- Find every `event.respond`, `event.reply`, `client.send_message`,
  `event.edit`, `client.edit_message` that sends structured content
  (or uses parse_mode='md'/'html' for headings-like layout).
- Refactor the text-building code into a `build_<view>()` that returns
  `(rich, buttons)`; drop the parse_mode formatting.
- Commands: `await send_rich_message(client, event.chat_id, rich, buttons)`.
- Callback buttons that redraw the same message:
  `await edit_rich_message(client, event, rich, buttons)`.
- Anything editing a message you stored the id of (schedulers, "go back"
  flows): `await edit_rich_message_at(client, chat_id, msg_id, rich, buttons)`;
  use `sent_message_id(result)` on the return value of `send_rich_message`
  to capture that id.
- Inline mode (`events.InlineQuery`): build results as raw
      types.InputBotInlineResult(
          id=..., type="article", title=..., description=...,
          send_message=types.InputBotInlineMessageRichMessage(
              rich_message=types.InputRichMessageMarkdown(markdown=rich["markdown"]),
              reply_markup=client.build_reply_markup(buttons)))
  and answer with `functions.messages.SetInlineBotResultsRequest` (Telethon's
  `event.builder.article` cannot carry a rich message).

## 6. Do NOT
- Pass `parse_mode` alongside `rich_message` — the fallback `message` is plain.
- Put newlines or unescaped `|` inside table cells.
- Send `rich_message` with an empty `message=` field.
- Let a rich failure surface as an unhandled error; the helpers always fall
  back to plain text and log the reason.

## 7. Verify
- Import check: `python -c "from telethon import types; types.InputRichMessageMarkdown; types.InputBotInlineMessageRichMessage"`.
- Run the bot; trigger each migrated command, each callback edit, and one
  inline query. Headings and tables must render natively on a current client;
  logs must show no "falling back" lines.
- Confirm a message edited with no buttons loses its keyboard.

Report: files touched, each call site migrated, and any content you left as
plain text (with why).
