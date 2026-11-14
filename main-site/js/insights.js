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
import { createElement } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attributes = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
};

// 1, 2 or 5 times a power of ten, at least max: an axis top a person can read.
function niceMax(max) {
  if (max <= 4) {
    return 4;
  }
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= max) {
      return step * power;
    }
  }
  return 10 * power;
}

// A column with rounded top corners, square at the baseline.
function columnPath(left, top, width, height, radius) {
  const cornerRadius = Math.min(radius, width / 2, height);
  return `M${left},${top + height}V${top + cornerRadius}Q${left},${top} ${left + cornerRadius},${top}H${left + width - cornerRadius}Q${left + width},${top} ${left + width},${top + cornerRadius}V${top + height}Z`;
}

export function dayLabel(day, options = { day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat(getLocale(), { ...options, timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
}

// container: an empty, position: relative element. points: [{ day, value }].
// describe(point) -> the tooltip text for one column.
// Draws the SVG chart (grid, ticks, columns, hit areas), its tooltip, and the
// hidden table, and wires pointer and keyboard to the tooltip.
export function drawColumns(container, points, { label, describe, caption }) {
  container.replaceChildren();
  // An element not laid out yet has no width: draw at 600 then.
  let availableWidth = container.clientWidth;
  if (!availableWidth) {
    availableWidth = 600;
  }
  const width = Math.max(availableWidth, 240);
  const height = 200;
  const padding = { top: 12, right: 4, bottom: 24, left: 36 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const top = niceMax(Math.max(0, ...points.map((point) => point.value)));
  const slot = plotWidth / points.length;
  const barWidth = Math.max(2, Math.min(24, slot - 2));
  const yForValue = (value) => padding.top + plotHeight - (value / top) * plotHeight;
  const numberFormat = new Intl.NumberFormat(getLocale());

  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'columns', role: 'img', 'aria-label': label, tabindex: 0 });
  for (const value of [0, top / 2, top]) {
    let lineClass;
    if (value === 0) {
      lineClass = 'axis';
    } else {
      lineClass = 'grid';
    }
    chart.append(svg('line', { x1: padding.left, x2: width - padding.right, y1: yForValue(value), y2: yForValue(value), class: lineClass }));
    const text = svg('text', { x: padding.left - 6, y: yForValue(value) + 4, 'text-anchor': 'end', class: 'tick' });
    text.textContent = numberFormat.format(value);
    chart.append(text);
  }
  // Day labels under the first, middle and last columns only.
  const ticks = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  const columns = points.map((point, index) => {
    const barLeft = padding.left + index * slot + (slot - barWidth) / 2;
    if (ticks.has(index)) {
      const text = svg('text', { x: barLeft + barWidth / 2, y: height - 6, 'text-anchor': 'middle', class: 'tick' });
      text.textContent = dayLabel(point.day);
      chart.append(text);
    }
    const barHeight = (point.value / top) * plotHeight;
    let bar;
    if (point.value > 0) {
      bar = svg('path', { d: columnPath(barLeft, yForValue(point.value), barWidth, barHeight, 4), class: 'bar' });
    } else {
      bar = null;
    }
    if (bar) {
      chart.append(bar);
    }
    return { x: padding.left + index * slot, bar, point };
  });

  // Hit areas the full height of each slot, wider than the column itself.
  const tip = createElement('div', { class: 'chart-tip', role: 'status', hidden: true });
  let active = -1;
  // Show the tooltip for one column, or hide it with -1. A day at zero has
  // no bar to light up, only the tooltip.
  const show = (index) => {
    if (active >= 0 && columns[active].bar) {
      columns[active].bar.classList.remove('on');
    }
    active = index;
    if (index < 0) {
      tip.hidden = true;
      return;
    }
    const column = columns[index];
    if (column.bar) {
      column.bar.classList.add('on');
    }
    tip.textContent = describe(column.point);
    tip.hidden = false;
    const left = Math.min(Math.max(column.x + slot / 2, 60), width - 60);
    tip.style.setProperty('--x', `${left}px`);
  };
  columns.forEach((column, index) => {
    const hit = svg('rect', { x: column.x, y: padding.top, width: slot, height: plotHeight, class: 'hit' });
    hit.addEventListener('pointerenter', () => show(index));
    chart.append(hit);
  });
  chart.addEventListener('pointerleave', () => show(-1));
  // Focus returns to the column last shown, or starts at the latest day.
  chart.addEventListener('focus', () => {
    if (active >= 0) {
      show(active);
    } else {
      show(columns.length - 1);
    }
  });
  chart.addEventListener('blur', () => show(-1));
  chart.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step) {
      event.preventDefault();
      show(Math.min(Math.max(active + step, 0), columns.length - 1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (event.key === 'Home') {
        show(0);
      } else {
        show(columns.length - 1);
      }
    }
  });

  const table = createElement('table', { class: 'visually-hidden' }, [
    createElement('caption', { text: caption }),
    createElement('tbody', {}, points.map((point) => createElement('tr', {}, [createElement('th', { scope: 'row', text: dayLabel(point.day, { dateStyle: 'medium' }) }), createElement('td', { text: numberFormat.format(point.value) })]))),
  ]);
  container.append(chart, tip, table);
}

// A ranked list with a bar under each row, its length the share of the
// largest. rows: [{ label, value }].
export function fillBarList(list, rows, emptyText) {
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(createElement('li', { class: 'empty-state', text: emptyText }));
    return;
  }
  const max = Math.max(...rows.map((row) => row.value), 1);
  const numberFormat = new Intl.NumberFormat(getLocale());
  for (const row of rows) {
    const bar = createElement('span', { class: 'bar', 'aria-hidden': 'true' });
    bar.style.setProperty('--share', `${Math.max(2, (row.value / max) * 100)}%`);
    list.append(createElement('li', {}, [createElement('span', { class: 'label', text: row.label }), createElement('span', { class: 'value', text: numberFormat.format(row.value) }), bar]));
  }
}
