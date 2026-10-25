// Showing a fresh set of backup codes, with copy and download.

import { t } from '../assets/i18n/i18n.js';
import { copyText } from './ui.js';

export function showCodes(list, codes, { copyButton, downloadButton, slug }) {
  list.replaceChildren(...codes.map((code) => {
    const li = document.createElement('li');
    li.textContent = code;
    return li;
  }));
  const text = `${t('codes.file-heading', { slug })}\n\n${codes.join('\n')}\n`;
  copyButton.onclick = () => copyText(codes.join('\n'));
  downloadButton.onclick = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `onelink-${slug}-backup-codes.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
