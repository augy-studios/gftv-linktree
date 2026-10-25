// GFTV official site banner, see gftv-official.md.
// Classic script, loaded synchronously as the first thing in <body>, so the
// bar is in the document before anything below it is parsed and nothing
// shifts. Permanent: there is no close control and nothing stored hides it.
// Only the expansion is remembered.
//
// The copy carries data-i18n keys and English as initial content, so the
// i18n runtime translates it on its first pass like any other markup.
(function () {
  // The two things a site has to know about officialness live together.
  var OFFICIAL_DOMAINS = ["globalfurry.tv", "gftv.asia"];
  var TRUSTED_SITES_URL = "https://gftv.asia/trusted-sites";

  var STORAGE_KEY = "gftv-onelink.officialBar";
  var MOTION_MS = 220;

  var domains = OFFICIAL_DOMAINS.join(" or ");

  var html =
    '<div class="gov-bar" id="officialBar">' +
      '<div class="gov-bar-inner">' +
        '<img class="gov-bar-mark" data-src="/gftv-flag.png" alt="" width="24" height="16">' +
        '<p class="gov-bar-line">' +
          '<span class="gov-bar-line-long" data-i18n="official.line">An official Global Furry Television website</span>' +
          '<span class="gov-bar-line-short" data-i18n="official.line-short">An official GFTV website</span>' +
        '</p>' +
        '<button type="button" class="gov-bar-toggle" id="officialBarToggle" aria-expanded="false" aria-controls="officialBarPanel">' +
          '<span data-i18n="official.toggle">How to identify</span>' +
          '<span data-icon="chevron-down" aria-hidden="true"></span>' +
        '</button>' +
      '</div>' +
      '<div class="gov-bar-panel" id="officialBarPanel" hidden>' +
        '<div class="gov-bar-panel-inner">' +
          '<div class="gov-bar-point">' +
            '<span data-icon="globe" aria-hidden="true"></span>' +
            '<div>' +
              '<h2 data-i18n="official.domain-heading">Official GFTV sites end with ' + domains + '</h2>' +
              '<p data-i18n="official.domain-body">Read the address from the end, at the last dot before the first single slash. A site ending in anything else is not GFTV, even if the name appears earlier in the address.</p>' +
              '<p><a href="' + TRUSTED_SITES_URL + '" data-i18n="official.trusted-link">The full list of official GFTV sites</a></p>' +
            '</div>' +
          '</div>' +
          '<div class="gov-bar-point">' +
            '<span data-icon="lock" aria-hidden="true"></span>' +
            '<div>' +
              '<h2 data-i18n="official.secure-heading">Secure sites use HTTPS</h2>' +
              '<p data-i18n="official.secure-body">Look for a padlock, or https:// at the start of the address. Only share personal details on an official site over a secure connection.</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  var script = document.currentScript;
  if (script) script.insertAdjacentHTML("afterend", html);
  else document.body.insertAdjacentHTML("afterbegin", html);

  var toggle = document.getElementById("officialBarToggle");
  var panel = document.getElementById("officialBarPanel");
  var fallback = null;

  function remember(open) {
    try {
      if (open) localStorage.setItem(STORAGE_KEY, "open");
      else localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* storage unavailable, the bar still works */ }
  }

  // Run fn once the height transition ends, or after a fallback in case it
  // never fires (a zero-length transition, or a browser that skips it).
  var pending = null;
  function settle(fn) {
    clearTimeout(fallback);
    if (pending) panel.removeEventListener("transitionend", pending);
    var done = false;
    function once(e) {
      if (done || (e && (e.target !== panel || e.propertyName !== "height"))) return;
      done = true;
      pending = null;
      panel.removeEventListener("transitionend", once);
      clearTimeout(fallback);
      fn();
    }
    pending = once;
    panel.addEventListener("transitionend", once);
    fallback = setTimeout(once, MOTION_MS + 80);
  }

  function open(animate) {
    toggle.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    if (!animate) { panel.style.height = ""; return; }
    var from = panel.style.height ? panel.getBoundingClientRect().height : 0;
    panel.style.height = from + "px";
    void panel.offsetHeight;
    panel.style.height = panel.scrollHeight + "px";
    settle(function () { panel.style.height = ""; });
  }

  function close() {
    toggle.setAttribute("aria-expanded", "false");
    panel.style.height = panel.getBoundingClientRect().height + "px";
    void panel.offsetHeight;
    panel.style.height = "0px";
    settle(function () {
      panel.hidden = true;
      panel.style.height = "";
    });
  }

  var wasOpen = false;
  try { wasOpen = localStorage.getItem(STORAGE_KEY) === "open"; } catch (e) {}
  if (wasOpen) open(false);

  toggle.addEventListener("click", function () {
    var isOpen = toggle.getAttribute("aria-expanded") === "true";
    if (isOpen) close(); else open(true);
    remember(!isOpen);
  });
})();
