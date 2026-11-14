// Showing a fresh set of backup codes, with copy and download.

import { t as translate } from '../assets/i18n/i18n.js';
import { copyText } from './ui.js';

export function showCodes(list, codes, { copyButton, downloadButton, slug }) {
  list.replaceChildren(...codes.map((code) => {
    const listItem = document.createElement('li');
    listItem.textContent = code;
    return listItem;
  }));
  const text = `${translate('codes.file-heading', { slug })}\n\n${codes.join('\n')}\n`;
  copyButton.onclick = () => copyText(codes.join('\n'));
  downloadButton.onclick = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `onelink-${slug}-backup-codes.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
