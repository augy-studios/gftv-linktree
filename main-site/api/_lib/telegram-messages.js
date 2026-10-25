// The bot's structured messages, each built as { markdown, fallback } for
// sendRichTelegram. One-line notices are not here; they go out as plain text.

import { escapeMd, richTable } from './telegram.js';

// A six digit code for signing in or resetting a password.
// purpose: "sign-in" | "reset"
export function codeMessage({ purpose, slug, code, minutes }) {
  const page = `links.gftv.asia/${slug}`;
  const why = purpose === 'reset'
    ? 'Someone asked to reset the password of your OneLink GFTV page.'
    : 'Someone is signing in to your OneLink GFTV page.';
  const heading = purpose === 'reset' ? 'Password reset code' : 'Sign-in code';

  const markdown = [
    `## ${heading}`,
    '',
    escapeMd(why),
    '',
    // Inline code, so the client offers to copy it in one tap.
    `# \`${code}\``,
    '',
    richTable(['Detail'], [
      ['Page', page],
      ['Expires', `in ${minutes} minutes`],
    ]),
    '',
    `*If you did not ask for this, ignore it and change your password.*`,
  ].join('\n');

  const fallback = `${why}\n\nCode for ${page}: ${code}\n\nIt expires in ${minutes} minutes. If you did not ask for this, ignore it and change your password.`;
  return { markdown, fallback };
}

export function helpMessage() {
  const markdown = [
    '# OneLink GFTV',
    '',
    'This bot sends sign-in and recovery codes for pages at links.gftv.asia.',
    '',
    '## Commands',
    '',
    richTable(['What it does'], [
      ['/start', 'Link a page, from the link in your page editor'],
      ['/unlink', 'Stop receiving codes in this chat'],
    ]),
    '',
    '## Link a page',
    '',
    '1. Open your page editor at links.gftv.asia/edit',
    '2. Go to **Security** and choose **Link Telegram**',
    '3. Press Start here when Telegram opens',
  ].join('\n');

  const fallback =
    'This bot sends sign-in and recovery codes for OneLink GFTV pages at links.gftv.asia.\n\n' +
    'To link a page, open its editor, go to Security, and choose Link Telegram. Send /unlink here to stop receiving codes.';
  return { markdown, fallback };
}
