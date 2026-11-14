#!/usr/bin/env node
// npm run check-sw
//
// The scripted check update-bar-spec.md asks for: the worker calls
// skipWaiting() and clients.claim() only inside its "skip-waiting" message
// handler. Either one anywhere else silently turns the update bar back into
// a worker that takes over mid-session.
//
// It also checks that every file the worker precaches exists, since a single
// missing file fails the whole install.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'sw.js'), 'utf8');
let problems = 0;

// Strip comments, then cut out the message handler and look at what is left.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const handler = code.match(/self\.addEventListener\(\s*['"]message['"][\s\S]*?\n\}\);/);
let outside = code;
if (handler) {
  outside = code.replace(handler[0], '');
}
for (const call of ['skipWaiting(', 'clients.claim(']) {
  if (outside.includes(call)) {
    console.log(`error  ${call}) appears outside the message handler`);
    problems += 1;
  }
}
if (!handler || !handler[0].includes("'skip-waiting'")) {
  console.log('error  no skip-waiting message handler found');
  problems += 1;
}

// Every path in PRECACHE must be a real file: '/' is index.html, and a clean
// path such as /edit may be edit.html.
const list = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
let paths = [];
if (list) {
  paths = [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}
for (const path of paths) {
  let clean = path;
  if (path === '/') {
    clean = '/index.html';
  }
  const candidates = [clean, `${clean}.html`].map((candidate) => join(root, candidate));
  if (!candidates.some((file) => existsSync(file))) {
    console.log(`error  precached but missing: ${path}`);
    problems += 1;
  }
}
const version = source.match(/const VERSION = '([^']+)'/);
let versionText = '(none)';
if (version) {
  versionText = version[1];
}
console.log(`sw.js VERSION ${versionText}, ${paths.length} precached paths`);
if (problems) {
  console.log(`${problems} problem(s)`);
  process.exit(1);
} else {
  console.log('ok');
  process.exit(0);
}
