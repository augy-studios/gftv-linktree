// Rich messages, per telethon-richmessage-retrofit.md adapted to the Bot API.
import './harness.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendRichTelegram, escapeMd, escapeCell, richTable } from '../api/_lib/telegram.js';
import { codeMessage, helpMessage, linkCapMessage } from '../api/_lib/telegram-messages.js';

async function withBot(responder, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    calls.push({ method, body: JSON.parse(init.body) });
    return responder(method);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
}

test('structured messages go out with sendRichMessage, no parse_mode', async () => {
  await withBot(() => new Response('{"ok":true}'), async (calls) => {
    await sendRichTelegram(42, helpMessage());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
    assert.equal(calls[0].body.chat_id, 42);
    assert.match(calls[0].body.rich_message.markdown, /^# OneLink GFTV/);
    assert.equal(calls[0].body.parse_mode, undefined);
  });
});

test('a refused rich send falls back to the plain text, and does not throw', async () => {
  const warn = console.warn;
  const logged = [];
  console.warn = (m) => logged.push(m);
  try {
    await withBot(
      (method) => (method === 'sendRichMessage' ? new Response('{"ok":false}', { status: 400 }) : new Response('{"ok":true}')),
      async (calls) => {
        const rich = codeMessage({ purpose: 'sign-in', slug: 'augy', code: '123456', minutes: 5 });
        await sendRichTelegram(42, rich);
        assert.deepEqual(calls.map((c) => c.method), ['sendRichMessage', 'sendMessage']);
        assert.equal(calls[1].body.text, rich.fallback);
        assert.equal(calls[1].body.parse_mode, undefined);
      }
    );
  } finally {
    console.warn = warn;
  }
  assert.match(logged[0], /rich send failed, falling back/);
});

test('every structured message carries a fallback with the same facts', async () => {
  for (const purpose of ['sign-in', 'reset']) {
    const rich = codeMessage({ purpose, slug: 'my-page', code: '654321', minutes: 5 });
    assert.ok(rich.fallback.length > 0);
    for (const fact of ['654321', 'links.gftv.asia/my-page', '5 minutes']) {
      assert.ok(rich.fallback.includes(fact), `${purpose} fallback has ${fact}`);
      assert.ok(rich.markdown.includes(fact), `${purpose} markdown has ${fact}`);
    }
  }
  await assert.rejects(() => sendRichTelegram(1, { markdown: '# x', fallback: '' }));
});

test('escaping for Rich Markdown and table cells', () => {
  assert.equal(escapeMd('a*b_c|d#e[f]g`h~i>j=k\\l<m'), 'a\\*b\\_c\\|d\\#e\\[f\\]g\\`h\\~i\\>j\\=k\\\\l\\<m');
  assert.equal(escapeCell('two\nlines | here'), 'two lines \\| here');
  const table = richTable(['Value'], [['Name', 'a|b']]).split('\n');
  assert.equal(table[0], '|  | Value |');
  assert.equal(table[1], '| --- | --- |');
  assert.equal(table[2], '| Name | a\\|b |');
});

test('link limit answers say what was asked, what was given, and the note', () => {
  const approved = linkCapMessage({ slug: 'augy', outcome: 'approved', requested: 30, granted: 30, note: null });
  assert.match(approved.fallback, /approved\. Your limit is now 30/);
  assert.equal(approved.markdown.includes('Note from'), false);
  const compromise = linkCapMessage({ slug: 'augy', outcome: 'compromise', requested: 50, granted: 40, note: 'Halfway' });
  assert.match(compromise.markdown, /New limit \| 40/);
  assert.match(compromise.fallback, /raised to 40[\s\S]*Note from the GFTV team: Halfway/);
  const declined = linkCapMessage({ slug: 'augy', outcome: 'declined', requested: 50, granted: null, note: null });
  assert.equal(declined.markdown.includes('New limit'), false);
  assert.match(declined.fallback, /not approved this time/);
});
