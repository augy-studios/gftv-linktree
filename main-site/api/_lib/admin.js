// Small helpers for the admin routes.

import { query } from './http.js';

export const PAGE_SIZE = 25;

export function offsetOf(req) {
  const n = Number.parseInt(query(req, 'offset'), 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100_000) : 0;
}

// A search term safe to put inside a PostgREST ilike pattern, including the
// quoted values of an .or() filter: no wildcards, quotes, commas, brackets or
// backslashes from the user, only what a slug, title or address contains.
export function searchTerm(req) {
  return query(req, 'q')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} .\-_/:@#?=&+~]/gu, '')
    .trim()
    .slice(0, 80);
}

export function pattern(term) {
  return `%${term}%`;
}
