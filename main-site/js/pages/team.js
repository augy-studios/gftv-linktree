// /team: every page an admin has marked as someone on the GFTV team, so
// anyone can check a name against the official list. Names and roles only
// ever go in through textContent.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { el } from '../ui.js';
import { iconNode, hydrateIcons } from '../icons.js';
import { fillAvatar } from '../avatar.js';

const list = document.getElementById('teamList');
let members = null;
let failed = false;

function render() {
  list.removeAttribute('aria-busy');
  if (failed) {
    list.replaceChildren(el('li', { class: 'callout danger', text: t('team.load-failed') }));
    return;
  }
  if (!members) return;
  if (members.length === 0) {
    list.replaceChildren(el('li', { class: 'empty-state', text: t('team.empty') }));
    return;
  }
  list.replaceChildren(...members.map((m) => {
    const avatar = el('div', { class: 'avatar small', 'aria-hidden': 'true' });
    fillAvatar(avatar, m.avatarUrl, m.displayName);
    const wrap = el('div', { class: 'avatar-wrap small team', 'aria-hidden': 'true' }, [avatar, el('span', { class: 'team-tick' }, [iconNode('check')])]);
    return el('li', {}, [el('a', { class: 'glass-card team-member', href: `/${m.slug}` }, [
      wrap,
      el('div', { class: 'team-member-text' }, [
        el('div', { class: 'name', text: m.displayName }),
        el('div', { class: 'handle', text: `links.gftv.asia/${m.slug}` }),
        m.role ? el('div', { class: 'role', text: m.role }) : null,
      ]),
    ])]);
  }));
  hydrateIcons(list);
}

api('/api/public/team')
  .then((data) => { members = data.members; })
  .catch(() => { failed = true; })
  .finally(render);

onChange(render);
