// A staff member's passkeys for this site.
//
// GET                                               -> { passkeys }
// POST { action: "options", password }              -> { options }
// POST { action: "finish", response, label }
// POST { action: "remove", id, password }
//
// The GFTV password is asked for again before adding or removing one.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { verifyPassword } from '../_lib/crypto.js';
import { cleanText, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { listPasskeys, registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { ownerPasskey } from '../_lib/serialize.js';

async function passwordOk(userId, password) {
  const { data, error } = await db().from(T.staffUsers).select('password_hash').eq('id', userId).single();
  if (error) throw error;
  return verifyPassword(password, data.password_hash);
}

export default route('admin/passkeys', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const user = staff.user;
  const list = async () => (await listPasskeys('staff', user.id)).map(ownerPasskey);

  if (req.method === 'GET') return ok(res, { passkeys: await list() });

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'staffLogin', [`reauth:${user.id}`])) return;

  if (body.action === 'options' || body.action === 'remove') {
    if (!(await passwordOk(user.id, body.password))) return fail(res, 401, 'password_wrong');
  }

  if (body.action === 'options') {
    const options = await registrationOptions('staff', {
      subjectId: user.id,
      userName: user.username,
      displayName: user.display_name,
    });
    return ok(res, { options });
  }

  if (body.action === 'finish') {
    const result = await finishRegistration('staff', {
      subjectId: user.id,
      response: body.response,
      label: cleanText(body.label, LIMITS.label),
    });
    if (!result.ok) return fail(res, 400, result.error);
    await audit(req, { action: 'staff.passkey_added', actorType: 'staff', actorId: user.id });
    return ok(res, { passkeys: await list() });
  }

  if (body.action === 'remove') {
    if (!isUuid(body.id)) return fail(res, 400, 'bad_request');
    await removePasskey('staff', user.id, body.id);
    await audit(req, { action: 'staff.passkey_removed', actorType: 'staff', actorId: user.id });
    return ok(res, { passkeys: await list() });
  }

  fail(res, 400, 'bad_request');
});
