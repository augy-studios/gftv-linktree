// The picture editor: frame the picture in the circle it is shown in,
// optionally remove its background, and choose what goes behind.
//
// Everything happens on this device. Background removal runs in a worker
// (js/bg-removal-worker.js); the finished 512 x 512 picture is compressed to
// WebP here and re-encoded once more by the server.
//
// Framing, so nothing is cut off by the round frame:
//   - a cut-out is scaled until every part of the subject sits inside the
//     circle with a margin, centred on the subject;
//   - a photo starts as the centred square that fills the circle.
// Either can then be moved and zoomed, and Reset framing goes back to that.

import { t } from '../assets/i18n/i18n.js';
import { openModal, closeModal, setBusy, errorText } from './ui.js';
import { ColourWheel, parseHex } from './colour-wheel.js';

const OUT = 512; // the stored picture's size
const MASK = 1024; // the model's mask size
const MAX_SOURCE = 2048; // longest side kept in memory
// The share of the circle's radius a cut-out may fill. The rest is margin,
// so ears, tails and hair stay inside the round frame.
const FIT = 0.9;

// Preset backgrounds. These are colours for the person's picture, not
// interface colours, so they are not theme tokens.
export const BG_COLOURS = [
  ['yellow', '#fedc00'],
  ['blue-grey', '#4a6a8a'],
  ['white', '#ffffff'],
  ['black', '#14120a'],
  ['pink', '#f7b2c9'],
  ['mint', '#a8e6cf'],
  ['lavender', '#c9b6f2'],
  ['sky', '#9fd3f5'],
];

// Preset gradients: [name, start, end, direction in degrees]. Like the
// colours above, these are the picture's colours, not the interface's.
export const BG_GRADIENTS = [
  ['sunrise', '#fedc00', '#ff6b74', 135],
  ['ocean', '#9fd3f5', '#4a6a8a', 180],
  ['mint', '#a8e6cf', '#9fd3f5', 135],
  ['candy', '#f7b2c9', '#c9b6f2', 45],
  ['dusk', '#4a6a8a', '#14120a', 180],
  ['gftv', '#fedc00', '#4a6a8a', 135],
];

const $ = (id) => document.getElementById(id);
const fail = (code) => Object.assign(new Error(code), { code });

let state = null;

// The swatches, wheel and hex field edit one colour: the solid background,
// or whichever end of the gradient is selected.
function activeColour() {
  return state.bg === 'gradient' ? state.gradient[state.stop] : state.colour;
}
function setActiveColour(hex) {
  if (state.bg === 'gradient') state.gradient[state.stop] = hex;
  else state.colour = hex;
}
let wheel = null;
let onSave = null;
let worker = null;
let jobId = 0;

// --- loading ---------------------------------------------------------------

async function loadBitmap(file) {
  if (!file || !String(file.type).startsWith('image/')) throw fail('avatar_invalid');
  if (file.size > 25 * 1024 * 1024) throw fail('avatar_too_large');
  let bitmap;
  try {
    // from-image applies the camera's rotation before the metadata is lost.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw fail('avatar_invalid');
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= MAX_SOURCE) return bitmap;
  const k = MAX_SOURCE / longest;
  const small = await createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * k),
    resizeHeight: Math.round(bitmap.height * k),
    resizeQuality: 'high',
  });
  bitmap.close?.();
  return small;
}

// --- framing ---------------------------------------------------------------

function coverScale(w, h) {
  return OUT / Math.min(w, h);
}

// Where the subject is, from the mask: its box, which picture edges it runs
// into (a subject cut off by the photo has a straight edge there), its centre,
// and the distance from that centre to its farthest visible pixel. Source
// pixels throughout.
function subjectOf(mask, w, h) {
  let minX = MASK;
  let minY = MASK;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < MASK; y += 2) {
    for (let x = 0; x < MASK; x += 2) {
      if (mask[y * MASK + x] > 96) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const sx = w / MASK;
  const sy = h / MASK;
  const cx = ((minX + maxX) / 2) * sx;
  const cy = ((minY + maxY) / 2) * sy;
  let far = 0;
  for (let y = minY; y <= maxY; y += 2) {
    for (let x = minX; x <= maxX; x += 2) {
      if (mask[y * MASK + x] > 96) far = Math.max(far, Math.hypot((x + 1) * sx - cx, (y + 1) * sy - cy));
    }
  }
  // A sample of the subject's pixels, for the portrait framing below, and the
  // middle of its top part (its head, in a head-and-shoulders shot).
  const points = [];
  const headLimit = minY + (maxY - minY) * 0.4;
  let headMin = MASK;
  let headMax = -1;
  for (let y = minY; y <= maxY; y += 4) {
    for (let x = minX; x <= maxX; x += 4) {
      if (mask[y * MASK + x] > 96) {
        points.push((x + 0.5) * sx, (y + 0.5) * sy);
        if (y <= headLimit) {
          if (x < headMin) headMin = x;
          if (x > headMax) headMax = x;
        }
      }
    }
  }
  // How much of each edge the subject runs along. A subject cut off by the
  // photo covers a long stretch; an ear tip or a wisp of fur that merely
  // reaches an edge covers a few pixels, and is not a cut.
  const band = 6;
  const along = (isEdge, length) => {
    let hits = 0;
    for (let i = 0; i < length; i += 1) {
      for (let j = 0; j < band; j += 1) {
        if (mask[isEdge(i, j)] > 96) { hits += 1; break; }
      }
    }
    return hits / length;
  };
  const CUT = 0.08;
  const touches = {
    top: along((i, j) => j * MASK + i, MASK) >= CUT,
    bottom: along((i, j) => (MASK - 1 - j) * MASK + i, MASK) >= CUT,
    left: along((i, j) => i * MASK + j, MASK) >= CUT,
    right: along((i, j) => i * MASK + (MASK - 1 - j), MASK) >= CUT,
  };
  // The subject's pixels along each cut edge: where a straight line would
  // show if that edge came inside the circle.
  const edgePoints = { top: [], bottom: [], left: [], right: [] };
  const addEdge = (side, at) => {
    if (!touches[side]) return;
    for (let i = 0; i < MASK; i += 2) {
      const [x, y] = at(i);
      if (mask[y * MASK + x] > 96) edgePoints[side].push((x + 0.5) * sx, (y + 0.5) * sy);
    }
  };
  addEdge('top', (i) => [i, 0]);
  addEdge('bottom', (i) => [i, MASK - 1]);
  addEdge('left', (i) => [0, i]);
  addEdge('right', (i) => [MASK - 1, i]);
  return {
    cx,
    cy,
    headX: headMax >= 0 ? ((headMin + headMax) / 2) * sx : cx,
    points,
    radius: Math.max(far, 1),
    top: minY * sy,
    bottom: (maxY + 2) * sy,
    touches,
    edgePoints,
  };
}

function smartFrame() {
  const { w, h } = state;
  const s = state.subject;
  const cut = s && (s.touches.top || s.touches.bottom || s.touches.left || s.touches.right);
  if (state.removed && s && !cut) {
    // A whole subject: every part inside the circle, with a margin.
    state.base = ((OUT / 2) * FIT) / s.radius;
    state.view = { cx: s.cx, cy: s.cy, scale: state.base };
  } else if (state.removed && s) {
    // A subject the photo cuts off has straight edges where it was cut. Only
    // the circle is ever seen, so those edges just have to land outside it.
    // A head-and-shoulders shot (cut at the bottom) is pinned with that cut
    // at the circle's bottom and centred on the head; any other cut is
    // centred on the subject.
    const portrait = s.touches.bottom && !s.touches.top;
    const centre = portrait ? s.headX : s.cx;
    const cyAt = portrait ? (scale) => s.bottom - OUT / (2 * scale) : () => s.cy;
    // Nudging the centre sideways often lets the subject fit and the cuts
    // stay hidden at once. Try a few positions around the head; keep the
    // largest zoom that meets both, or the best effort if none does.
    const step = (s.radius * 0.08);
    let best = null;
    for (const k of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
      const cx = Math.min(Math.max(centre + k * step, 0), w);
      const r = frameScale(s, cx, cyAt, portrait);
      // Meeting both rules beats not; among those, the largest zoom. When
      // none meets both, each result is the least zoom that hides the cuts,
      // so the smallest one is the least crop.
      const better = !best
        || (r.both && !best.both)
        || (r.both && best.both && r.scale > best.scale)
        || (!r.both && !best.both && r.scale < best.scale);
      if (better) best = { ...r, cx };
    }
    state.base = best.scale;
    state.view = { cx: best.cx, cy: cyAt(best.scale), scale: best.scale };
  } else {
    state.base = coverScale(w, h);
    state.view = { cx: w / 2, cy: h / 2, scale: state.base };
  }
  clampView();
}

// The zoom for a cut-off subject, from two searches over the sampled pixels:
//   the largest zoom at which the subject (above the lower quarter, for a
//   portrait: head, ears, hair) stays inside the circle with a margin, and
//   the smallest zoom at which every pixel along a cut edge falls outside
//   the circle, so no straight cut line can be seen.
// The first wins when both can be met. When they cannot, hiding the cut
// wins: a straight line through the picture looks wrong, an ear touching
// the rim does not.
function frameScale(s, cx, cyAt, portrait) {
  const C = OUT / 2;
  const R = C * FIT;
  const project = (x, y, scale) => [C + (x - cx) * scale, C + (y - cyAt(scale)) * scale];
  const subjectInside = (scale) => {
    for (let i = 0; i < s.points.length; i += 2) {
      const [X, Y] = project(s.points[i], s.points[i + 1], scale);
      if (portrait && Y > OUT * 0.75) continue;
      if (Math.hypot(X - C, Y - C) > R) return false;
    }
    return true;
  };
  // A portrait's bottom cut is pinned to the circle's edge already, so its
  // pixels sit on the rim; only the other cut edges are tested.
  const sides = ['top', 'left', 'right'].concat(portrait ? [] : ['bottom']);
  const cutsHidden = (scale) => {
    for (const side of sides) {
      const pts = s.edgePoints[side];
      for (let i = 0; i < pts.length; i += 2) {
        const [X, Y] = project(pts[i], pts[i + 1], scale);
        if (Math.hypot(X - C, Y - C) < C - 1) return false;
      }
    }
    return true;
  };
  // Bisection for the boundary of a test that holds on one side of it.
  const search = (lo, hi, holdsAtLo, test) => {
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2;
      if (test(mid) === holdsAtLo) lo = mid;
      else hi = mid;
    }
    return holdsAtLo ? lo : hi;
  };

  const top = OUT / Math.max(s.bottom - s.top, s.radius, 1);
  const lo = top * 0.2;
  const hi = top * 6;
  const largestInside = subjectInside(hi) ? hi : subjectInside(lo) ? search(lo, hi, true, subjectInside) : lo;
  if (cutsHidden(largestInside)) return { scale: largestInside, both: true };
  // Zooming in pushes the cut edges outwards; find the least that hides them.
  if (!cutsHidden(hi)) return { scale: largestInside, both: false };
  return { scale: search(largestInside, hi, false, cutsHidden), both: false };
}

// A photo keeps covering the whole square, so no empty corner shows. A
// cut-out has a background behind it and may move more freely, as long as
// its centre stays within the picture.
function clampView() {
  const { w, h, view } = state;
  const minScale = state.removed ? state.base * 0.5 : coverScale(w, h);
  view.scale = Math.min(Math.max(view.scale, minScale), state.base * 4);
  if (state.removed) {
    view.cx = Math.min(Math.max(view.cx, 0), w);
    view.cy = Math.min(Math.max(view.cy, 0), h);
  } else {
    const half = OUT / 2 / view.scale;
    view.cx = Math.min(Math.max(view.cx, half), w - half);
    view.cy = Math.min(Math.max(view.cy, half), h - half);
  }
}

// --- drawing ---------------------------------------------------------------

function drawCover(ctx, image, size) {
  const k = size / Math.min(image.width, image.height);
  const dw = image.width * k;
  const dh = image.height * k;
  ctx.drawImage(image, (size - dw) / 2, (size - dh) / 2, dw, dh);
}

function draw(ctx, size) {
  const { view } = state;
  ctx.clearRect(0, 0, size, size);
  if (state.removed) {
    if (state.bg === 'gradient') {
      // CSS's convention: 0 degrees runs upwards, 90 to the right.
      const a = (state.gradient.angle * Math.PI) / 180;
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      const half = (Math.abs(dx) + Math.abs(dy)) * (size / 2);
      const g = ctx.createLinearGradient(size / 2 - dx * half, size / 2 - dy * half, size / 2 + dx * half, size / 2 + dy * half);
      g.addColorStop(0, state.gradient.from);
      g.addColorStop(1, state.gradient.to);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    } else if (state.bg === 'colour') {
      ctx.fillStyle = state.colour;
      ctx.fillRect(0, 0, size, size);
    } else if (state.bg === 'image' && state.bgImage) {
      drawCover(ctx, state.bgImage, size);
    }
  }
  const k = size / OUT;
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(size / 2, size / 2);
  ctx.scale(view.scale * k, view.scale * k);
  ctx.translate(-view.cx, -view.cy);
  ctx.drawImage(state.removed ? state.cutout : state.source, 0, 0);
  ctx.restore();
}

function render() {
  const canvas = $('composerCanvas');
  draw(canvas.getContext('2d'), canvas.width);
  $('composerZoom').value = String(state.view.scale / state.base);
  syncControls();
}

function syncControls() {
  const removeBtn = $('composerRemoveBg');
  removeBtn.setAttribute('aria-pressed', String(state.removed));
  removeBtn.querySelector('span:last-child').textContent = t(state.removed ? 'avatar.restore-bg' : 'avatar.remove-bg');
  $('composerBg').hidden = !state.removed;
  document.querySelectorAll('#composerBgMode [data-bg]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.bg === state.bg));
  });
  $('composerColourBlock').hidden = state.bg !== 'colour' && state.bg !== 'gradient';
  $('composerGradientBlock').hidden = state.bg !== 'gradient';
  if (state.bg === 'gradient') {
    const { from, to, angle } = state.gradient;
    document.querySelectorAll('#composerStops [data-stop]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.stop === state.stop));
    });
    $('stopFrom').style.background = from;
    $('stopTo').style.background = to;
    $('gradientAngle').value = String(angle);
    $('gradientAngleValue').textContent = t('avatar.gradient-degrees', { angle });
    document.querySelectorAll('#composerGradients [data-gradient]').forEach((b) => {
      const [, f2, t2, a2] = BG_GRADIENTS.find(([name]) => name === b.dataset.gradient);
      b.setAttribute('aria-pressed', String(f2 === from && t2 === to && a2 === angle));
    });
  }
  $('composerBgImageRow').hidden = state.bg !== 'image';
  document.querySelectorAll('#composerColours [data-colour]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.colour === activeColour()));
  });
  const preset = BG_COLOURS.some(([, hex]) => hex === activeColour());
  $('composerCustomToggle').setAttribute('aria-pressed', String(!preset));
  $('composerZoom').min = state.removed ? '0.5' : '1';
}

// --- background removal ----------------------------------------------------

function getWorker() {
  if (!worker) worker = new Worker('/js/bg-removal-worker.js', { type: 'module' });
  return worker;
}

function status(text, busy = false) {
  const el = $('composerStatus');
  el.replaceChildren();
  if (busy) {
    const wrap = document.createElement('span');
    wrap.className = 'delayed';
    wrap.setAttribute('aria-hidden', 'true');
    const spin = document.createElement('span');
    spin.className = 'spinner';
    wrap.appendChild(spin);
    el.appendChild(wrap);
  }
  el.append(text);
}

function removeBackground() {
  const id = (jobId += 1);
  const w = getWorker();
  status(t('avatar.preparing'), true);
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') {
        if (msg.stage === 'download') {
          const mb = (n) => (n / 1e6).toFixed(0);
          status(msg.total ? t('avatar.downloading', { loaded: mb(msg.loaded), total: mb(msg.total) }) : t('avatar.preparing'), true);
        } else {
          status(t('avatar.removing'), true);
        }
      } else {
        w.removeEventListener('message', onMessage);
        if (msg.type === 'done') resolve(msg.mask);
        else reject(Object.assign(new Error(msg.message), { code: 'bg_failed' }));
      }
    };
    w.addEventListener('message', onMessage);
    createImageBitmap(state.source).then((copy) => w.postMessage({ type: 'remove', id, bitmap: copy }, [copy]));
  });
}

// The source with the mask as its alpha, at the source's own size.
function makeCutout(mask) {
  const { w, h } = state;
  const maskCanvas = new OffscreenCanvas(MASK, MASK);
  const mctx = maskCanvas.getContext('2d');
  const img = mctx.createImageData(MASK, MASK);
  for (let i = 0; i < mask.length; i += 1) {
    img.data[i * 4 + 3] = mask[i];
  }
  mctx.putImageData(img, 0, 0);
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.drawImage(state.source, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(maskCanvas, 0, 0, w, h);
  return out;
}

async function toggleRemoval() {
  const button = $('composerRemoveBg');
  $('composerError').textContent = '';
  if (state.removed) {
    state.removed = false;
    smartFrame();
    status('');
    return render();
  }
  if (!state.cutout) {
    setBusy(button, true);
    try {
      const mask = await removeBackground();
      state.cutout = makeCutout(mask);
      state.subject = subjectOf(mask, state.w, state.h);
    } catch (error) {
      // The reason, for whoever is looking at why it failed on a device.
      console.warn('[background removal]', error?.message ?? error);
      status('');
      $('composerError').textContent = errorText(error.code ? error : { code: 'bg_failed' });
      return;
    } finally {
      setBusy(button, false);
    }
  }
  state.removed = true;
  smartFrame();
  status(t('avatar.removed-ok'));
  render();
}

// --- interaction -----------------------------------------------------------

function wire() {
  const canvas = $('composerCanvas');
  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const perPx = OUT / canvas.clientWidth / state.view.scale;
    state.view.cx = drag.cx - (e.clientX - drag.x) * perPx;
    state.view.cy = drag.cy - (e.clientY - drag.y) * perPx;
    clampView();
    render();
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.view.scale *= e.deltaY < 0 ? 1.06 : 1 / 1.06;
    clampView();
    render();
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 12 / state.view.scale;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      state.view.cx += moves[e.key][0];
      state.view.cy += moves[e.key][1];
    } else if (e.key === '+' || e.key === '=') {
      state.view.scale *= 1.06;
    } else if (e.key === '-' || e.key === '_') {
      state.view.scale /= 1.06;
    } else {
      return;
    }
    e.preventDefault();
    clampView();
    render();
  });

  $('composerZoom').addEventListener('input', (e) => {
    state.view.scale = state.base * Number(e.target.value);
    clampView();
    render();
  });
  $('composerReset').addEventListener('click', () => { smartFrame(); render(); });
  $('composerRemoveBg').addEventListener('click', toggleRemoval);

  $('composerBgMode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bg]');
    if (!b) return;
    state.bg = b.dataset.bg;
    if (state.bg === 'image' && !state.bgImage) $('composerBgFile').click();
    render();
  });
  $('composerColours').addEventListener('click', (e) => {
    const b = e.target.closest('[data-colour]');
    if (!b) return;
    setActiveColour(b.dataset.colour);
    if (!$('composerCustom').hidden) wheel.set(parseHex(activeColour()), { quiet: true });
    render();
  });
  $('composerGradients').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gradient]');
    if (!b) return;
    const [, from, to, angle] = BG_GRADIENTS.find(([name]) => name === b.dataset.gradient);
    state.gradient = { from, to, angle };
    if (!$('composerCustom').hidden) wheel.set(parseHex(activeColour()), { quiet: true });
    render();
  });
  $('composerStops').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stop]');
    if (!b) return;
    state.stop = b.dataset.stop;
    if (!$('composerCustom').hidden) wheel.set(parseHex(activeColour()), { quiet: true });
    render();
  });
  $('gradientAngle').addEventListener('input', (e) => {
    state.gradient.angle = Number(e.target.value);
    render();
  });

  // Custom colour: the wheel and a hex field, from the colorguess game.
  wheel = new ColourWheel(
    { wrap: $('wheelWrap'), canvas: $('wheelCanvas'), marker: $('wheelMarker'), slider: $('wheelBrightness'), hex: $('wheelHex'), preview: $('wheelPreview') },
    (hex) => {
      setActiveColour(hex.toLowerCase());
      render();
    },
    (w, hex) => t('avatar.wheel-value', { hex, hue: Math.round(w.h), sat: Math.round(w.s * 100), bright: Math.round(w.v * 100) })
  );
  $('composerCustomToggle').addEventListener('click', () => {
    const panel = $('composerCustom');
    const opening = panel.hidden;
    panel.hidden = !opening;
    $('composerCustomToggle').setAttribute('aria-expanded', String(opening));
    if (opening) {
      wheel.set(parseHex(activeColour()) ?? 0xfedc00, { quiet: true });
      wheel.drawnFor = null;
      wheel.draw();
    }
  });
  $('composerBgFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      state.bgImage?.close?.();
      state.bgImage = await loadBitmap(file);
      state.bg = 'image';
      $('composerError').textContent = '';
      render();
    } catch (error) {
      $('composerError').textContent = errorText(error);
    }
  });

  $('composerSave').addEventListener('click', async () => {
    const button = $('composerSave');
    setBusy(button, true);
    $('composerError').textContent = '';
    try {
      await onSave(await exportImage());
      closeModal('avatarModal');
    } catch (error) {
      $('composerError').textContent = errorText(error);
    } finally {
      setBusy(button, false);
    }
  });
}

function buildGradients() {
  const row = $('composerGradients');
  row.replaceChildren();
  for (const [name, from, to, angle] of BG_GRADIENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'colour-swatch gradient-swatch';
    b.dataset.gradient = name;
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', t(`avatar.gradient-${name}`));
    b.title = t(`avatar.gradient-${name}`);
    // A preview of the person's background, set through the CSSOM.
    b.style.setProperty('background', `linear-gradient(${angle}deg, ${from}, ${to})`);
    row.appendChild(b);
  }
}

function buildSwatches() {
  const row = $('composerColours');
  const custom = $('composerCustomToggle');
  row.querySelectorAll('[data-colour]').forEach((b) => b.remove());
  for (const [name, hex] of BG_COLOURS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'colour-swatch';
    b.dataset.colour = hex;
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', t(`avatar.colour-${name}`));
    b.title = t(`avatar.colour-${name}`);
    b.style.setProperty('--swatch-color', hex);
    row.insertBefore(b, custom);
  }
}

// --- export ----------------------------------------------------------------

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Drawing through a canvas drops the file's metadata, including any GPS
// location. WebP keeps transparency; a browser that cannot write WebP sends
// PNG when the background is see-through, JPEG otherwise, and the server
// turns either into WebP.
async function exportImage() {
  const canvas = document.createElement('canvas');
  canvas.width = OUT;
  canvas.height = OUT;
  draw(canvas.getContext('2d'), OUT);
  const transparent = state.removed && (state.bg === 'none' || (state.bg === 'image' && !state.bgImage));
  let blob = await canvasToBlob(canvas, 'image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') {
    blob = transparent ? await canvasToBlob(canvas, 'image/png') : await canvasToBlob(canvas, 'image/jpeg', 0.88);
  }
  if (!blob) throw fail('avatar_invalid');
  return blobToDataUrl(blob);
}

// --- entry -----------------------------------------------------------------

let wired = false;

// Open the editor for a chosen file. save(dataUrl) uploads the result.
export async function editAvatar(file, save) {
  const source = await loadBitmap(file);
  state?.source?.close?.();
  state = {
    source,
    w: source.width,
    h: source.height,
    cutout: null,
    subject: null,
    removed: false,
    bg: 'none',
    colour: BG_COLOURS[0][1],
    gradient: { from: BG_GRADIENTS[0][1], to: BG_GRADIENTS[0][2], angle: BG_GRADIENTS[0][3] },
    stop: 'from',
    bgImage: null,
    base: 1,
    view: { cx: 0, cy: 0, scale: 1 },
  };
  onSave = save;
  if (!wired) {
    wire();
    wired = true;
  }
  buildSwatches();
  buildGradients();
  status('');
  $('composerError').textContent = '';
  const canvas = $('composerCanvas');
  const px = Math.round(Math.min(320, canvas.clientWidth || 320) * (window.devicePixelRatio || 1));
  canvas.width = px;
  canvas.height = px;
  smartFrame();
  render();
  openModal('avatarModal', { initialFocus: canvas });
}
