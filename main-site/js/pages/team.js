// /team: every page an admin has marked as someone on the GFTV team, so
// anyone can check a name against the official list. Names and roles only
// ever go in through textContent.

import '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { createElement } from '../ui.js';
import { iconNode, hydrateIcons } from '../icons.js';
import { fillAvatar } from '../avatar.js';

const list = document.getElementById('teamList');
let members = null;
let failed = false;

function render() {
  list.removeAttribute('aria-busy');
  if (failed) {
    list.replaceChildren(createElement('li', { class: 'callout danger', text: translate('team.load-failed') }));
    return;
  }
  if (!members) return;
  if (members.length === 0) {
    list.replaceChildren(createElement('li', { class: 'empty-state', text: translate('team.empty') }));
    return;
  }
  list.replaceChildren(...members.map((m) => {
    const avatar = createElement('div', { class: 'avatar small', 'aria-hidden': 'true' });
    fillAvatar(avatar, m.avatarUrl, m.displayName);
    const wrap = createElement('div', { class: 'avatar-wrap small team', 'aria-hidden': 'true' }, [avatar, createElement('span', { class: 'team-tick' }, [iconNode('check')])]);
    return createElement('li', {}, [createElement('a', { class: 'glass-card team-member', href: `/${m.slug}` }, [
      wrap,
      createElement('div', { class: 'team-member-text' }, [
        createElement('div', { class: 'name', text: m.displayName }),
        createElement('div', { class: 'handle', text: `links.gftv.asia/${m.slug}` }),
        m.role ? createElement('div', { class: 'role', text: m.role }) : null,
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
