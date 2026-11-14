// Small helpers for the admin routes.

import { query } from './http.js';

export const PAGE_SIZE = 25;

export function offsetOf(request) {
  const offset = Number.parseInt(query(request, 'offset'), 10);
  if (Number.isFinite(offset) && offset >= 0) {
    return Math.min(offset, 100_000);
  }
  return 0;
}

// A search term safe to put inside a PostgREST ilike pattern, including the
// quoted values of an .or() filter: no wildcards, quotes, commas, brackets or
// backslashes from the user, only what a slug, title or address contains.
export function searchTerm(request) {
  return query(request, 'q')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} .\-_/:@#?=&+~]/gu, '')
    .trim()
    .slice(0, 80);
}

export function pattern(term) {
  return `%${term}%`;
}
