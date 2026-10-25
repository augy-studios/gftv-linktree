// Drawing the editor's insights: a daily column chart and ranked bar lists.
//
// One series at a time on one axis (visits or clicks, never both, so there
// is no second scale and no colour key to learn). Columns are thin with
// rounded tops on a recessive grid; every column has a tooltip, by pointer
// and by arrow keys once the chart has focus, and the same numbers are in a
// visually hidden table for screen readers. All colour comes from theme
// tokens in style.css, so the chart follows the light, dark and colour
// themes like the rest of the page.

import { getLocale } from '../assets/i18n/i18n.js';
import { el } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

// 1, 2 or 5 times a power of ten, at least max: an axis top a person can read.
function niceMax(max) {
  if (max <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

// A column with rounded top corners, square at the baseline.
function columnPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function dayLabel(day, opts = { day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat(getLocale(), { ...opts, timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
}

// container: an empty, position: relative element. points: [{ day, value }].
// describe(point) -> the tooltip text for one column.
export function drawColumns(container, points, { label, describe, caption }) {
  container.replaceChildren();
  const width = Math.max(container.clientWidth || 600, 240);
  const height = 200;
  const pad = { top: 12, right: 4, bottom: 24, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const top = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const slot = plotW / points.length;
  const barW = Math.max(2, Math.min(24, slot - 2));
  const yOf = (v) => pad.top + plotH - (v / top) * plotH;
  const nf = new Intl.NumberFormat(getLocale());

  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'columns', role: 'img', 'aria-label': label, tabindex: 0 });
  for (const v of [0, top / 2, top]) {
    chart.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: yOf(v), y2: yOf(v), class: v === 0 ? 'axis' : 'grid' }));
    const text = svg('text', { x: pad.left - 6, y: yOf(v) + 4, 'text-anchor': 'end', class: 'tick' });
    text.textContent = nf.format(v);
    chart.append(text);
  }
  const ticks = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  const columns = points.map((p, i) => {
    const x = pad.left + i * slot + (slot - barW) / 2;
    if (ticks.has(i)) {
      const text = svg('text', { x: x + barW / 2, y: height - 6, 'text-anchor': 'middle', class: 'tick' });
      text.textContent = dayLabel(p.day);
      chart.append(text);
    }
    const h = (p.value / top) * plotH;
    const bar = p.value > 0 ? svg('path', { d: columnPath(x, yOf(p.value), barW, h, 4), class: 'bar' }) : null;
    if (bar) chart.append(bar);
    return { x: pad.left + i * slot, bar, point: p };
  });

  // Hit areas the full height of each slot, wider than the column itself.
  const tip = el('div', { class: 'chart-tip', role: 'status', hidden: true });
  let active = -1;
  const show = (i) => {
    if (active >= 0) columns[active].bar?.classList.remove('on');
    active = i;
    if (i < 0) {
      tip.hidden = true;
      return;
    }
    const c = columns[i];
    c.bar?.classList.add('on');
    tip.textContent = describe(c.point);
    tip.hidden = false;
    const left = Math.min(Math.max(c.x + slot / 2, 60), width - 60);
    tip.style.setProperty('--x', `${left}px`);
  };
  columns.forEach((c, i) => {
    const hit = svg('rect', { x: c.x, y: pad.top, width: slot, height: plotH, class: 'hit' });
    hit.addEventListener('pointerenter', () => show(i));
    chart.append(hit);
  });
  chart.addEventListener('pointerleave', () => show(-1));
  chart.addEventListener('focus', () => show(active >= 0 ? active : columns.length - 1));
  chart.addEventListener('blur', () => show(-1));
  chart.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step) {
      e.preventDefault();
      show(Math.min(Math.max(active + step, 0), columns.length - 1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : columns.length - 1);
    }
  });

  const table = el('table', { class: 'visually-hidden' }, [
    el('caption', { text: caption }),
    el('tbody', {}, points.map((p) => el('tr', {}, [el('th', { scope: 'row', text: dayLabel(p.day, { dateStyle: 'medium' }) }), el('td', { text: nf.format(p.value) })]))),
  ]);
  container.append(chart, tip, table);
}

// A ranked list with a bar under each row, its length the share of the
// largest. rows: [{ label, value }].
export function fillBarList(list, rows, emptyText) {
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(el('li', { class: 'empty-state', text: emptyText }));
    return;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  const nf = new Intl.NumberFormat(getLocale());
  for (const row of rows) {
    const bar = el('span', { class: 'bar', 'aria-hidden': 'true' });
    bar.style.setProperty('--share', `${Math.max(2, (row.value / max) * 100)}%`);
    list.append(el('li', {}, [el('span', { class: 'label', text: row.label }), el('span', { class: 'value', text: nf.format(row.value) }), bar]));
  }
}
