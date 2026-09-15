// POST /api/auth/logout - clears the session cookie.

import { json, route } from '../../lib/http.js';
import { clearSessionCookie } from '../../lib/auth.js';

export const POST = route(async (request) =>
  json({ success: true }, 200, { 'Set-Cookie': clearSessionCookie(request) }),
);
