// Home: the claim field, which checks the name as it is typed and hands it
// to the sign-up page, and the page's moving parts: the card stack that
// cycles, the insight tiles that count up when they scroll into view, and the
// community quotes, which staff enter and which stay hidden while there are
// none. Everything that moves stands still for prefers-reduced-motion.

import '../app.js';
import { onChange, getLocale } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { el } from '../ui.js';
import { wireSlugCheck, normaliseSlugInput } from '../slug-check.js';

const $ = (id) => document.getElementById(id);
const form = $('claimForm');
const input = $('claimSlug');
wireSlugCheck(input, $('claimStatus'));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const slug = normaliseSlugInput(input.value);
  window.location.href = slug ? `/register?slug=${encodeURIComponent(slug)}` : '/register';
});

const still = window.matchMedia('(prefers-reduced-motion: reduce)');

// --- the card stack -----------------------------------------------------------

// Each card's place in the stack is --pos, 0 at the front. Every few seconds
// the front card goes to the back, while the stack is on screen.
const cards = [...document.querySelectorAll('#cardStack .stack-card')];
let front = 0;
function placeCards() {
  cards.forEach((card, i) => card.style.setProperty('--pos', String((i - front + cards.length) % cards.length)));
}
placeCards();
let stackTimer = null;
const stackSeen = new IntersectionObserver(([entry]) => {
  clearInterval(stackTimer);
  if (!entry.isIntersecting || still.matches) return;
  stackTimer = setInterval(() => {
    front = (front + 1) % cards.length;
    placeCards();
  }, 2400);
});
if (cards.length) stackSeen.observe($('cardStack'));

// --- the insight tiles --------------------------------------------------------

function showCounts(animate) {
  const nf = new Intl.NumberFormat(getLocale());
  for (const node of document.querySelectorAll('#insightTiles .count')) {
    const target = Number(node.dataset.count);
    const suffix = node.dataset.suffix || '';
    if (!animate) {
      node.textContent = `${nf.format(target)}${suffix}`;
      continue;
    }
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 1400);
      const eased = 1 - (1 - k) ** 3;
      node.textContent = `${nf.format(Math.round(target * eased))}${suffix}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

const tiles = $('insightTiles');
let counted = false;
new IntersectionObserver(([entry], observer) => {
  if (!entry.isIntersecting) return;
  tiles.classList.add('in-view');
  counted = true;
  showCounts(!still.matches);
  observer.disconnect();
}, { threshold: 0.35 }).observe(tiles);
onChange(() => { if (counted) showCounts(false); });

// --- loved by the community ---------------------------------------------------

let quotes = [];
function renderQuotes() {
  const row = $('quoteRow');
  row.replaceChildren(...quotes.map((q) => el('li', { class: 'quote-card' }, [
    el('blockquote', { text: q.quote }),
    q.pageSlug
      ? el('a', { class: 'quote-by', href: `/${q.pageSlug}`, text: q.author })
      : el('span', { class: 'quote-by', text: q.author }),
  ])));
  $('lovedSection').hidden = quotes.length === 0;
}

api('/api/public/testimonials')
  .then((data) => {
    quotes = data.testimonials || [];
    renderQuotes();
  })
  .catch(() => {});

