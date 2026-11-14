// Staff sign in for the admin dashboard, against gftvhello_users.
//
// GET                                   -> { staff } or 401
// POST { action: "login", identifier, password }  -> { challenge, methods }
// POST { action: "verify", challenge, method, code? | response? }
//        method: totp | backup | passkey-options | passkey
// POST { action: "logout" }
//
// A second factor is mandatory. Staff with neither an authenticator app on
// their GFTV account nor a passkey registered here are told to set one up on
// gftv.asia first; this site never enrols a staff authenticator, because that
// would write to the shared account.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { verifyPassword, sha256, normaliseCode, safeEqual } from '../_lib/crypto.js';
import { verifyTotp } from '../_lib/totp.js';
import { limited, audit } from '../_lib/guards.js';
import { authenticationOptions, finishAuthentication, countPasskeys } from '../_lib/webauthn.js';
import { createChallenge, findChallenge, failChallengeAttempt, deleteChallenge } from '../_lib/session.js';
import { createStaffSession, currentStaff, endStaffSession, hasDashboardAccess, publicStaff } from '../_lib/staff.js';
import bcrypt from 'bcryptjs';

const STAFF_AUTH_COLUMNS = 'id, username, display_name, password_hash, is_admin, is_editor, is_approved, totp_secret';

// The staff account for a username or email, or null.
async function findStaffByIdentifier(identifier) {
  let typed = identifier;
  if (typed === null || typed === undefined) {
    typed = '';
  }
  const value = String(typed).trim().toLowerCase();
  if (!value || value.length > 254 || /\s/.test(value)) {
    return null;
  }
  // Two exact lookups rather than one .or() filter built from user input.
  let column;
  if (value.includes('@')) {
    column = 'email';
  } else {
    column = 'username';
  }
  const { data, error } = await database().from(TABLES.staffUsers).select(STAFF_AUTH_COLUMNS).eq(column, value).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// gftvhello_backup_codes holds codes in two formats, depending on which GFTV
// site issued them: bcrypt of the lowercased code (careers-gftv), or SHA-256
// of the uppercased code with its hyphen removed (gftv-redirects-portal).
// Both are accepted; the matching row is deleted, as every site does.
// Every row is checked, even after a match, and the first match is spent.
async function spendStaffBackupCode(userId, typed) {
  const { data, error } = await database().from(TABLES.staffBackupCodes).select('id, code_hash').eq('user_id', userId);
  if (error) {
    throw error;
  }
  const lower = normaliseCode(typed);
  if (lower.length < 6) {
    return false;
  }
  const legacy = sha256(String(typed).trim().toUpperCase().replace(/\s/g, '').replace('-', ''));
  let rows = [];
  if (data) {
    rows = data;
  }
  let matched = null;
  for (const row of rows) {
    let storedHash = row.code_hash;
    if (!storedHash) {
      storedHash = '';
    }
    const hash = String(storedHash);
    let isMatch;
    if (hash.startsWith('$2')) {
      isMatch = await bcrypt.compare(lower, hash);
    } else {
      isMatch = safeEqual(hash, legacy);
    }
    if (isMatch && !matched) {
      matched = row;
    }
  }
  if (!matched) {
    return false;
  }
  const { data: spent, error: spendError } = await database().from(TABLES.staffBackupCodes).delete().eq('id', matched.id).select('id');
  if (spendError) {
    throw spendError;
  }
  // Only a delete that took the row counts, so two sign-ins racing on one
  // code cannot both pass.
  let spentRows = [];
  if (spent) {
    spentRows = spent;
  }
  return spentRows.length === 1;
}

// Which second factors the staff member can use: { totp, passkey, backup }.
async function staffMethods(user) {
  const { count, error } = await database()
    .from(TABLES.staffBackupCodes)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (error) {
    throw error;
  }
  let backupCount = 0;
  if (count !== null && count !== undefined) {
    backupCount = count;
  }
  return {
    totp: Boolean(user.totp_secret),
    passkey: (await countPasskeys('staff', user.id)) > 0,
    backup: backupCount > 0,
  };
}

// GET says who is signed in. POST runs one step: logout; login (rate limit,
// password, dashboard role, then a challenge); or verify (rate limit,
// challenge, account still allowed, then the second factor and a session).
export default route('admin/auth', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }

  if (request.method === 'GET') {
    const staff = await currentStaff(request);
    if (!staff) {
      return fail(response, 401, 'signed_out');
    }
    return ok(response, { staff: publicStaff(staff.user) });
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }

  if (body.action === 'logout') {
    await endStaffSession(request, response);
    return ok(response);
  }

  if (body.action === 'login') {
    let identifier = body.identifier;
    if (identifier === null || identifier === undefined) {
      identifier = '';
    }
    const subject = `id:${sha256(String(identifier).trim().toLowerCase())}`;
    if (await limited(request, response, 'staffLogin', [subject])) {
      return;
    }
    const user = await findStaffByIdentifier(body.identifier);
    // The password is checked even with no such account (against a dummy
    // hash), so the answer takes as long either way.
    let passwordHash;
    if (user) {
      passwordHash = user.password_hash;
    }
    const passwordOk = await verifyPassword(body.password, passwordHash);
    if (!user || !passwordOk) {
      return fail(response, 401, 'invalid_credentials');
    }
    if (!hasDashboardAccess(user)) {
      await audit(request, { action: 'staff.denied', actorType: 'staff', actorId: user.id, details: { reason: 'role' } });
      return fail(response, 403, 'no_access');
    }
    const methods = await staffMethods(user);
    if (!methods.totp && !methods.passkey) {
      return fail(response, 403, 'staff_needs_2fa');
    }
    const challenge = await createChallenge({ realm: 'staff', purpose: 'login', subjectId: user.id });
    return ok(response, { challenge, methods });
  }

  if (body.action !== 'verify') {
    return fail(response, 400, 'bad_request');
  }
  let challengeToken = body.challenge;
  if (challengeToken === null || challengeToken === undefined) {
    challengeToken = '';
  }
  if (await limited(request, response, 'secondFactor', [`staff:${sha256(String(challengeToken))}`])) {
    return;
  }

  const challenge = await findChallenge(body.challenge, 'staff', 'login');
  if (!challenge) {
    return fail(response, 401, 'challenge_expired');
  }
  const { data: user, error } = await database()
    .from(TABLES.staffUsers)
    .select(STAFF_AUTH_COLUMNS)
    .eq('id', challenge.subject_id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  // A role removed on gftv.asia since the password step ends the sign-in.
  if (!user || !hasDashboardAccess(user)) {
    await deleteChallenge(challenge);
    return fail(response, 403, 'no_access');
  }

  let passed = false;
  switch (body.method) {
    case 'totp':
      passed = Boolean(user.totp_secret);
      if (passed) {
        passed = verifyTotp(body.code, user.totp_secret);
      }
      break;
    case 'backup':
      passed = await spendStaffBackupCode(user.id, body.code);
      break;
    case 'passkey-options': {
      const options = await authenticationOptions('staff', user.id);
      if (!options) {
        return fail(response, 400, 'no_passkeys');
      }
      return ok(response, { options });
    }
    case 'passkey':
      passed = await finishAuthentication('staff', user.id, body.response);
      break;
    default:
      return fail(response, 400, 'bad_request');
  }

  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(request, { action: 'staff.login_failed', actorType: 'staff', actorId: user.id, details: { method: body.method } });
    return fail(response, 401, 'code_wrong');
  }

  await deleteChallenge(challenge);
  await createStaffSession(response, user.id);
  await audit(request, { action: 'staff.login', actorType: 'staff', actorId: user.id, details: { method: body.method } });
  ok(response, { staff: publicStaff(user) });
});
