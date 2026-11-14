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

// Draws the list: an error, nothing yet (still loading), an empty note, or
// one card per team member linking to their page.
function render() {
  list.removeAttribute('aria-busy');
  if (failed) {
    list.replaceChildren(createElement('li', { class: 'callout danger', text: translate('team.load-failed') }));
    return;
  }
  if (!members) {
    return;
  }
  if (members.length === 0) {
    list.replaceChildren(createElement('li', { class: 'empty-state', text: translate('team.empty') }));
    return;
  }
  list.replaceChildren(...members.map((member) => {
    const avatar = createElement('div', { class: 'avatar small', 'aria-hidden': 'true' });
    fillAvatar(avatar, member.avatarUrl, member.displayName);
    const wrap = createElement('div', { class: 'avatar-wrap small team', 'aria-hidden': 'true' }, [avatar, createElement('span', { class: 'team-tick' }, [iconNode('check')])]);
    let roleLine = null;
    if (member.role) {
      roleLine = createElement('div', { class: 'role', text: member.role });
    }
    return createElement('li', {}, [createElement('a', { class: 'glass-card team-member', href: `/${member.slug}` }, [
      wrap,
      createElement('div', { class: 'team-member-text' }, [
        createElement('div', { class: 'name', text: member.displayName }),
        createElement('div', { class: 'handle', text: `links.gftv.asia/${member.slug}` }),
        roleLine,
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
