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
//
// A picture that is already see-through (a cut-out PNG, say) skips removal:
// its own alpha is the mask, and the background choices open straight away.

import { t as translate } from '../assets/i18n/i18n.js';
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

const byId = (id) => document.getElementById(id);
const fail = (code) => Object.assign(new Error(code), { code });

let state = null;

// The swatches, wheel and hex field edit one colour: the solid background,
// or whichever end of the gradient is selected.
function activeColour() {
  if (state.bg === 'gradient') {
    return state.gradient[state.stop];
  }
  return state.colour;
}
function setActiveColour(hex) {
  if (state.bg === 'gradient') {
    state.gradient[state.stop] = hex;
  } else {
    state.colour = hex;
  }
}
let wheel = null;
let onSave = null;
let worker = null;
let jobId = 0;

// --- loading ---------------------------------------------------------------

// The chosen file as a bitmap, the right way up, with its longest side cut
// down to MAX_SOURCE. Refuses anything that is not an image, or over 25 MB.
async function loadBitmap(file) {
  if (!file || !String(file.type).startsWith('image/')) {
    throw fail('avatar_invalid');
  }
  if (file.size > 25 * 1024 * 1024) {
    throw fail('avatar_too_large');
  }
  let bitmap;
  try {
    // from-image applies the camera's rotation before the metadata is lost.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw fail('avatar_invalid');
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= MAX_SOURCE) {
    return bitmap;
  }
  const scale = MAX_SOURCE / longest;
  const small = await createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * scale),
    resizeHeight: Math.round(bitmap.height * scale),
    resizeQuality: 'high',
  });
  // Free the full-size copy, where the browser can.
  if (bitmap.close !== undefined && bitmap.close !== null) {
    bitmap.close();
  }
  return small;
}

// The picture's own alpha at the mask's size, in the model's layout, or null
// when the picture is opaque. A few soft pixels (rounded corners, a faint
// edge) do not count: at least 1% of it has to be clearly see-through.
function alphaMask(source) {
  const canvas = new OffscreenCanvas(MASK, MASK);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, MASK, MASK);
  const { data } = context.getImageData(0, 0, MASK, MASK);
  const mask = new Uint8Array(MASK * MASK);
  let clear = 0;
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = data[index * 4 + 3];
    if (mask[index] < 128) {
      clear += 1;
    }
  }
  if (clear >= mask.length * 0.01) {
    return mask;
  }
  return null;
}

// --- framing ---------------------------------------------------------------

function coverScale(width, height) {
  return OUT / Math.min(width, height);
}

// Where the subject is, from the mask: its box, which picture edges it runs
// into (a subject cut off by the photo has a straight edge there), its centre,
// and the distance from that centre to its farthest visible pixel. Source
// pixels throughout.
function subjectOf(mask, width, height) {
  let minX = MASK;
  let minY = MASK;
  let maxX = -1;
  let maxY = -1;
  for (let maskY = 0; maskY < MASK; maskY += 2) {
    for (let maskX = 0; maskX < MASK; maskX += 2) {
      if (mask[maskY * MASK + maskX] > 96) {
        if (maskX < minX) {
          minX = maskX;
        }
        if (maskX > maxX) {
          maxX = maskX;
        }
        if (maskY < minY) {
          minY = maskY;
        }
        if (maskY > maxY) {
          maxY = maskY;
        }
      }
    }
  }
  if (maxX < 0) {
    return null;
  }
  // From mask pixels to source pixels.
  const scaleX = width / MASK;
  const scaleY = height / MASK;
  const centreX = ((minX + maxX) / 2) * scaleX;
  const centreY = ((minY + maxY) / 2) * scaleY;
  let far = 0;
  for (let maskY = minY; maskY <= maxY; maskY += 2) {
    for (let maskX = minX; maskX <= maxX; maskX += 2) {
      if (mask[maskY * MASK + maskX] > 96) {
        far = Math.max(far, Math.hypot((maskX + 1) * scaleX - centreX, (maskY + 1) * scaleY - centreY));
      }
    }
  }
  // A sample of the subject's pixels, for the portrait framing below, and the
  // middle of its top part (its head, in a head-and-shoulders shot).
  const points = [];
  const headLimit = minY + (maxY - minY) * 0.4;
  let headMin = MASK;
  let headMax = -1;
  for (let maskY = minY; maskY <= maxY; maskY += 4) {
    for (let maskX = minX; maskX <= maxX; maskX += 4) {
      if (mask[maskY * MASK + maskX] > 96) {
        points.push((maskX + 0.5) * scaleX, (maskY + 0.5) * scaleY);
        if (maskY <= headLimit) {
          if (maskX < headMin) {
            headMin = maskX;
          }
          if (maskX > headMax) {
            headMax = maskX;
          }
        }
      }
    }
  }
  // How much of each edge the subject runs along. A subject cut off by the
  // photo covers a long stretch; an ear tip or a wisp of fur that merely
  // reaches an edge covers a few pixels, and is not a cut.
  // indexAt(position, depth) gives the mask index that is `position` along
  // the edge and `depth` pixels in from it.
  const band = 6;
  const along = (indexAt, length) => {
    let hits = 0;
    for (let position = 0; position < length; position += 1) {
      for (let depth = 0; depth < band; depth += 1) {
        if (mask[indexAt(position, depth)] > 96) { hits += 1; break; }
      }
    }
    return hits / length;
  };
  const CUT = 0.08;
  const touches = {
    top: along((position, depth) => depth * MASK + position, MASK) >= CUT,
    bottom: along((position, depth) => (MASK - 1 - depth) * MASK + position, MASK) >= CUT,
    left: along((position, depth) => position * MASK + depth, MASK) >= CUT,
    right: along((position, depth) => position * MASK + (MASK - 1 - depth), MASK) >= CUT,
  };
  // The subject's pixels along each cut edge: where a straight line would
  // show if that edge came inside the circle.
  const edgePoints = { top: [], bottom: [], left: [], right: [] };
  const addEdge = (side, at) => {
    if (!touches[side]) {
      return;
    }
    for (let position = 0; position < MASK; position += 2) {
      const [edgeX, edgeY] = at(position);
      if (mask[edgeY * MASK + edgeX] > 96) {
        edgePoints[side].push((edgeX + 0.5) * scaleX, (edgeY + 0.5) * scaleY);
      }
    }
  };
  addEdge('top', (position) => [position, 0]);
  addEdge('bottom', (position) => [position, MASK - 1]);
  addEdge('left', (position) => [0, position]);
  addEdge('right', (position) => [MASK - 1, position]);
  // The middle of the head, or the subject's centre when there is no head
  // part to measure.
  let headX;
  if (headMax >= 0) {
    headX = ((headMin + headMax) / 2) * scaleX;
  } else {
    headX = centreX;
  }
  return {
    cx: centreX,
    cy: centreY,
    headX,
    points,
    radius: Math.max(far, 1),
    top: minY * scaleY,
    bottom: (maxY + 2) * scaleY,
    touches,
    edgePoints,
  };
}

// The automatic framing, which Reset framing goes back to. A whole cut-out
// sits inside the circle with a margin; a cut-out the photo cut off hides
// its cut edges outside the circle; a photo fills the square.
function smartFrame() {
  const width = state.w;
  const height = state.h;
  const subject = state.subject;
  // Whether the photo cut the subject off along any edge.
  let cut = false;
  if (subject && (subject.touches.top || subject.touches.bottom || subject.touches.left || subject.touches.right)) {
    cut = true;
  }
  if (state.removed && subject && !cut) {
    // A whole subject: every part inside the circle, with a margin.
    state.base = ((OUT / 2) * FIT) / subject.radius;
    state.view = { cx: subject.cx, cy: subject.cy, scale: state.base };
  } else if (state.removed && subject) {
    // A subject the photo cuts off has straight edges where it was cut. Only
    // the circle is ever seen, so those edges just have to land outside it.
    // A head-and-shoulders shot (cut at the bottom) is pinned with that cut
    // at the circle's bottom and centred on the head; any other cut is
    // centred on the subject.
    let portrait = false;
    if (subject.touches.bottom && !subject.touches.top) {
      portrait = true;
    }
    let centre;
    if (portrait) {
      centre = subject.headX;
    } else {
      centre = subject.cx;
    }
    // The view's vertical centre at a given zoom.
    let centreYAt;
    if (portrait) {
      centreYAt = (scale) => subject.bottom - OUT / (2 * scale);
    } else {
      centreYAt = () => subject.cy;
    }
    // Nudging the centre sideways often lets the subject fit and the cuts
    // stay hidden at once. Try a few positions around the head; keep the
    // largest zoom that meets both, or the best effort if none does.
    const step = (subject.radius * 0.08);
    let best = null;
    for (const offset of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
      const centreX = Math.min(Math.max(centre + offset * step, 0), width);
      const result = frameScale(subject, centreX, centreYAt, portrait);
      // Meeting both rules beats not; among those, the largest zoom. When
      // none meets both, each result is the least zoom that hides the cuts,
      // so the smallest one is the least crop.
      if (!best
        || (result.both && !best.both)
        || (result.both && best.both && result.scale > best.scale)
        || (!result.both && !best.both && result.scale < best.scale)) {
        best = { ...result, cx: centreX };
      }
    }
    state.base = best.scale;
    state.view = { cx: best.cx, cy: centreYAt(best.scale), scale: best.scale };
  } else {
    state.base = coverScale(width, height);
    state.view = { cx: width / 2, cy: height / 2, scale: state.base };
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
function frameScale(subject, centreX, centreYAt, portrait) {
  // The circle's centre on the stored picture, which is also its radius.
  const middle = OUT / 2;
  const allowedRadius = middle * FIT;
  const project = (pointX, pointY, scale) => [middle + (pointX - centreX) * scale, middle + (pointY - centreYAt(scale)) * scale];
  const subjectInside = (scale) => {
    for (let index = 0; index < subject.points.length; index += 2) {
      const [projectedX, projectedY] = project(subject.points[index], subject.points[index + 1], scale);
      if (portrait && projectedY > OUT * 0.75) {
        continue;
      }
      if (Math.hypot(projectedX - middle, projectedY - middle) > allowedRadius) {
        return false;
      }
    }
    return true;
  };
  // A portrait's bottom cut is pinned to the circle's edge already, so its
  // pixels sit on the rim; only the other cut edges are tested.
  let extraSides;
  if (portrait) {
    extraSides = [];
  } else {
    extraSides = ['bottom'];
  }
  const sides = ['top', 'left', 'right'].concat(extraSides);
  const cutsHidden = (scale) => {
    for (const side of sides) {
      const cutPoints = subject.edgePoints[side];
      for (let index = 0; index < cutPoints.length; index += 2) {
        const [projectedX, projectedY] = project(cutPoints[index], cutPoints[index + 1], scale);
        if (Math.hypot(projectedX - middle, projectedY - middle) < middle - 1) {
          return false;
        }
      }
    }
    return true;
  };
  // Bisection for the boundary of a test that holds on one side of it.
  const search = (low, high, holdsAtLow, test) => {
    for (let round = 0; round < 20; round += 1) {
      const midpoint = (low + high) / 2;
      if (test(midpoint) === holdsAtLow) {
        low = midpoint;
      } else {
        high = midpoint;
      }
    }
    if (holdsAtLow) {
      return low;
    }
    return high;
  };

  const top = OUT / Math.max(subject.bottom - subject.top, subject.radius, 1);
  const low = top * 0.2;
  const high = top * 6;
  let largestInside;
  if (subjectInside(high)) {
    largestInside = high;
  } else if (subjectInside(low)) {
    largestInside = search(low, high, true, subjectInside);
  } else {
    largestInside = low;
  }
  if (cutsHidden(largestInside)) {
    return { scale: largestInside, both: true };
  }
  // Zooming in pushes the cut edges outwards; find the least that hides them.
  if (!cutsHidden(high)) {
    return { scale: largestInside, both: false };
  }
  return { scale: search(largestInside, high, false, cutsHidden), both: false };
}

// A photo keeps covering the whole square, so no empty corner shows. A
// cut-out has a background behind it and may move more freely, as long as
// its centre stays within the picture.
function clampView() {
  const width = state.w;
  const height = state.h;
  const view = state.view;
  let minScale;
  if (state.removed) {
    minScale = state.base * 0.5;
  } else {
    minScale = coverScale(width, height);
  }
  view.scale = Math.min(Math.max(view.scale, minScale), state.base * 4);
  if (state.removed) {
    view.cx = Math.min(Math.max(view.cx, 0), width);
    view.cy = Math.min(Math.max(view.cy, 0), height);
  } else {
    const half = OUT / 2 / view.scale;
    view.cx = Math.min(Math.max(view.cx, half), width - half);
    view.cy = Math.min(Math.max(view.cy, half), height - half);
  }
}

// --- drawing ---------------------------------------------------------------

function drawCover(context, image, size) {
  const scale = size / Math.min(image.width, image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  context.drawImage(image, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
}

// Draw the picture on a square canvas of the given size: the chosen
// background first (only behind a cut-out), then the picture, moved and
// zoomed by the view.
function draw(context, size) {
  const { view } = state;
  context.clearRect(0, 0, size, size);
  if (state.removed) {
    if (state.bg === 'gradient') {
      // CSS's convention: 0 degrees runs upwards, 90 to the right.
      const radians = (state.gradient.angle * Math.PI) / 180;
      const directionX = Math.sin(radians);
      const directionY = -Math.cos(radians);
      const half = (Math.abs(directionX) + Math.abs(directionY)) * (size / 2);
      const fill = context.createLinearGradient(size / 2 - directionX * half, size / 2 - directionY * half, size / 2 + directionX * half, size / 2 + directionY * half);
      fill.addColorStop(0, state.gradient.from);
      fill.addColorStop(1, state.gradient.to);
      context.fillStyle = fill;
      context.fillRect(0, 0, size, size);
    } else if (state.bg === 'colour') {
      context.fillStyle = state.colour;
      context.fillRect(0, 0, size, size);
    } else if (state.bg === 'image' && state.bgImage) {
      drawCover(context, state.bgImage, size);
    }
  }
  const sizeRatio = size / OUT;
  context.save();
  context.imageSmoothingQuality = 'high';
  context.translate(size / 2, size / 2);
  context.scale(view.scale * sizeRatio, view.scale * sizeRatio);
  context.translate(-view.cx, -view.cy);
  let picture;
  if (state.removed) {
    picture = state.cutout;
  } else {
    picture = state.source;
  }
  context.drawImage(picture, 0, 0);
  context.restore();
}

function render() {
  const canvas = byId('composerCanvas');
  draw(canvas.getContext('2d'), canvas.width);
  byId('composerZoom').value = String(state.view.scale / state.base);
  syncControls();
}

// Bring every control in line with the state: the removal button, the
// background choices, the gradient's ends and angle, the swatches and the
// zoom slider's lower end.
function syncControls() {
  const removeButton = byId('composerRemoveBg');
  removeButton.hidden = state.seeThrough;
  removeButton.setAttribute('aria-pressed', String(state.removed));
  let removeLabel;
  if (state.removed) {
    removeLabel = 'avatar.restore-bg';
  } else {
    removeLabel = 'avatar.remove-bg';
  }
  removeButton.querySelector('span:last-child').textContent = translate(removeLabel);
  byId('composerBg').hidden = !state.removed;
  document.querySelectorAll('#composerBgMode [data-bg]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.bg === state.bg));
  });
  let hideColours = false;
  if (state.bg !== 'colour' && state.bg !== 'gradient') {
    hideColours = true;
  }
  byId('composerColourBlock').hidden = hideColours;
  byId('composerGradientBlock').hidden = state.bg !== 'gradient';
  if (state.bg === 'gradient') {
    const { from, to, angle } = state.gradient;
    document.querySelectorAll('#composerStops [data-stop]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.stop === state.stop));
    });
    byId('stopFrom').style.background = from;
    byId('stopTo').style.background = to;
    byId('gradientAngle').value = String(angle);
    byId('gradientAngleValue').textContent = translate('avatar.gradient-degrees', { angle });
    document.querySelectorAll('#composerGradients [data-gradient]').forEach((button) => {
      const [, presetFrom, presetTo, presetAngle] = BG_GRADIENTS.find(([name]) => name === button.dataset.gradient);
      let matches = false;
      if (presetFrom === from && presetTo === to && presetAngle === angle) {
        matches = true;
      }
      button.setAttribute('aria-pressed', String(matches));
    });
  }
  byId('composerBgImageRow').hidden = state.bg !== 'image';
  document.querySelectorAll('#composerColours [data-colour]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.colour === activeColour()));
  });
  const preset = BG_COLOURS.some(([, hex]) => hex === activeColour());
  byId('composerCustomToggle').setAttribute('aria-pressed', String(!preset));
  let zoomMin;
  if (state.removed) {
    zoomMin = '0.5';
  } else {
    zoomMin = '1';
  }
  byId('composerZoom').min = zoomMin;
}

// --- background removal ----------------------------------------------------

function getWorker() {
  if (!worker) {
    worker = new Worker('/js/bg-removal-worker.js', { type: 'module' });
  }
  return worker;
}

function status(text, busy = false) {
  const element = byId('composerStatus');
  element.replaceChildren();
  if (busy) {
    const wrapper = document.createElement('span');
    wrapper.className = 'delayed';
    wrapper.setAttribute('aria-hidden', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    wrapper.appendChild(spinner);
    element.appendChild(wrapper);
  }
  element.append(text);
}

// Send the source to the worker and wait for its mask, showing the model's
// download and the removal as they go. Each run has its own id, and messages
// for any other run are ignored.
function removeBackground() {
  jobId += 1;
  const id = jobId;
  const removalWorker = getWorker();
  status(translate('avatar.preparing'), true);
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = event.data;
      if (message.id !== id) {
        return;
      }
      if (message.type === 'progress') {
        if (message.stage === 'download') {
          const megabytes = (bytes) => (bytes / 1e6).toFixed(0);
          let text;
          if (message.total) {
            text = translate('avatar.downloading', { loaded: megabytes(message.loaded), total: megabytes(message.total) });
          } else {
            text = translate('avatar.preparing');
          }
          status(text, true);
        } else {
          status(translate('avatar.removing'), true);
        }
      } else {
        removalWorker.removeEventListener('message', onMessage);
        if (message.type === 'done') {
          resolve(message.mask);
        } else {
          reject(Object.assign(new Error(message.message), { code: 'bg_failed' }));
        }
      }
    };
    removalWorker.addEventListener('message', onMessage);
    createImageBitmap(state.source).then((copy) => removalWorker.postMessage({ type: 'remove', id, bitmap: copy }, [copy]));
  });
}

// The source with the mask as its alpha, at the source's own size.
function makeCutout(mask) {
  const width = state.w;
  const height = state.h;
  const maskCanvas = new OffscreenCanvas(MASK, MASK);
  const maskContext = maskCanvas.getContext('2d');
  const maskImage = maskContext.createImageData(MASK, MASK);
  for (let index = 0; index < mask.length; index += 1) {
    maskImage.data[index * 4 + 3] = mask[index];
  }
  maskContext.putImageData(maskImage, 0, 0);
  const cutout = new OffscreenCanvas(width, height);
  const context = cutout.getContext('2d');
  context.drawImage(state.source, 0, 0);
  context.globalCompositeOperation = 'destination-in';
  context.imageSmoothingQuality = 'high';
  context.drawImage(maskCanvas, 0, 0, width, height);
  return cutout;
}

// The Remove background button. On a cut-out it goes back to the photo; on
// a photo it cuts the subject out (the first time only: the cut-out is
// kept) and frames it.
async function toggleRemoval() {
  const button = byId('composerRemoveBg');
  byId('composerError').textContent = '';
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
      let reason = error;
      if (error !== null && error !== undefined) {
        const message = error.message;
        if (message !== null && message !== undefined) {
          reason = message;
        }
      }
      console.warn('[background removal]', reason);
      status('');
      let shown;
      if (error.code) {
        shown = error;
      } else {
        shown = { code: 'bg_failed' };
      }
      byId('composerError').textContent = errorText(shown);
      return;
    } finally {
      setBusy(button, false);
    }
  }
  state.removed = true;
  smartFrame();
  status(translate('avatar.removed-ok'));
  render();
}

// --- interaction -----------------------------------------------------------

// Connect every control in the picture editor. Runs once, the first time the
// editor opens. Dragging, the mouse wheel and the keyboard move and zoom the
// picture on the canvas; then the zoom slider, Reset framing and Remove
// background; the background choices (mode, colour swatches, gradients and
// which end of one is being edited, its angle, the custom colour wheel, and
// a background image file); and Save, which hands the finished picture on.
function wire() {
  const canvas = byId('composerCanvas');
  let drag = null;

  // Dragging moves the picture with the pointer.
  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY, cx: state.view.cx, cy: state.view.cy };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) {
      return;
    }
    const perPixel = OUT / canvas.clientWidth / state.view.scale;
    state.view.cx = drag.cx - (event.clientX - drag.x) * perPixel;
    state.view.cy = drag.cy - (event.clientY - drag.y) * perPixel;
    clampView();
    render();
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  // The wheel zooms in or out one step at a time.
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.deltaY < 0) {
      state.view.scale *= 1.06;
    } else {
      state.view.scale *= 1 / 1.06;
    }
    clampView();
    render();
  }, { passive: false });
  // Arrow keys move the picture; + and - (or = and _) zoom.
  canvas.addEventListener('keydown', (event) => {
    const step = 12 / state.view.scale;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      state.view.cx += moves[event.key][0];
      state.view.cy += moves[event.key][1];
    } else if (event.key === '+' || event.key === '=') {
      state.view.scale *= 1.06;
    } else if (event.key === '-' || event.key === '_') {
      state.view.scale /= 1.06;
    } else {
      return;
    }
    event.preventDefault();
    clampView();
    render();
  });

  byId('composerZoom').addEventListener('input', (event) => {
    state.view.scale = state.base * Number(event.target.value);
    clampView();
    render();
  });
  byId('composerReset').addEventListener('click', () => { smartFrame(); render(); });
  byId('composerRemoveBg').addEventListener('click', toggleRemoval);

  // The background choices. Choosing Image before there is one opens the
  // file picker. A change to the colour being edited also moves the custom
  // wheel, when it is open.
  byId('composerBgMode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-bg]');
    if (!button) {
      return;
    }
    state.bg = button.dataset.bg;
    if (state.bg === 'image' && !state.bgImage) {
      byId('composerBgFile').click();
    }
    render();
  });
  byId('composerColours').addEventListener('click', (event) => {
    const button = event.target.closest('[data-colour]');
    if (!button) {
      return;
    }
    setActiveColour(button.dataset.colour);
    if (!byId('composerCustom').hidden) {
      wheel.set(parseHex(activeColour()), { quiet: true });
    }
    render();
  });
  byId('composerGradients').addEventListener('click', (event) => {
    const button = event.target.closest('[data-gradient]');
    if (!button) {
      return;
    }
    const [, from, to, angle] = BG_GRADIENTS.find(([name]) => name === button.dataset.gradient);
    state.gradient = { from, to, angle };
    if (!byId('composerCustom').hidden) {
      wheel.set(parseHex(activeColour()), { quiet: true });
    }
    render();
  });
  byId('composerStops').addEventListener('click', (event) => {
    const button = event.target.closest('[data-stop]');
    if (!button) {
      return;
    }
    state.stop = button.dataset.stop;
    if (!byId('composerCustom').hidden) {
      wheel.set(parseHex(activeColour()), { quiet: true });
    }
    render();
  });
  byId('gradientAngle').addEventListener('input', (event) => {
    state.gradient.angle = Number(event.target.value);
    render();
  });

  // Custom colour: the wheel and a hex field, from the colorguess game.
  wheel = new ColourWheel(
    { wrap: byId('wheelWrap'), canvas: byId('wheelCanvas'), marker: byId('wheelMarker'), slider: byId('wheelBrightness'), hex: byId('wheelHex'), preview: byId('wheelPreview') },
    (hex) => {
      setActiveColour(hex.toLowerCase());
      render();
    },
    (colourWheel, hex) => translate('avatar.wheel-value', { hex, hue: Math.round(colourWheel.h), sat: Math.round(colourWheel.s * 100), bright: Math.round(colourWheel.v * 100) })
  );
  byId('composerCustomToggle').addEventListener('click', () => {
    const panel = byId('composerCustom');
    const opening = panel.hidden;
    panel.hidden = !opening;
    byId('composerCustomToggle').setAttribute('aria-expanded', String(opening));
    if (opening) {
      // Start the wheel on the colour being edited, or GFTV yellow.
      let colour = parseHex(activeColour());
      if (colour === null || colour === undefined) {
        colour = 0xfedc00;
      }
      wheel.set(colour, { quiet: true });
      wheel.drawnFor = null;
      wheel.draw();
    }
  });
  byId('composerBgFile').addEventListener('change', async (event) => {
    const files = event.target.files;
    let file = files;
    if (files) {
      file = files[0];
    }
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      // Free the previous background image, where the browser can.
      const previousImage = state.bgImage;
      if (previousImage !== null && previousImage !== undefined && previousImage.close !== undefined && previousImage.close !== null) {
        previousImage.close();
      }
      state.bgImage = await loadBitmap(file);
      state.bg = 'image';
      byId('composerError').textContent = '';
      render();
    } catch (error) {
      byId('composerError').textContent = errorText(error);
    }
  });

  byId('composerSave').addEventListener('click', async () => {
    const button = byId('composerSave');
    setBusy(button, true);
    byId('composerError').textContent = '';
    try {
      await onSave(await exportImage());
      closeModal('avatarModal');
    } catch (error) {
      byId('composerError').textContent = errorText(error);
    } finally {
      setBusy(button, false);
    }
  });
}

function buildGradients() {
  const row = byId('composerGradients');
  row.replaceChildren();
  for (const [name, from, to, angle] of BG_GRADIENTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'colour-swatch gradient-swatch';
    button.dataset.gradient = name;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', translate(`avatar.gradient-${name}`));
    button.title = translate(`avatar.gradient-${name}`);
    // A preview of the person's background, set through the CSSOM.
    button.style.setProperty('background', `linear-gradient(${angle}deg, ${from}, ${to})`);
    row.appendChild(button);
  }
}

function buildSwatches() {
  const row = byId('composerColours');
  const custom = byId('composerCustomToggle');
  row.querySelectorAll('[data-colour]').forEach((swatch) => swatch.remove());
  for (const [name, hex] of BG_COLOURS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'colour-swatch';
    button.dataset.colour = hex;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', translate(`avatar.colour-${name}`));
    button.title = translate(`avatar.colour-${name}`);
    button.style.setProperty('--swatch-color', hex);
    row.insertBefore(button, custom);
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
  let transparent = false;
  if (state.removed && (state.bg === 'none' || (state.bg === 'image' && !state.bgImage))) {
    transparent = true;
  }
  let blob = await canvasToBlob(canvas, 'image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') {
    if (transparent) {
      blob = await canvasToBlob(canvas, 'image/png');
    } else {
      blob = await canvasToBlob(canvas, 'image/jpeg', 0.88);
    }
  }
  if (!blob) {
    throw fail('avatar_invalid');
  }
  return blobToDataUrl(blob);
}

// --- entry -----------------------------------------------------------------

let wired = false;

// Open the editor for a chosen file. save(dataUrl) uploads the result.
export async function editAvatar(file, save) {
  const source = await loadBitmap(file);
  // Free the last picture, where the browser can.
  if (state !== null && state !== undefined) {
    const previousSource = state.source;
    if (previousSource !== null && previousSource !== undefined && previousSource.close !== undefined && previousSource.close !== null) {
      previousSource.close();
    }
  }
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
    seeThrough: false,
  };
  const mask = alphaMask(source);
  if (mask) {
    state.seeThrough = true;
    state.cutout = source;
    state.subject = subjectOf(mask, state.w, state.h);
    state.removed = true;
  }
  onSave = save;
  if (!wired) {
    wire();
    wired = true;
  }
  buildSwatches();
  buildGradients();
  let statusText;
  if (state.seeThrough) {
    statusText = translate('avatar.see-through');
  } else {
    statusText = '';
  }
  status(statusText);
  byId('composerError').textContent = '';
  const canvas = byId('composerCanvas');
  // The canvas's backing size: its width on screen (320 until it has one,
  // and at most 320) times the screen's pixel ratio.
  let displayWidth = canvas.clientWidth;
  if (!displayWidth) {
    displayWidth = 320;
  }
  let pixelRatio = window.devicePixelRatio;
  if (!pixelRatio) {
    pixelRatio = 1;
  }
  const pixels = Math.round(Math.min(320, displayWidth) * pixelRatio);
  canvas.width = pixels;
  canvas.height = pixels;
  smartFrame();
  render();
  openModal('avatarModal', { initialFocus: canvas });
}
