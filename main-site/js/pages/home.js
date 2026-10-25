// Home: the claim field, which checks the name as it is typed and hands it
// to the sign-up page, and the page's moving parts: the card stack that
// cycles, the insight tiles, which show the site's real totals
// (/api/public/insights) and count up when they scroll into view, and the
// community quotes, which staff enter and which stay hidden while there are
// none. Everything that moves stands still for prefers-reduced-motion.

import '../app.js';
import { t, onChange, getLocale } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { el } from '../ui.js';
import { icon } from '../icons.js';
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
//
// Real totals, so they wait for both the numbers and the tiles being on
// screen before counting up. Until then, and if the numbers cannot be had,
// each shows a dash.

// The referring sites that have a logo here; any other gets the globe.
const SITE_ICONS = {
  'instagram.com': 'instagram', 'x.com': 'x', 'twitter.com': 'x', 't.co': 'x', 't.me': 'telegram', 'telegram.org': 'telegram',
  'youtube.com': 'youtube', 'facebook.com': 'facebook', 'tiktok.com': 'tiktok', 'discord.com': 'discord', 'bsky.app': 'bluesky',
  'reddit.com': 'reddit', 'threads.net': 'threads', 'twitch.tv': 'twitch', 'furaffinity.net': 'furaffinity', 'google.com': 'search',
};

let insights = null;
let tilesSeen = false;
let counted = false;

function countTo(node, target, suffix, animate) {
  const nf = new Intl.NumberFormat(getLocale());
  if (!animate) {
    node.textContent = `${nf.format(target)}${suffix}`;
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 1400);
    node.textContent = `${nf.format(Math.round(target * (1 - (1 - k) ** 3)))}${suffix}`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The last 30 days of clicks as a line across the tile, scaled to its peak.
function sparkPath(daily) {
  const values = daily.map((d) => d.clicks);
  const peak = Math.max(...values, 1);
  return values.map((v, i) => `${i ? 'L' : 'M'}${(2 + (i / Math.max(values.length - 1, 1)) * 116).toFixed(1)} ${(64 - (v / peak) * 58).toFixed(1)}`).join(' ');
}

function fillTiles(animate) {
  const d = insights;
  // Whichever of phone, computer or tablet is used most, as a share of every
  // device (unknown ones included in the total, never shown as the winner).
  const devices = Object.values(d.devices).reduce((a, b) => a + b, 0);
  const top = ['mobile', 'desktop', 'tablet'].reduce((best, k) => (d.devices[k] > d.devices[best] ? k : best), 'mobile');
  const share = devices > 0 && d.devices[top] > 0 ? Math.round((d.devices[top] / devices) * 100) : null;
  $('tileSpark').setAttribute('d', sparkPath(d.daily));
  countTo($('tileClicks'), d.clicks, '', animate);
  countTo($('tileVisits'), d.visits, '', animate);
  if (share === null) $('tileDevice').textContent = '–';
  else countTo($('tileDevice'), share, '%', animate);
  $('tileDeviceLabel').textContent = t(`home.tile-device-${top}`);
  $('tileDeviceBar').style.setProperty('--mobile', `${share ?? 0}%`);
  // The top referring site once there is one; the number of live pages until then.
  if (d.referrer) {
    $('tileSourceIcon').innerHTML = icon(SITE_ICONS[d.referrer.key] || 'globe');
    countTo($('tileSource'), d.referrer.share, '%', animate);
    $('tileSourceLabel').textContent = t('home.tile-source', { site: d.referrer.key });
  } else {
    countTo($('tileSource'), d.pages, '', animate);
    $('tileSourceLabel').textContent = t('home.tile-pages', { count: d.pages });
  }
  let place = '';
  if (d.country) {
    try {
      place = new Intl.DisplayNames([getLocale()], { type: 'region' }).of(d.country.key) || '';
    } catch {
      place = '';
    }
  }
  $('tilePlace').textContent = place;
}

function maybeCount() {
  if (!insights || !tilesSeen || counted) return;
  counted = true;
  $('insightTiles').classList.add('in-view');
  fillTiles(!still.matches);
}

new IntersectionObserver(([entry], observer) => {
  if (!entry.isIntersecting) return;
  tilesSeen = true;
  observer.disconnect();
  maybeCount();
}, { threshold: 0.35 }).observe($('insightTiles'));

api('/api/public/insights')
  .then((data) => {
    insights = data;
    maybeCount();
  })
  .catch(() => {});
onChange(() => { if (counted) fillTiles(false); });

// --- questions ----------------------------------------------------------------
//
// One answer open at a time: opening a question closes the one that was open.
// Each slides open and shut, its chevron turning straight away rather than
// when the slide ends; with reduced motion they simply switch.

const faqs = [...document.querySelectorAll('.faq details')];
const sliding = new Map();

function setFaq(details, open) {
  sliding.get(details)?.cancel();
  details.classList.toggle('is-open', open);
  if (still.matches) {
    details.open = open;
    return;
  }
  const from = details.offsetHeight;
  if (open) details.open = true;
  const to = open ? details.scrollHeight : details.querySelector('summary').offsetHeight;
  const slide = details.animate({ height: [`${from}px`, `${to}px`] }, { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  sliding.set(details, slide);
  slide.onfinish = () => {
    sliding.delete(details);
    if (!open) details.open = false;
  };
}

for (const details of faqs) {
  details.querySelector('summary').addEventListener('click', (e) => {
    e.preventDefault();
    const opening = !details.classList.contains('is-open');
    if (opening) for (const other of faqs) if (other !== details && other.classList.contains('is-open')) setFaq(other, false);
    setFaq(details, opening);
  });
}

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

