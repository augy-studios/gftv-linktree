// Domain blocklists for links, from HaGeZi (github.com/hagezi/dns-blocklists)
// by default, in their wildcard form, where each entry also covers every
// subdomain of it. Each list belongs to a category, and the category is what
// an owner is told when a link is refused:
//
//   unsafe     tif (Threat Intelligence Feeds: malware, phishing, scams,
//              command-and-control; about two million domains), fake (fake
//              shops), popupads (pop-up advertising), hoster (badware hosting)
//   gambling   gambling (about 600,000 domains)
//   shortener  urlshortener (link shorteners, alongside validate.js's own list)
//   adult      nsfw (OneLink is for all ages)
//   piracy     anti.piracy (sites mainly used to share copyrighted work
//              without permission)
//
// Two million domains are 40 MB of text (300 MB as strings in memory), far too
// much to fetch or hold per request, so each category is kept as an index:
//
//   rebuildDomainBlocklist()  downloads the lists once, hashes each domain to
//                             8 bytes (the start of its SHA-256), sorts them
//                             and stores one file per category in the private
//                             gftvonelink_lists bucket (migration 005), about
//                             23 MB in all, with a JSON file describing them.
//                             The daily cron does this every
//                             DOMAIN_BLOCKLIST_REFRESH_DAYS (14 by default);
//                             staff can also ask for it.
//   blocklistCategory(host)   loads the indexes once per instance and binary
//                             searches them for the host and each parent.
//
// Two different domains sharing a fingerprint is about a one in ten trillion
// chance per lookup. While there is no index yet, or it cannot be read,
// addresses are let through and that is logged: the staff lists and Safe
// Browsing still apply, and the cron checks every live link again.
//
// DOMAIN_BLOCKLISTS replaces the lists: "category:address" pairs separated by
// commas (one domain, or *.domain, per line; # starts a comment), or "off".

import { createHash } from 'node:crypto';
import { db } from './supabase.js';
import { optionalEnv } from './env.js';

const HAGEZI = (name) => `https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/${name}.txt`;
const DEFAULT_LISTS = [
  ['unsafe', 'tif'], ['unsafe', 'fake'], ['unsafe', 'popupads'], ['unsafe', 'hoster'],
  ['gambling', 'gambling'],
  ['shortener', 'urlshortener'],
  ['adult', 'nsfw'],
  ['piracy', 'anti.piracy'],
].map(([category, name]) => ({ category, url: HAGEZI(name) }));

// The order lookups go in: a domain on two lists is reported as the first.
export const CATEGORIES = ['unsafe', 'gambling', 'adult', 'piracy', 'shortener'];

export const LIST_BUCKET = 'gftvonelink_lists';
const META_FILE = 'domain-blocklist.json';
const indexFile = (category) => `domain-blocklist-${category}.bin`;
const RECHECK_MS = 6 * 3600_000; // how often an instance looks for a newer build
const RETRY_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// [{ category, url }]
export function domainBlocklists() {
  const value = optionalEnv('DOMAIN_BLOCKLISTS');
  if (value === 'off') return [];
  if (!value) return DEFAULT_LISTS;
  return value
    .split(',')
    .map((entry) => entry.trim().match(/^([a-z]+):(https?:\/\/\S+)$/))
    .filter((m) => m && CATEGORIES.includes(m[1]))
    .map((m) => ({ category: m[1], url: m[2] }));
}

export function refreshDays() {
  const days = Number(optionalEnv('DOMAIN_BLOCKLIST_REFRESH_DAYS', '14'));
  return Number.isFinite(days) && days >= 1 ? days : 14;
}

function fingerprint(domain) {
  return createHash('sha256').update(domain).digest().readBigUInt64BE(0);
}

const signature = (lists) => lists.map((l) => `${l.category}:${l.url}`).join(',');

// ---------------------------------------------------------------------------
// Building the indexes
// ---------------------------------------------------------------------------

async function readMeta() {
  const { data, error } = await db().storage.from(LIST_BUCKET).download(META_FILE);
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text());
  } catch {
    return null;
  }
}

// Every domain in the given lists, fingerprinted, sorted and without repeats.
async function buildIndex(urls) {
  // A typed array that doubles as it fills: 8 bytes a domain, rather than a
  // JavaScript number object each.
  let hashes = new BigUint64Array(1 << 16);
  let count = 0;
  for (const url of urls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`blocklist ${url}: HTTP ${response.status}`);
    const text = await response.text();
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      let line = text.slice(start, end).trim().toLowerCase();
      start = end + 1;
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      if (line.startsWith('*.')) line = line.slice(2);
      if (!line.includes('.')) continue;
      if (count === hashes.length) {
        const bigger = new BigUint64Array(hashes.length * 2);
        bigger.set(hashes);
        hashes = bigger;
      }
      hashes[count++] = fingerprint(line);
    }
  }
  const sorted = hashes.subarray(0, count).sort();
  let unique = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i === 0 || sorted[i] !== sorted[unique - 1]) sorted[unique++] = sorted[i];
  }
  return sorted.subarray(0, unique);
}

// { built: true, categories, builtAt } after a rebuild, { built: false, meta }
// when the stored build is recent enough and force is not set, or
// { off: true } when no lists are in use.
export async function rebuildDomainBlocklist({ force = false } = {}) {
  const lists = domainBlocklists();
  if (lists.length === 0) return { built: false, off: true };
  const meta = await readMeta();
  const fresh = meta && meta.signature === signature(lists) && Date.now() - Date.parse(meta.builtAt) < refreshDays() * 86400_000;
  if (fresh && !force) return { built: false, meta };

  const bucket = db().storage.from(LIST_BUCKET);
  const categories = {};
  for (const category of CATEGORIES) {
    const urls = lists.filter((l) => l.category === category).map((l) => l.url);
    if (urls.length === 0) continue;
    const index = await buildIndex(urls);
    const body = Buffer.from(index.buffer, index.byteOffset, index.byteLength);
    const { error } = await bucket.upload(indexFile(category), body, { contentType: 'application/octet-stream', upsert: true });
    if (error) throw new Error(`blocklist upload ${category}: ${error.message}`);
    categories[category] = index.length;
  }
  const next = { signature: signature(lists), lists, categories, builtAt: new Date().toISOString() };
  const { error } = await bucket.upload(META_FILE, Buffer.from(JSON.stringify(next)), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`blocklist meta upload: ${error.message}`);
  forgetDomainBlocklist();
  return { built: true, categories, builtAt: next.builtAt };
}

// For the admin dashboard.
export async function domainBlocklistInfo() {
  if (domainBlocklists().length === 0) return { off: true };
  const meta = await readMeta();
  return { off: false, categories: meta?.categories ?? {}, builtAt: meta?.builtAt ?? null, refreshDays: refreshDays() };
}

// ---------------------------------------------------------------------------
// Looking a host up
// ---------------------------------------------------------------------------

let cache = { at: 0, indexes: null, builtAt: null, loading: null };

async function load() {
  const meta = await readMeta();
  if (!meta) throw new Error('no index built yet');
  if (cache.indexes && cache.builtAt === meta.builtAt) return { indexes: cache.indexes, builtAt: meta.builtAt };
  const indexes = {};
  for (const category of Object.keys(meta.categories)) {
    const { data, error } = await db().storage.from(LIST_BUCKET).download(indexFile(category));
    if (error || !data) throw new Error(`index ${category}: ${error?.message ?? 'empty'}`);
    const buffer = await data.arrayBuffer();
    indexes[category] = new BigUint64Array(buffer, 0, Math.floor(buffer.byteLength / 8));
  }
  return { indexes, builtAt: meta.builtAt };
}

async function currentIndexes() {
  if (domainBlocklists().length === 0) return null;
  const age = Date.now() - cache.at;
  if (cache.at && age < (cache.indexes ? RECHECK_MS : RETRY_MS)) return cache.indexes;
  // One load at a time per instance, however many requests ask.
  cache.loading ??= load()
    .then(({ indexes, builtAt }) => {
      cache = { at: Date.now(), indexes, builtAt, loading: null };
    })
    .catch((cause) => {
      console.warn('[onelink] domain blocklist:', cause?.message ?? cause);
      cache = { at: Date.now(), indexes: cache.indexes, builtAt: cache.builtAt, loading: null };
    });
  await cache.loading;
  return cache.indexes;
}

function has(index, value) {
  let lo = 0;
  let hi = index.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = index[mid];
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

// The category of the first list host is on (itself or a parent domain), or
// null when it is on none.
export async function blocklistCategory(host) {
  const indexes = await currentIndexes();
  if (!indexes) return null;
  const names = [];
  let name = String(host || '').toLowerCase().replace(/\.$/, '');
  while (name.includes('.')) {
    names.push(fingerprint(name));
    name = name.slice(name.indexOf('.') + 1);
  }
  for (const category of CATEGORIES) {
    const index = indexes[category];
    if (index && names.some((value) => has(index, value))) return category;
  }
  return null;
}

// For tests: forget what this instance loaded.
export function forgetDomainBlocklist() {
  cache = { at: 0, indexes: null, builtAt: null, loading: null };
}
