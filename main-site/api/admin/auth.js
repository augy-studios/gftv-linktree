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
import { db, T } from '../_lib/supabase.js';
import { verifyPassword, sha256, normaliseCode, safeEqual } from '../_lib/crypto.js';
import { verifyTotp } from '../_lib/totp.js';
import { limited, audit } from '../_lib/guards.js';
import { authenticationOptions, finishAuthentication, countPasskeys } from '../_lib/webauthn.js';
import { createChallenge, findChallenge, failChallengeAttempt, deleteChallenge } from '../_lib/session.js';
import { createStaffSession, currentStaff, endStaffSession, hasDashboardAccess, publicStaff } from '../_lib/staff.js';
import bcrypt from 'bcryptjs';

const STAFF_AUTH_COLUMNS = 'id, username, display_name, password_hash, is_admin, is_editor, is_approved, totp_secret';

async function findStaffByIdentifier(identifier) {
  const value = String(identifier ?? '').trim().toLowerCase();
  if (!value || value.length > 254 || /\s/.test(value)) return null;
  // Two exact lookups rather than one .or() filter built from user input.
  const column = value.includes('@') ? 'email' : 'username';
  const { data, error } = await db().from(T.staffUsers).select(STAFF_AUTH_COLUMNS).eq(column, value).maybeSingle();
  if (error) throw error;
  return data;
}

// gftvhello_backup_codes holds codes in two formats, depending on which GFTV
// site issued them: bcrypt of the lowercased code (careers-gftv), or SHA-256
// of the uppercased code with its hyphen removed (gftv-redirects-portal).
// Both are accepted; the matching row is deleted, as every site does.
async function spendStaffBackupCode(userId, typed) {
  const { data, error } = await db().from(T.staffBackupCodes).select('id, code_hash').eq('user_id', userId);
  if (error) throw error;
  const lower = normaliseCode(typed);
  if (lower.length < 6) return false;
  const legacy = sha256(String(typed).trim().toUpperCase().replace(/\s/g, '').replace('-', ''));
  let matched = null;
  for (const row of data ?? []) {
    const hash = String(row.code_hash || '');
    const isMatch = hash.startsWith('$2') ? await bcrypt.compare(lower, hash) : safeEqual(hash, legacy);
    if (isMatch && !matched) matched = row;
  }
  if (!matched) return false;
  const { data: spent, error: spendError } = await db().from(T.staffBackupCodes).delete().eq('id', matched.id).select('id');
  if (spendError) throw spendError;
  return (spent ?? []).length === 1;
}

async function staffMethods(user) {
  const { count, error } = await db()
    .from(T.staffBackupCodes)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (error) throw error;
  return {
    totp: Boolean(user.totp_secret),
    passkey: (await countPasskeys('staff', user.id)) > 0,
    backup: (count ?? 0) > 0,
  };
}

export default route('admin/auth', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;

  if (req.method === 'GET') {
    const staff = await currentStaff(req);
    if (!staff) return fail(res, 401, 'signed_out');
    return ok(res, { staff: publicStaff(staff.user) });
  }

  const body = await readJson(req, res);
  if (!body) return;

  if (body.action === 'logout') {
    await endStaffSession(req, res);
    return ok(res);
  }

  if (body.action === 'login') {
    const subject = `id:${sha256(String(body.identifier ?? '').trim().toLowerCase())}`;
    if (await limited(req, res, 'staffLogin', [subject])) return;
    const user = await findStaffByIdentifier(body.identifier);
    const passwordOk = await verifyPassword(body.password, user?.password_hash);
    if (!user || !passwordOk) return fail(res, 401, 'invalid_credentials');
    if (!hasDashboardAccess(user)) {
      await audit(req, { action: 'staff.denied', actorType: 'staff', actorId: user.id, details: { reason: 'role' } });
      return fail(res, 403, 'no_access');
    }
    const methods = await staffMethods(user);
    if (!methods.totp && !methods.passkey) return fail(res, 403, 'staff_needs_2fa');
    const challenge = await createChallenge({ realm: 'staff', purpose: 'login', subjectId: user.id });
    return ok(res, { challenge, methods });
  }

  if (body.action !== 'verify') return fail(res, 400, 'bad_request');
  if (await limited(req, res, 'secondFactor', [`staff:${sha256(String(body.challenge ?? ''))}`])) return;

  const challenge = await findChallenge(body.challenge, 'staff', 'login');
  if (!challenge) return fail(res, 401, 'challenge_expired');
  const { data: user, error } = await db()
    .from(T.staffUsers)
    .select(STAFF_AUTH_COLUMNS)
    .eq('id', challenge.subject_id)
    .maybeSingle();
  if (error) throw error;
  if (!user || !hasDashboardAccess(user)) {
    await deleteChallenge(challenge);
    return fail(res, 403, 'no_access');
  }

  let passed = false;
  switch (body.method) {
    case 'totp':
      passed = Boolean(user.totp_secret) && verifyTotp(body.code, user.totp_secret);
      break;
    case 'backup':
      passed = await spendStaffBackupCode(user.id, body.code);
      break;
    case 'passkey-options': {
      const options = await authenticationOptions('staff', user.id);
      if (!options) return fail(res, 400, 'no_passkeys');
      return ok(res, { options });
    }
    case 'passkey':
      passed = await finishAuthentication('staff', user.id, body.response);
      break;
    default:
      return fail(res, 400, 'bad_request');
  }

  if (!passed) {
    await failChallengeAttempt(challenge);
    await audit(req, { action: 'staff.login_failed', actorType: 'staff', actorId: user.id, details: { method: body.method } });
    return fail(res, 401, 'code_wrong');
  }

  await deleteChallenge(challenge);
  await createStaffSession(res, user.id);
  await audit(req, { action: 'staff.login', actorType: 'staff', actorId: user.id, details: { method: body.method } });
  ok(res, { staff: publicStaff(user) });
});
