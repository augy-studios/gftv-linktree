// Home: the claim field, which checks the name as it is typed and hands it
// to the sign-up page.

import '../app.js';
import { wireSlugCheck, normaliseSlugInput } from '../slug-check.js';

const form = document.getElementById('claimForm');
const input = document.getElementById('claimSlug');
wireSlugCheck(input, document.getElementById('claimStatus'));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const slug = normaliseSlugInput(input.value);
  window.location.href = slug ? `/register?slug=${encodeURIComponent(slug)}` : '/register';
});
