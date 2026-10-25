// A hue and saturation wheel with a brightness slider, so any colour can be
// picked, plus a hex field that stays in step with it. Ported from the
// colorguess game's js/wheel.js and js/color.js.
//
// Drag or tap the wheel, or focus it and use the arrow keys: left and right
// turn the hue, up and down change the saturation. Typing a full #RRGGBB in
// the hex field moves the wheel to it.
//
// The wheel shows colours for what they are, so like the background swatches
// it is a fixed-meaning exception to the theme's tokens. The brightness track
// is a plain slider rather than a gradient, per the theme's rules; the
// preview swatch beside it shows the result.

const KEY_HUE = 5;
const KEY_SAT = 0.05;

// --- colour maths (from colorguess js/color.js) ---------------------------

function fromChannels(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

export function toHex(n) {
  return `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
}

export function parseHex(text) {
  const m = String(text || '').trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return parseInt(hex, 16);
}

// h in degrees, s and v from 0 to 1.
function hsvToColor(h, s, v) {
  const f = (k) => {
    const x = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  return fromChannels(f(5) * 255, f(3) * 255, f(1) * 255);
}

function colorToHsv(n) {
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

// --- the wheel (from colorguess js/wheel.js) ------------------------------

export class ColourWheel {
  // els: { wrap, canvas, marker, slider, hex, preview }
  // onChange(hex) is called with '#RRGGBB' whenever the colour changes.
  constructor(els, onChange, describe) {
    this.els = els;
    this.onChange = onChange;
    this.describe = describe;
    this.h = 0;
    this.s = 0;
    this.v = 1;
    this.drawnFor = null;

    const { wrap, slider, hex } = els;
    wrap.addEventListener('pointerdown', (e) => {
      wrap.setPointerCapture(e.pointerId);
      this.pointAt(e);
      wrap.focus({ preventScroll: true });
      e.preventDefault();
    });
    wrap.addEventListener('pointermove', (e) => {
      if (wrap.hasPointerCapture(e.pointerId)) this.pointAt(e);
    });
    wrap.addEventListener('keydown', (e) => {
      const turn = { ArrowLeft: KEY_HUE, ArrowRight: -KEY_HUE }[e.key];
      const sat = { ArrowUp: KEY_SAT, ArrowDown: -KEY_SAT }[e.key];
      if (turn === undefined && sat === undefined) return;
      e.preventDefault();
      if (turn) this.h = (this.h + turn + 360) % 360;
      if (sat) this.s = Math.max(0, Math.min(1, this.s + sat));
      this.changed();
    });
    slider.addEventListener('input', () => {
      this.v = Number(slider.value) / 100;
      this.changed();
    });
    // The hex field moves the wheel only once it holds a whole colour, so
    // typing is never fought; leaving it puts back the current value.
    hex.addEventListener('input', () => {
      const n = parseHex(hex.value);
      hex.setAttribute('aria-invalid', String(n === null && hex.value.trim() !== ''));
      if (n !== null) this.set(n, { fromHex: true });
    });
    hex.addEventListener('blur', () => {
      hex.value = toHex(this.color);
      hex.removeAttribute('aria-invalid');
    });
    window.addEventListener('resize', () => {
      this.drawnFor = null;
      this.draw();
    });
  }

  get color() {
    return hsvToColor(this.h, this.s, this.v);
  }

  // Move to a colour from elsewhere: a swatch, or the hex field.
  set(n, { fromHex = false, quiet = false } = {}) {
    const at = colorToHsv(n);
    this.h = at.h;
    this.s = at.s;
    this.v = at.v;
    this.changed({ fromHex, quiet, exact: n });
  }

  pointAt(e) {
    const rect = this.els.wrap.getBoundingClientRect();
    const r = rect.width / 2;
    const x = (e.clientX - rect.left - r) / r;
    const y = (rect.top + r - e.clientY) / r;
    this.h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    this.s = Math.min(1, Math.hypot(x, y));
    this.changed();
  }

  place(el, h, s) {
    const a = (h * Math.PI) / 180;
    el.style.left = `${50 + 50 * s * Math.cos(a)}%`;
    el.style.top = `${50 - 50 * s * Math.sin(a)}%`;
  }

  changed({ fromHex = false, quiet = false, exact = null } = {}) {
    const { slider, marker, preview, wrap, hex } = this.els;
    // A colour typed or chosen exactly keeps its exact value, rather than the
    // nearest one the HSV round trip lands on.
    const colour = exact ?? this.color;
    const text = toHex(colour);
    slider.value = String(Math.round(this.v * 100));
    this.place(marker, this.h, this.s);
    marker.style.background = text;
    preview.style.background = text;
    if (!fromHex) hex.value = text;
    wrap.setAttribute('aria-valuetext', this.describe ? this.describe(this, text) : text);
    this.draw();
    if (!quiet) this.onChange?.(text);
  }

  // Redrawn only when the brightness or the size changes.
  draw() {
    const { canvas } = this.els;
    const size = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1));
    if (!size) return;
    const key = `${size}|${this.v.toFixed(2)}`;
    if (this.drawnFor === key) return;
    this.drawnFor = key;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const r = size / 2;
    for (let py = 0; py < size; py += 1) {
      for (let px = 0; px < size; px += 1) {
        const x = (px + 0.5 - r) / r;
        const y = (r - py - 0.5) / r;
        const d = Math.hypot(x, y);
        // A pixel's worth of soft edge, so the rim is not jagged.
        const alpha = Math.max(0, Math.min(1, (1 - d) * r));
        if (!alpha) continue;
        const c = hsvToColor(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, Math.min(1, d), this.v);
        const i = (py * size + px) * 4;
        img.data[i] = (c >> 16) & 255;
        img.data[i + 1] = (c >> 8) & 255;
        img.data[i + 2] = c & 255;
        img.data[i + 3] = Math.round(alpha * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}
