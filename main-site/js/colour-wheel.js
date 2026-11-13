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
const KEY_SATURATION = 0.05;

// --- colour maths (from colorguess js/color.js) ---------------------------

function fromChannels(red, green, blue) {
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
  return (clamp(red) << 16) | (clamp(green) << 8) | clamp(blue);
}

export function toHex(colour) {
  return `#${colour.toString(16).padStart(6, '0').toUpperCase()}`;
}

export function parseHex(text) {
  let value = '';
  if (text) {
    value = String(text);
  }
  const match = value.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!match) {
    return null;
  }
  // Three digits stand for six: #F80 is #FF8800.
  let hex;
  if (match[1].length === 3) {
    hex = match[1].replace(/./g, (character) => character + character);
  } else {
    hex = match[1];
  }
  return parseInt(hex, 16);
}

// hue in degrees, saturation and brightness from 0 to 1.
function hsvToColor(hue, saturation, brightness) {
  const channel = (offset) => {
    const position = (offset + hue / 60) % 6;
    return brightness - brightness * saturation * Math.max(0, Math.min(position, 4 - position, 1));
  };
  return fromChannels(channel(5) * 255, channel(3) * 255, channel(1) * 255);
}

function colorToHsv(colour) {
  const [red, green, blue] = [(colour >> 16) & 255, (colour >> 8) & 255, colour & 255].map((channel) => channel / 255);
  const max = Math.max(red, green, blue);
  const chroma = max - Math.min(red, green, blue);
  let hue = 0;
  if (chroma) {
    if (max === red) {
      hue = ((green - blue) / chroma) % 6;
    } else if (max === green) {
      hue = (blue - red) / chroma + 2;
    } else {
      hue = (red - green) / chroma + 4;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }
  let saturation;
  if (max) {
    saturation = chroma / max;
  } else {
    saturation = 0;
  }
  return { h: hue, s: saturation, v: max };
}

// --- the wheel (from colorguess js/wheel.js) ------------------------------

export class ColourWheel {
  // elements: { wrap, canvas, marker, slider, hex, preview }, kept as this.els.
  // onChange(hex) is called with '#RRGGBB' whenever the colour changes.
  // Wires the pointer, the arrow keys, the slider, the hex field and resizing.
  constructor(elements, onChange, describe) {
    this.els = elements;
    this.onChange = onChange;
    this.describe = describe;
    this.h = 0;
    this.s = 0;
    this.v = 1;
    this.drawnFor = null;

    const { wrap, slider, hex } = elements;
    wrap.addEventListener('pointerdown', (event) => {
      wrap.setPointerCapture(event.pointerId);
      this.pointAt(event);
      wrap.focus({ preventScroll: true });
      event.preventDefault();
    });
    wrap.addEventListener('pointermove', (event) => {
      if (wrap.hasPointerCapture(event.pointerId)) {
        this.pointAt(event);
      }
    });
    wrap.addEventListener('keydown', (event) => {
      const turn = { ArrowLeft: KEY_HUE, ArrowRight: -KEY_HUE }[event.key];
      const saturationStep = { ArrowUp: KEY_SATURATION, ArrowDown: -KEY_SATURATION }[event.key];
      if (turn === undefined && saturationStep === undefined) {
        return;
      }
      event.preventDefault();
      if (turn) {
        this.h = (this.h + turn + 360) % 360;
      }
      if (saturationStep) {
        this.s = Math.max(0, Math.min(1, this.s + saturationStep));
      }
      this.changed();
    });
    slider.addEventListener('input', () => {
      this.v = Number(slider.value) / 100;
      this.changed();
    });
    // The hex field moves the wheel only once it holds a whole colour, so
    // typing is never fought; leaving it puts back the current value.
    hex.addEventListener('input', () => {
      const colour = parseHex(hex.value);
      // Invalid only when something is typed and it is not a colour.
      let invalid = false;
      if (colour === null && hex.value.trim() !== '') {
        invalid = true;
      }
      hex.setAttribute('aria-invalid', String(invalid));
      if (colour !== null) {
        this.set(colour, { fromHex: true });
      }
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
  set(colour, { fromHex = false, quiet = false } = {}) {
    const at = colorToHsv(colour);
    this.h = at.h;
    this.s = at.s;
    this.v = at.v;
    this.changed({ fromHex, quiet, exact: colour });
  }

  // The hue and saturation under the pointer: the angle and the distance
  // from the centre, with the wheel's radius as 1.
  pointAt(event) {
    const bounds = this.els.wrap.getBoundingClientRect();
    const radius = bounds.width / 2;
    const horizontal = (event.clientX - bounds.left - radius) / radius;
    const vertical = (bounds.top + radius - event.clientY) / radius;
    this.h = ((Math.atan2(vertical, horizontal) * 180) / Math.PI + 360) % 360;
    this.s = Math.min(1, Math.hypot(horizontal, vertical));
    this.changed();
  }

  place(element, hue, saturation) {
    const angle = (hue * Math.PI) / 180;
    element.style.left = `${50 + 50 * saturation * Math.cos(angle)}%`;
    element.style.top = `${50 - 50 * saturation * Math.sin(angle)}%`;
  }

  changed({ fromHex = false, quiet = false, exact = null } = {}) {
    const { slider, marker, preview, wrap, hex } = this.els;
    // A colour typed or chosen exactly keeps its exact value, rather than the
    // nearest one the HSV round trip lands on.
    let colour = exact;
    if (colour === null || colour === undefined) {
      colour = this.color;
    }
    const text = toHex(colour);
    slider.value = String(Math.round(this.v * 100));
    this.place(marker, this.h, this.s);
    marker.style.background = text;
    preview.style.background = text;
    if (!fromHex) {
      hex.value = text;
    }
    let valueText;
    if (this.describe) {
      valueText = this.describe(this, text);
    } else {
      valueText = text;
    }
    wrap.setAttribute('aria-valuetext', valueText);
    this.draw();
    if (!quiet && this.onChange !== null && this.onChange !== undefined) {
      this.onChange(text);
    }
  }

  // Paints the wheel pixel by pixel at the current brightness: the angle
  // from the centre is the hue and the distance is the saturation.
  // Redrawn only when the brightness or the size changes.
  draw() {
    const { canvas } = this.els;
    let pixelRatio = window.devicePixelRatio;
    if (!pixelRatio) {
      pixelRatio = 1;
    }
    const size = Math.round(canvas.clientWidth * pixelRatio);
    if (!size) {
      return;
    }
    const key = `${size}|${this.v.toFixed(2)}`;
    if (this.drawnFor === key) {
      return;
    }
    this.drawnFor = key;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const image = context.createImageData(size, size);
    const radius = size / 2;
    for (let pixelY = 0; pixelY < size; pixelY += 1) {
      for (let pixelX = 0; pixelX < size; pixelX += 1) {
        const horizontal = (pixelX + 0.5 - radius) / radius;
        const vertical = (radius - pixelY - 0.5) / radius;
        const distance = Math.hypot(horizontal, vertical);
        // A pixel's worth of soft edge, so the rim is not jagged.
        const alpha = Math.max(0, Math.min(1, (1 - distance) * radius));
        if (!alpha) {
          continue;
        }
        const colour = hsvToColor(((Math.atan2(vertical, horizontal) * 180) / Math.PI + 360) % 360, Math.min(1, distance), this.v);
        const offset = (pixelY * size + pixelX) * 4;
        image.data[offset] = (colour >> 16) & 255;
        image.data[offset + 1] = (colour >> 8) & 255;
        image.data[offset + 2] = colour & 255;
        image.data[offset + 3] = Math.round(alpha * 255);
      }
    }
    context.putImageData(image, 0, 0);
  }
}
