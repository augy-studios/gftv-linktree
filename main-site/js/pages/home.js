// Home: the claim field, which checks the name as it is typed and hands it
// to the sign-up page, and the page's moving parts: the card stack that
// cycles, the insight tiles, which show the site's real totals
// (/api/public/insights) and count up when they scroll into view, and the
// community quotes, which staff enter and which stay hidden while there are
// none. Everything that moves stands still for prefers-reduced-motion.

import '../app.js';
import { t as translate, onChange, getLocale } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { createElement } from '../ui.js';
import { icon } from '../icons.js';
import { wireSlugCheck, normaliseSlugInput } from '../slug-check.js';

const byId = (id) => document.getElementById(id);
const form = byId('claimForm');
const input = byId('claimSlug');
wireSlugCheck(input, byId('claimStatus'));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const slug = normaliseSlugInput(input.value);
  if (slug) {
    window.location.href = `/register?slug=${encodeURIComponent(slug)}`;
  } else {
    window.location.href = '/register';
  }
});

const still = window.matchMedia('(prefers-reduced-motion: reduce)');

// --- the card stack -----------------------------------------------------------

// Each card's place in the stack is --pos, 0 at the front. Every few seconds
// the front card goes to the back, while the stack is on screen.
const cards = [...document.querySelectorAll('#cardStack .stack-card')];
let front = 0;
function placeCards() {
  cards.forEach((card, index) => card.style.setProperty('--pos', String((index - front + cards.length) % cards.length)));
}
placeCards();
let stackTimer = null;
const stackSeen = new IntersectionObserver(([entry]) => {
  clearInterval(stackTimer);
  if (!entry.isIntersecting || still.matches) {
    return;
  }
  stackTimer = setInterval(() => {
    front = (front + 1) % cards.length;
    placeCards();
  }, 2400);
});
if (cards.length) {
  stackSeen.observe(byId('cardStack'));
}

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
  const numberFormat = new Intl.NumberFormat(getLocale());
  if (!animate) {
    node.textContent = `${numberFormat.format(target)}${suffix}`;
    return;
  }
  const start = performance.now();
  // Eases out over 1.4 seconds: fast at first, slowing into the final number.
  const step = (now) => {
    const progress = Math.min(1, (now - start) / 1400);
    node.textContent = `${numberFormat.format(Math.round(target * (1 - (1 - progress) ** 3)))}${suffix}`;
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

// The last 30 days of clicks as a line across the tile, scaled to its peak.
function sparkPath(daily) {
  const values = daily.map((day) => day.clicks);
  const peak = Math.max(...values, 1);
  return values.map((value, index) => {
    // The first point moves the pen there; every later one draws a line to it.
    let command;
    if (index) {
      command = 'L';
    } else {
      command = 'M';
    }
    return `${command}${(2 + (index / Math.max(values.length - 1, 1)) * 116).toFixed(1)} ${(64 - (value / peak) * 58).toFixed(1)}`;
  }).join(' ');
}

// Fills the tiles from the site's totals: the clicks line and count, visits,
// the most used kind of device, the top referring site (or the number of
// live pages) and the top country. animate counts each number up.
function fillTiles(animate) {
  const totals = insights;
  // Whichever of phone, computer or tablet is used most, as a share of every
  // device (unknown ones included in the total, never shown as the winner).
  const devices = Object.values(totals.devices).reduce((sum, count) => sum + count, 0);
  const top = ['mobile', 'desktop', 'tablet'].reduce((best, kind) => {
    if (totals.devices[kind] > totals.devices[best]) {
      return kind;
    }
    return best;
  }, 'mobile');
  let share = null;
  if (devices > 0 && totals.devices[top] > 0) {
    share = Math.round((totals.devices[top] / devices) * 100);
  }
  byId('tileSpark').setAttribute('d', sparkPath(totals.daily));
  countTo(byId('tileClicks'), totals.clicks, '', animate);
  countTo(byId('tileVisits'), totals.visits, '', animate);
  if (share === null) {
    byId('tileDevice').textContent = '–';
  } else {
    countTo(byId('tileDevice'), share, '%', animate);
  }
  byId('tileDeviceLabel').textContent = translate(`home.tile-device-${top}`);
  let barShare = share;
  if (barShare === null || barShare === undefined) {
    barShare = 0;
  }
  byId('tileDeviceBar').style.setProperty('--mobile', `${barShare}%`);
  // The top referring site once there is one; the number of live pages until then.
  if (totals.referrer) {
    let siteIcon = SITE_ICONS[totals.referrer.key];
    if (!siteIcon) {
      siteIcon = 'globe';
    }
    byId('tileSourceIcon').innerHTML = icon(siteIcon);
    countTo(byId('tileSource'), totals.referrer.share, '%', animate);
    byId('tileSourceLabel').textContent = translate('home.tile-source', { site: totals.referrer.key });
  } else {
    countTo(byId('tileSource'), totals.pages, '', animate);
    byId('tileSourceLabel').textContent = translate('home.tile-pages', { count: totals.pages });
  }
  let place = '';
  if (totals.country) {
    try {
      place = new Intl.DisplayNames([getLocale()], { type: 'region' }).of(totals.country.key);
      if (!place) {
        place = '';
      }
    } catch {
      place = '';
    }
  }
  byId('tilePlace').textContent = place;
}

function maybeCount() {
  if (!insights || !tilesSeen || counted) {
    return;
  }
  counted = true;
  byId('insightTiles').classList.add('in-view');
  fillTiles(!still.matches);
}

new IntersectionObserver(([entry], observer) => {
  if (!entry.isIntersecting) {
    return;
  }
  tilesSeen = true;
  observer.disconnect();
  maybeCount();
}, { threshold: 0.35 }).observe(byId('insightTiles'));

api('/api/public/insights')
  .then((data) => {
    insights = data;
    maybeCount();
  })
  .catch(() => {});
onChange(() => {
  if (counted) {
    fillTiles(false);
  }
});

// --- questions ----------------------------------------------------------------
//
// One answer open at a time: opening a question closes the one that was open.
// Each slides open and shut, its chevron turning straight away rather than
// when the slide ends; with reduced motion they simply switch.

const faqs = [...document.querySelectorAll('.faq details')];
const sliding = new Map();

// Opens or closes one answer, sliding its height unless motion is reduced.
// A slide still running on it is cancelled first.
function setFaq(details, open) {
  const runningSlide = sliding.get(details);
  if (runningSlide !== null && runningSlide !== undefined) {
    runningSlide.cancel();
  }
  details.classList.toggle('is-open', open);
  if (still.matches) {
    details.open = open;
    return;
  }
  const from = details.offsetHeight;
  if (open) {
    details.open = true;
  }
  let to;
  if (open) {
    to = details.scrollHeight;
  } else {
    to = details.querySelector('summary').offsetHeight;
  }
  const slide = details.animate({ height: [`${from}px`, `${to}px`] }, { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  sliding.set(details, slide);
  // A closing answer stays open until the slide ends, so its text shows while it shuts.
  slide.onfinish = () => {
    sliding.delete(details);
    if (!open) {
      details.open = false;
    }
  };
}

for (const details of faqs) {
  details.querySelector('summary').addEventListener('click', (event) => {
    event.preventDefault();
    const opening = !details.classList.contains('is-open');
    if (opening) {
      for (const other of faqs) {
        if (other !== details && other.classList.contains('is-open')) {
          setFaq(other, false);
        }
      }
    }
    setFaq(details, opening);
  });
}

// --- loved by the community ---------------------------------------------------

let quotes = [];
function renderQuotes() {
  const row = byId('quoteRow');
  row.replaceChildren(...quotes.map((testimonial) => {
    const quote = createElement('blockquote', { text: testimonial.quote });
    // The author links to their page when they have one.
    let byline;
    if (testimonial.pageSlug) {
      byline = createElement('a', { class: 'quote-by', href: `/${testimonial.pageSlug}`, text: testimonial.author });
    } else {
      byline = createElement('span', { class: 'quote-by', text: testimonial.author });
    }
    return createElement('li', { class: 'quote-card' }, [quote, byline]);
  }));
  byId('lovedSection').hidden = quotes.length === 0;
}

api('/api/public/testimonials')
  .then((data) => {
    quotes = data.testimonials;
    if (!quotes) {
      quotes = [];
    }
    renderQuotes();
  })
  .catch(() => {});

