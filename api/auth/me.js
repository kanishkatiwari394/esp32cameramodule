// GET /api/auth/me - used by protected pages to confirm the session is valid.

import { ObjectId } from 'mongodb';
import { HttpError, json, route } from '../../lib/http.js';
import { COLLECTIONS, getDb } from '../../lib/mongodb.js';
import { clearSessionCookie, publicUser, requireUser } from '../../lib/auth.js';

export const GET = route(async (request) => {
  const session = requireUser(request);
  if (!ObjectId.isValid(session.id)) throw new HttpError(401, 'Session expired or invalid');

  const db = await getDb();
  const user = await db.collection(COLLECTIONS.users).findOne({ _id: new ObjectId(session.id) });
  if (!user || user.isActive === false) {
    return json({ success: false, error: 'Account not found or disabled' }, 401, { 'Set-Cookie': clearSessionCookie(request) });
  }
  return json({ success: true, user: publicUser(user) });
});
