// POST   /api/me/avatar { image }   set the signed-in owner's profile picture
// DELETE /api/me/avatar             remove it
//
// image is a base64 data URL. The browser sends a cropped WebP; the server
// re-encodes it anyway (api/_lib/avatar.js). Answers carry the editor view.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit, refusedForBan } from '../_lib/guards.js';
import { requireOwner } from '../_lib/session.js';
import { loadOwnerView } from '../_lib/owner-view.js';
import { prepareAvatar, storeAvatar, deleteAvatarFile, MAX_UPLOAD_BYTES } from '../_lib/avatar.js';

export default route('me/avatar', async (request, response) => {
  if (guard(request, response, ['POST', 'DELETE'])) return;
  const owner = await requireOwner(request, response);
  if (!owner) return;
  const page = owner.page;
  if (await limited(request, response, 'avatar', [`page:${page.id}`])) return;
  if (await refusedForBan(request, response, { pageId: owner.page.id })) return;

  const previous = page.avatar_path || null;

  if (request.method === 'DELETE') {
    const { error } = await database().from(TABLES.pages).update({ avatar_path: null }).eq('id', page.id);
    if (error) throw error;
    await deleteAvatarFile(previous);
    await audit(request, { action: 'page.avatar_removed', actorType: 'owner', actorId: page.id, pageId: page.id });
    return ok(response, { page: await loadOwnerView(page.id) });
  }

  const body = await readJson(request, response, { maxBytes: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024 });
  if (!body) return;
  const prepared = await prepareAvatar(body.image);
  if (!prepared.ok) return fail(response, 400, prepared.error);

  const path = await storeAvatar(page.id, prepared.buffer);
  const { error } = await database().from(TABLES.pages).update({ avatar_path: path }).eq('id', page.id);
  if (error) {
    await deleteAvatarFile(path);
    throw error;
  }
  await deleteAvatarFile(previous);
  await audit(request, { action: 'page.avatar_changed', actorType: 'owner', actorId: page.id, pageId: page.id, details: { bytes: prepared.buffer.length } });
  ok(response, { page: await loadOwnerView(page.id) });
});
