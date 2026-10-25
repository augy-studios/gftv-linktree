#!/usr/bin/env node
// assets/i18n/check-keys.js
// node assets/i18n/check-keys.js          compare every locale with en.json
// node assets/i18n/check-keys.js --scan   also check keys used in HTML and JS
//
// Section 11.2 of i18n-retrofit-spec.md. Exits non-zero on missing keys,
// stale keys, plural families without .other, placeholder mismatches, and
// (with --scan) keys used in code that en.json does not have. Values
// identical to English, and en.json keys used nowhere, are listed only.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..', '..');
const PLURAL = /\.(zero|one|two|few|many|other)$/;
const read = (file) => JSON.parse(readFileSync(join(here, file), 'utf8'));
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const base = (k) => k.replace(PLURAL, '');

const en = read('en.json');
let errors = 0;
const fail = (msg) => { errors += 1; console.log(`  error  ${msg}`); };
const info = (msg) => console.log(`  note   ${msg}`);

for (const [key, value] of Object.entries(en)) {
  if (typeof value !== 'string') fail(`en.json ${key} is not a string`);
  else if (value === '') fail(`en.json ${key} is empty`);
}
const enBases = new Set(Object.keys(en).map(base));
for (const b of enBases) {
  if (Object.keys(en).some((k) => PLURAL.test(k) && base(k) === b) && !(`${b}.other` in en)) fail(`en.json plural ${b} has no .other`);
}

for (const file of readdirSync(here).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  console.log(`${file}`);
  const loc = read(file);
  const locBases = new Set(Object.keys(loc).map(base));
  for (const b of enBases) if (!locBases.has(b)) fail(`missing ${b}`);
  for (const b of locBases) if (!enBases.has(b)) fail(`not in en.json: ${b}`);
  for (const b of locBases) {
    const family = Object.keys(loc).filter((k) => PLURAL.test(k) && base(k) === b);
    if (family.length && !(`${b}.other` in loc)) fail(`plural ${b} has no .other`);
  }
  for (const [key, value] of Object.entries(loc)) {
    if (typeof value !== 'string') { fail(`${key} is not a string`); continue; }
    if (value === '') fail(`${key} is empty`);
    const ref = en[key] ?? en[`${base(key)}.other`];
    if (ref !== undefined && placeholders(ref) !== placeholders(value)) fail(`placeholders differ in ${key}: en {${placeholders(ref)}} vs {${placeholders(value)}}`);
    if (en[key] === value) info(`same as English: ${key}`);
  }
}

if (process.argv.includes('--scan')) {
  console.log('scan');
  const used = new Set();
  // Any quoted literal shaped like a key, for the unused-key notes: keys
  // chosen by a ternary or kept in a lookup table are used, just not through
  // a literal t('...') call.
  const mentioned = new Set();
  const dynamic = [];
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'api' || name === 'vendor' || name === 'tests' || name.startsWith('.')) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  for (const file of walk(siteRoot)) {
    const ext = extname(file);
    if (ext !== '.html' && ext !== '.js') continue;
    if (file.endsWith('check-keys.js')) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/data-i18n-attr="([^"]+)"/g)) m[1].split(',').forEach((p) => used.add(p.split(':')[1].trim()));
    for (const m of text.matchAll(/\bt\(\s*'([^'$]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/\bt\(\s*`([^`]*\$\{[^`]*)`/g)) dynamic.push(m[1]);
    for (const m of text.matchAll(/i18n:\s*'([^']+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/['"]([a-z0-9-]+(?:\.[a-z0-9-]+)+)['"]/g)) mentioned.add(m[1]);
  }
  for (const key of used) if (!enBases.has(key) && !(key in en)) fail(`used but not in en.json: ${key}`);
  // Keys reached through a template (error.${code}, theme.mode.${mode} and so
  // on) cannot be checked statically; list their prefixes so an unused-key
  // report does not flag them.
  const prefixes = [...new Set(dynamic.map((d) => d.split('${')[0]))].filter(Boolean);
  for (const key of enBases) {
    if (!used.has(key) && !mentioned.has(key) && !prefixes.some((p) => key.startsWith(p))) info(`in en.json but not found in code: ${key}`);
  }
  info(`dynamic prefixes: ${prefixes.join(' ')}`);
}

console.log(errors ? `\n${errors} error(s)` : '\nok');
process.exit(errors ? 1 : 0);
