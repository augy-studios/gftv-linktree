// A staff member's passkeys for this site.
//
// GET                                               -> { passkeys }
// POST { action: "options", password }              -> { options }
// POST { action: "finish", response, label }
// POST { action: "remove", id, password }
//
// The GFTV password is asked for again before adding or removing one.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { verifyPassword } from '../_lib/crypto.js';
import { cleanText, isUuid, LIMITS } from '../_lib/validate.js';
import { limited, audit } from '../_lib/guards.js';
import { requireStaff } from '../_lib/staff.js';
import { listPasskeys, registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { ownerPasskey } from '../_lib/serialize.js';

// Whether the password matches the staff member's GFTV password.
async function passwordOk(userId, password) {
  const { data, error } = await database().from(TABLES.staffUsers).select('password_hash').eq('id', userId).single();
  if (error) {
    throw error;
  }
  return verifyPassword(password, data.password_hash);
}

// Checks the caller is staff. GET lists their passkeys; POST counts against
// the re-auth limit, asks for the password again for options and remove,
// then runs the action.
export default route('admin/passkeys', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const staff = await requireStaff(request, response);
  if (!staff) {
    return;
  }
  const user = staff.user;
  const list = async () => (await listPasskeys('staff', user.id)).map(ownerPasskey);

  if (request.method === 'GET') {
    return ok(response, { passkeys: await list() });
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'staffLogin', [`reauth:${user.id}`])) {
    return;
  }

  if (body.action === 'options' || body.action === 'remove') {
    if (!(await passwordOk(user.id, body.password))) {
      return fail(response, 401, 'password_wrong');
    }
  }

  if (body.action === 'options') {
    const options = await registrationOptions('staff', {
      subjectId: user.id,
      userName: user.username,
      displayName: user.display_name,
    });
    return ok(response, { options });
  }

  if (body.action === 'finish') {
    const result = await finishRegistration('staff', {
      subjectId: user.id,
      response: body.response,
      label: cleanText(body.label, LIMITS.label),
    });
    if (!result.ok) {
      return fail(response, 400, result.error);
    }
    await audit(request, { action: 'staff.passkey_added', actorType: 'staff', actorId: user.id });
    return ok(response, { passkeys: await list() });
  }

  if (body.action === 'remove') {
    if (!isUuid(body.id)) {
      return fail(response, 400, 'bad_request');
    }
    await removePasskey('staff', user.id, body.id);
    await audit(request, { action: 'staff.passkey_removed', actorType: 'staff', actorId: user.id });
    return ok(response, { passkeys: await list() });
  }

  fail(response, 400, 'bad_request');
});
