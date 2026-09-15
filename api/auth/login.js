// POST /api/auth/login  { identifier, password, remember }
// "identifier" is the Officer / Driver ID (username) or email from the login page.

import { HttpError, getClientIp, json, readBody, route } from '../../lib/http.js';
import { COLLECTIONS, getDb } from '../../lib/mongodb.js';
import { ensureBootstrapAdmin, publicUser, sessionCookie, signSession, verifyPassword } from '../../lib/auth.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';

export const POST = route(async (request) => {
  const body = await readBody(request, 8 * 1024);
  const rawId = body.identifier ?? body.username ?? body.email;
  const identifier = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const remember = body.remember === true || body.remember === 'true';

  if (!identifier || !password) throw new HttpError(400, 'Officer / Driver ID and password are required');
  if (identifier.length > 254 || password.length > 256) throw new HttpError(400, 'Invalid ID or password');

  const db = await getDb();
  const tooMany = 'Too many login attempts. Please wait 15 minutes and try again.';
  await enforceRateLimit(db, { key: `login-ip:${getClientIp(request)}`, limit: 30, windowSeconds: 900 }, tooMany);
  await enforceRateLimit(db, { key: `login-id:${identifier}`, limit: 10, windowSeconds: 900 }, tooMany);

  await ensureBootstrapAdmin(db);

  const users = db.collection(COLLECTIONS.users);
  const user = await users.findOne({ $or: [{ username: identifier }, { email: identifier }] });
  const passwordOk = await verifyPassword(password, user?.passwordHash);

  if (!user || !passwordOk) throw new HttpError(401, 'Invalid ID or password');
  if (user.isActive === false) throw new HttpError(403, 'This account has been disabled. Contact the administrator.');

  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  const { token, maxAgeSeconds } = signSession(user, { remember });
  return json(
    { success: true, user: publicUser(user), redirect: '/page2.html' },
    200,
    { 'Set-Cookie': sessionCookie(request, token, remember ? maxAgeSeconds : null) },
  );
});
