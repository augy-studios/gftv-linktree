// QR codes, drawn locally with the vendored qrcode-generator (MIT), so they
// work offline and the address is never sent to a third-party QR service.
// Pages that use this load /js/vendor/qrcode.js first, which defines the
// global `qrcode`.

function matrix(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

// An SVG string: a light square and one path for the dark modules. Colours
// come from --qr-fg and --qr-bg in CSS, so the code stays dark on light in
// every theme, which is what scanners need.
export function qrSvg(text, label) {
  const qr = matrix(text);
  const n = qr.getModuleCount();
  const quiet = 2;
  const size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const title = String(label || text).replace(/[<&>"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${title}"><rect width="${size}" height="${size}"/><path d="${d}"/></svg>`;
}

// A PNG for saving or printing, always black on white.
export function qrPngUrl(text, scale = 12) {
  const qr = matrix(text);
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = (n + quiet * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // A print rule rather than a theme colour, the same pair as --qr-bg/--qr-fg.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}

export function downloadQr(text, filename) {
  const a = document.createElement('a');
  a.href = qrPngUrl(text);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
