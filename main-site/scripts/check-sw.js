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
const outside = handler ? code.replace(handler[0], '') : code;
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

const list = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
const paths = list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
for (const path of paths) {
  const clean = path === '/' ? '/index.html' : path;
  const candidates = [clean, `${clean}.html`].map((p) => join(root, p));
  if (!candidates.some((file) => existsSync(file))) {
    console.log(`error  precached but missing: ${path}`);
    problems += 1;
  }
}
const version = source.match(/const VERSION = '([^']+)'/);
console.log(`sw.js VERSION ${version ? version[1] : '(none)'}, ${paths.length} precached paths`);
console.log(problems ? `${problems} problem(s)` : 'ok');
process.exit(problems ? 1 : 0);
