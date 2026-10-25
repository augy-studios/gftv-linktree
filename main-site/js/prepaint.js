// The pre-paint script from gftv-theme.md section 3, as a classic script
// loaded synchronously in <head> before the stylesheet. It behaves exactly as
// the inline version (it blocks first paint until both attributes are set);
// living in a file is what lets the Content-Security-Policy refuse inline
// scripts. Keep the key in step with APP_KEY in theme.js.
(function () {
  var k = "gftv-onelink";
  var m = "light";
  var c = "classic";
  try {
    m = localStorage.getItem(k + ".mode") || "light";
    c = localStorage.getItem(k + ".colorTheme") || "classic";
  } catch (e) { /* storage blocked: defaults */ }

  // Time based mode. Resolved here rather than in theme.js because theme.js
  // runs after first paint, and an evening reader would otherwise watch a
  // white page turn dark. Keep the two hours in step with LIGHT_FROM_HOUR
  // and LIGHT_UNTIL_HOUR in theme.js.
  if (m === "time") {
    var h = new Date().getHours();
    m = h >= 9 && h < 18 ? "light" : "dark";
    document.documentElement.setAttribute("data-mode-preference", "time");
  }

  // data-mode is only ever light or dark, so an unknown stored value falls
  // back rather than leaving the page unstyled.
  if (m !== "dark") m = "light";
  if (c !== "hello") c = "classic";
  document.documentElement.setAttribute("data-mode", m);
  document.documentElement.setAttribute("data-color-theme", c);
})();
