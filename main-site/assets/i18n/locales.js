// assets/i18n/locales.js
// Every locale file, imported statically so switching needs no request.
// Adding a language: one import, one entry in `locales`, one in `registry`,
// then add the file to the service worker precache and bump its version.
import en from './en.json' with { type: 'json' };
import zh from './zh.json' with { type: 'json' };
import ms from './ms.json' with { type: 'json' };
import ta from './ta.json' with { type: 'json' };
import tl from './tl.json' with { type: 'json' };
import id from './id.json' with { type: 'json' };

export const locales = { en, zh, ms, ta, tl, id };

export const registry = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'zh', name: '华文', dir: 'ltr' },
  { code: 'ms', name: 'Bahasa Melayu', dir: 'ltr' },
  { code: 'ta', name: 'தமிழ்', dir: 'ltr' },
  { code: 'tl', name: 'Filipino', dir: 'ltr' },
  { code: 'id', name: 'Bahasa Indonesia', dir: 'ltr' },
];
