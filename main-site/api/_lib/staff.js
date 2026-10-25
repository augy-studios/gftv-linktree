// Staff accounts: gftvhello_users, read only. Sessions live in
// gftvonelink_staff_sessions so this site never ends, or is ended by, a
// session on gftv.asia or any other GFTV site (careers-gftv migration 038).
//
// Who gets in: is_approved, and is_admin or is_editor. Editors moderate
// (reports, links); admins also ban pages, edit the block lists and read the
// audit log.

import { db, T } from './supabase.js';
import { randomToken, sha256 } from './crypto.js';
import { readCookie, setCookie, clearCookie, fail } from './http.js';

export const STAFF_COOKIE = '__Host-olg_staff';
const STAFF_SESSION_HOURS = 12;

// Never totp_secret, password_hash or email through this list.
const STAFF_COLUMNS = 'id, username, display_name, is_admin, is_editor, is_approved';

export function hasDashboardAccess(user) {
  return Boolean(user && user.is_approved === true && (user.is_admin === true || user.is_editor === true));
}

export async function createStaffSession(res, staffUserId) {
  const token = randomToken(32);
  const { error } = await db().from(T.staffSessions).insert({
    staff_user_id: staffUserId,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + STAFF_SESSION_HOURS * 3600_000).toISOString(),
  });
  if (error) throw error;
  setCookie(res, STAFF_COOKIE, token, STAFF_SESSION_HOURS * 3600);
}

export async function currentStaff(req) {
  const token = readCookie(req, STAFF_COOKIE);
  if (!token) return null;
  const { data, error } = await db()
    .from(T.staffSessions)
    .select(`id, expires_at, user:${T.staffUsers} ( ${STAFF_COLUMNS} )`)
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.user) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await db().from(T.staffSessions).delete().eq('id', data.id);
    return null;
  }
  // Access is re-checked on every request, so revoking a role on gftv.asia
  // takes effect here on the next click rather than at the next sign in.
  if (!hasDashboardAccess(data.user)) return null;
  return { sessionId: data.id, user: data.user };
}

export async function requireStaff(req, res, { admin = false } = {}) {
  const staff = await currentStaff(req);
  if (!staff) {
    fail(res, 401, 'signed_out');
    return null;
  }
  if (admin && staff.user.is_admin !== true) {
    fail(res, 403, 'admin_only');
    return null;
  }
  return staff;
}

export async function endStaffSession(req, res) {
  const token = readCookie(req, STAFF_COOKIE);
  if (token) await db().from(T.staffSessions).delete().eq('token_hash', sha256(token));
  clearCookie(res, STAFF_COOKIE);
}

export function publicStaff(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.is_admin ? 'admin' : 'editor',
  };
}
