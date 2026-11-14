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
  const moduleCount = qr.getModuleCount();
  const quiet = 2;
  const size = moduleCount + quiet * 2;
  let pathData = '';
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        pathData += `M${column + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
  }
  let titleSource = text;
  if (label) {
    titleSource = label;
  }
  const title = String(titleSource).replace(/[<&>"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${title}"><rect width="${size}" height="${size}"/><path d="${pathData}"/></svg>`;
}

// A PNG for saving or printing, always black on white.
export function qrPngUrl(text, scale = 12) {
  const qr = matrix(text);
  const moduleCount = qr.getModuleCount();
  const quiet = 4;
  const size = (moduleCount + quiet * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  // A print rule rather than a theme colour, the same pair as --qr-bg/--qr-fg.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#000000';
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
      }
    }
  }
  return canvas.toDataURL('image/png');
}

export function downloadQr(text, filename) {
  const link = document.createElement('a');
  link.href = qrPngUrl(text);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
