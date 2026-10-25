// Page names nobody may register: slurs and profanity, and names that pass
// a page off as GFTV, as staff, or as a body people trust with a password
// or a payment. Pure: no database. The staff block lists (exact names and
// patterns) are checked separately, in guards.js.
//
// The slur lists are the word filter shared by the GFTV game sites
// (snake-game js/wordfilter.js, also each game's api/_lib/names.js), kept in
// step with that copy. The Chinese entries can never match a page name,
// which is ASCII; they stay so the lists read the same as the original.

// Matched anywhere in the squashed name. Long or unambiguous only, so an
// ordinary word does not trip it.
const SLURS_ANYWHERE = [
  'fuck', 'fck', 'shit', 'cunt', 'bitch', 'nigger', 'nigga', 'faggot', 'asshole', 'bastard',
  'wanker', 'whore', 'pussy', 'penis', 'vagina', 'porn', 'retard', 'twat', 'dildo', 'blowjob',
  'motherf', 'hitler', 'cocksuck', 'jerkoff', 'wetback', 'towelhead', 'raghead',
  // Singlish, Hokkien and Malay.
  'lanjiao', 'lanjio', 'chibai', 'cheebye', 'cheebai', 'pukimak', 'kanina', 'kannina', 'nabeh',
  'knnbccb',
  // Chinese.
  '操你', '肏', '屄', '屌', '妈的', '他妈', '傻逼', '傻屄', '煞笔', '贱人', '婊子', '鸡巴', '狗日',
  '草泥马', '王八蛋', '日你', '干你', '你妈', '去死', '滚蛋', '强奸',
];

// Matched only as a whole word, since each is also part of harmless words:
// "assist", "cocktail", "grape", "Dickson", "therapist", "torpedo",
// "raccoon", "cocoon".
const SLURS_WHOLE_WORD = new Set([
  'ass', 'cock', 'dick', 'dicks', 'rape', 'raped', 'rapes', 'rapist', 'fag', 'fags', 'slut', 'sluts',
  'tits', 'cum', 'sex', 'nazi', 'nazis', 'pedo', 'chink', 'chinks', 'gook', 'gooks', 'coon', 'coons',
  'dyke', 'dykes', 'kike', 'kikes', 'spic', 'spics', 'tranny', 'retards', 'negro', 'negroes',
  'knn', 'ccb', 'cb', 'puki', 'kkb', 'wtf', 'stfu',
]);

// Impersonation, anywhere in the squashed name: "gftvofficial",
// "official-gftv-support", "singpass-help".
const POSING_ANYWHERE = [
  'gftv', 'globalfurry', 'furrytelevision', 'onelink', 'official', 'offical', 'administrator',
  'moderator', 'helpdesk', 'customerservice', 'customersupport', 'verification', 'singpass', 'govsg',
  'govtech',
];

// Impersonation as one of the name's words: "gov-help", "mod-team",
// "cpf-refund". Short or common words only count on their own.
const POSING_WORD = new Set([
  'gov', 'govt', 'government', 'admin', 'admins', 'staff', 'mod', 'mods', 'support', 'verify',
  'verified', 'security', 'helpline', 'hotline', 'refund', 'refunds',
  // Singapore public bodies whose names phishers borrow.
  'iras', 'cpf', 'moh', 'mha', 'mfa', 'moe', 'mindef', 'scdf', 'hdb', 'cpib', 'spf', 'ica', 'lta',
  'mas', 'nea', 'ura', 'saf', 'police', 'sgpolice',
  // Banks and payment brands, the usual phishing targets here.
  'dbs', 'posb', 'ocbc', 'uob', 'paylah', 'paynow', 'paypal',
]);

// Taken as the whole name only, since each is an ordinary word or a brand a
// fan page might reasonably build on ("apple-pie", "steam-art").
const POSING_EXACT = new Set([
  'apple', 'google', 'microsoft', 'meta', 'discord', 'steam', 'telegram', 'whatsapp', 'instagram',
  'facebook', 'tiktok', 'youtube', 'twitter', 'twitch', 'singtel', 'starhub', 'grab', 'shopee',
  'lazada', 'carousell', 'singpost',
  // Singapore public bodies whose acronyms are also everyday words.
  'mom', 'pub',
]);

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };
const unleet = (s) => s.replace(/[0-9]/g, (d) => LEET[d] ?? d);

// True when a page name may not be registered for what it says. The name is
// already in the slug shape: lowercase letters, digits and single hyphens.
export function nameIsUnwelcome(slug) {
  const lower = String(slug || '').toLowerCase();
  const words = lower.split('-');
  const squashed = lower.replace(/-/g, '');
  for (const form of [squashed, unleet(squashed)]) {
    if (SLURS_ANYWHERE.some((w) => form.includes(w))) return true;
    if (POSING_ANYWHERE.some((w) => form.includes(w))) return true;
    if (POSING_EXACT.has(form)) return true;
  }
  for (const word of [...words, ...words.map(unleet)]) {
    if (SLURS_WHOLE_WORD.has(word) || POSING_WORD.has(word)) return true;
  }
  return false;
}
