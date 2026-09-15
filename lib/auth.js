import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';
import { COLLECTIONS } from './mongodb.js';
import { normalizeEmail, normalizeUsername } from './validation.js';

export const SESSION_COOKIE = 'rr_session';
export const ROLES = ['admin', 'officer', 'operator'];

const BCRYPT_ROUNDS = 12;
const JWT_ISSUER = 'raksha-rail';
const JWT_AUDIENCE = 'raksha-rail-dashboard';
const REMEMBER_ME_HOURS = 24 * 7;

// ======================= Passwords =======================

export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

let dummyHashPromise;

/** Always runs one bcrypt comparison so response time doesn't reveal whether an ID exists. */
export async function verifyPassword(password, passwordHash) {
  if (typeof passwordHash !== 'string' || !passwordHash) {
    dummyHashPromise ??= bcrypt.hash('raksha-rail-timing-equalizer', BCRYPT_ROUNDS);
    await bcrypt.compare(password, await dummyHashPromise);
    return false;
  }
  return bcrypt.compare(password, passwordHash);
}

export async function buildUserDocument({ username, email, password, role }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error('Username must be 3-64 characters: letters, digits, . _ -');
  const normalizedEmail = email ? normalizeEmail(email) : null;
  if (email && !normalizedEmail) throw new Error('Invalid email address');
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  if (typeof password !== 'string' || password.length < 10 || password.length > 72) {
    throw new Error('Password must be 10-72 characters');
  }
  return {
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash: await hashPassword(password),
    role,
    isActive: true,
    createdAt: new Date(),
  };
}

/**
 * Creates the first admin from BOOTSTRAP_ADMIN_* env vars, but only while the users
 * collection is completely empty. After that, add users with `npm run create-user`.
 */
export async function ensureBootstrapAdmin(db) {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return;

  const users = db.collection(COLLECTIONS.users);
  if ((await users.countDocuments({}, { limit: 1 })) > 0) return;

  try {
    const doc = await buildUserDocument({
      username,
      email: process.env.BOOTSTRAP_ADMIN_EMAIL || null,
      password,
      role: 'admin',
    });
    await users.insertOne(doc);
    console.log(`[auth] bootstrap admin "${doc.username}" created`);
  } catch (err) {
    if (err?.code === 11000) return; // another instance created it at the same moment
    console.error('[auth] bootstrap admin not created:', err.message);
  }
}

export function publicUser(user) {
  return { id: String(user._id), username: user.username, email: user.email ?? null, role: user.role };
}

// ======================= Sessions (JWT in HttpOnly cookie) =======================

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(500, 'Server is not configured: JWT_SECRET must be at least 32 characters');
  }
  return secret;
}

function sessionHours() {
  const n = Number(process.env.SESSION_HOURS);
  return Number.isFinite(n) && n >= 1 && n <= 168 ? n : 12;
}

export function signSession(user, { remember = false } = {}) {
  const hours = remember ? REMEMBER_ME_HOURS : sessionHours();
  const token = jwt.sign(
    { sub: String(user._id), username: user.username, role: user.role },
    getJwtSecret(),
    { algorithm: 'HS256', expiresIn: `${hours}h`, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  );
  return { token, maxAgeSeconds: hours * 3600 };
}

function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isHttps(request) {
  const proto = request.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  return new URL(request.url).protocol === 'https:';
}

/** maxAgeSeconds = null creates a browser-session cookie (cleared when the browser closes). */
export function sessionCookie(request, token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isHttps(request)) parts.push('Secure');
  if (maxAgeSeconds) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function clearSessionCookie(request) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(request)) parts.push('Secure');
  return parts.join('; ');
}

/** Returns the signed-in user from the session cookie, or throws 401/403. */
export function requireUser(request, allowedRoles) {
  const secret = getJwtSecret();
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'Authentication required');

  let claims;
  try {
    claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
  } catch {
    throw new HttpError(401, 'Session expired or invalid');
  }
  if (allowedRoles && !allowedRoles.includes(claims.role)) {
    throw new HttpError(403, 'Your role is not allowed to perform this action');
  }
  return { id: claims.sub, username: claims.username, role: claims.role };
}

// ======================= Device + service API keys =======================

function secretsEqual(a, b) {
  // Hashing first gives equal-length buffers, so timingSafeEqual never throws and length isn't leaked.
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function perDeviceKeys() {
  const map = new Map();
  for (const entry of (process.env.DEVICE_KEYS || '').split(',')) {
    const index = entry.indexOf(':');
    if (index <= 0) continue;
    const deviceId = entry.slice(0, index).trim();
    const key = entry.slice(index + 1).trim();
    if (deviceId && key) map.set(deviceId, key);
  }
  return map;
}

/**
 * Step 1 (before reading the body): checks the X-Device-Key header against DEVICE_API_KEY
 * and DEVICE_KEYS. Returns which deviceId the key is bound to (null for the shared key).
 */
export function authenticateDevice(request) {
  const shared = process.env.DEVICE_API_KEY || '';
  const dedicated = perDeviceKeys();
  if (shared.length < 16 && dedicated.size === 0) {
    throw new HttpError(500, 'Server is not configured: DEVICE_API_KEY must be at least 16 characters');
  }

  const provided = request.headers.get('x-device-key');
  if (!provided) throw new HttpError(401, 'Missing X-Device-Key header');

  let boundDeviceId = null;
  for (const [deviceId, key] of dedicated) {
    if (secretsEqual(provided, key)) boundDeviceId = deviceId;
  }
  if (boundDeviceId) return { boundDeviceId };
  if (shared.length >= 16 && secretsEqual(provided, shared)) return { boundDeviceId: null };
  throw new HttpError(401, 'Invalid device key');
}

/** Step 2 (after the body is parsed): the key must be allowed to act as this deviceId. */
export function assertDeviceAllowed(deviceAuth, deviceId) {
  if (deviceAuth.boundDeviceId) {
    if (deviceAuth.boundDeviceId !== deviceId) throw new HttpError(403, 'This device key does not belong to that deviceId');
    return;
  }
  if (perDeviceKeys().has(deviceId)) throw new HttpError(403, 'This deviceId must use its dedicated device key');
}

/** For the optional AI analysis service calling back with results. */
export function hasValidAnalysisKey(request) {
  const expected = process.env.ANALYSIS_API_KEY || '';
  const provided = request.headers.get('x-analysis-key');
  return expected.length >= 16 && Boolean(provided) && secretsEqual(provided, expected);
}
