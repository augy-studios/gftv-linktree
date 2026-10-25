// A device fingerprint for the sign-up, sign-in, password reset and editor
// pages, and nowhere else: public pages, the home page and the 404 promise
// visitors that nothing identifying them is kept, and never load this.
//
// FingerprintJS (js/vendor/fingerprintjs.js, loaded by those pages' HTML)
// works out an id from the browser in the browser. Monitoring is off, so it
// never contacts FingerprintJS's servers. api.js sends the id with each
// request; the server keeps only a salted hash of it, to tell when someone
// banned comes back on another connection.
//
// A page imports this module for its side effect. Without the library, or
// when it fails, requests simply go without.

import { useVisitorId } from './api.js';

const fp = window.FingerprintJS;
if (fp && typeof fp.load === 'function') {
  useVisitorId(
    fp
      .load({ monitoring: false })
      .then((agent) => agent.get())
      .then((result) => (typeof result?.visitorId === 'string' ? result.visitorId : null))
      .catch(() => null)
  );
}
