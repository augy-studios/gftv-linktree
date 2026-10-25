// assets/i18n/boot.js
// Loaded once per page from <head>, and imported by js/app.js, which is the
// same module URL and so runs once. Module scripts are deferred, so the DOM
// is parsed when init runs and applyTo finds every binding on the first pass.
import { init } from './i18n.js';
import { locales, registry } from './locales.js';
import { mountSwitcher } from './switcher.js';

init({ locales, registry });
mountSwitcher(document.querySelector('[data-language-switcher]'));
