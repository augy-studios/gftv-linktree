// Google Safe Browsing (Lookup API v4): the list of malware, phishing and
// unwanted-software addresses that Chrome, Firefox and Safari warn about.
//
// Optional. With GOOGLE_SAFE_BROWSING_KEY unset nothing is checked, and with
// it set a lookup that fails or takes too long lets the address through and
// is logged: the staff block lists still apply, and the daily cron checks
// every live link again. The Lookup API is free for non-commercial use;
// commercial use is Google's Web Risk API instead.

import { optionalEnv } from './env.js';

const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const BATCH = 500; // the API's limit per request
const TIMEOUT_MS = 4000;

export function safeBrowsingConfigured() {
  return optionalEnv('GOOGLE_SAFE_BROWSING_KEY') !== '';
}

// The addresses among urls that Safe Browsing lists, as a Set. Empty when
// the check is switched off or could not be made.
export async function unsafeUrls(urls) {
  const key = optionalEnv('GOOGLE_SAFE_BROWSING_KEY');
  const unique = [...new Set(urls.filter(Boolean))];
  const flagged = new Set();
  if (!key || unique.length === 0) return flagged;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    try {
      const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          client: { clientId: 'onelink-gftv', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: batch.map((url) => ({ url })),
          },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      for (const match of data.matches ?? []) {
        if (match?.threat?.url) flagged.add(match.threat.url);
      }
    } catch (cause) {
      console.warn('[onelink] safe browsing lookup:', cause?.message ?? cause);
    }
  }
  return flagged;
}
