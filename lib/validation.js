import { isIP } from 'node:net';
import { ObjectId } from 'mongodb';
import { HttpError } from './http.js';
import { getTimeZone, zonedMidnight } from './time.js';

// Vercel rejects request bodies above 4.5 MB, so stay well below it.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MIN_IMAGE_BYTES = 128;
export const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const READER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const PLATFORM_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,63}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Coerces a form/JSON/query value to a trimmed string.
 * Returns '' when absent and null when the value is not text (arrays, objects, files),
 * so user input can never smuggle MongoDB operators like {"$ne": ""} into a filter.
 */
function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return String(value).trim();
}

function patternField(value, field, pattern, hint, required) {
  const v = text(value);
  if (v === null) throw new HttpError(400, `"${field}" must be a text value`);
  if (!v) {
    if (required) throw new HttpError(400, `"${field}" is required`);
    return null;
  }
  if (!pattern.test(v)) throw new HttpError(400, `"${field}" is invalid (${hint})`);
  return v;
}

export function parseDeviceId(value, required = true) {
  return patternField(value, 'deviceId', DEVICE_ID_RE, 'letters, digits, _ . - ; max 64 chars', required);
}

export function parseReaderId(value, required = true) {
  return patternField(value, 'readerId', READER_ID_RE, 'letters, digits, _ . - ; max 32 chars, e.g. RFID-1', required);
}

export function parsePlatform(value, required = true) {
  const v = text(value);
  return patternField(v === null ? v : v.replace(/\s+/g, ' '), 'platform', PLATFORM_RE, 'letters, digits, spaces, _ . - ; max 40 chars', required);
}

export function parseName(value, field) {
  return patternField(value, field, NAME_RE, 'letters, digits, spaces, _ . ( ) - ; max 64 chars', false);
}

/** "a1 b2-c3:d4" -> "A1:B2:C3:D4". Accepts 4-10 byte UIDs (MFRC522 4/7/10 byte, EM4100 5 byte). */
export function normalizeRfidUid(value) {
  const v = text(value);
  if (!v) return null;
  const hex = v.replace(/[\s:-]/g, '').toUpperCase();
  if (!/^(?:[0-9A-F]{2}){4,10}$/.test(hex)) return null;
  return hex.match(/.{2}/g).join(':');
}

export function parseRfidUid(value, required = true) {
  const v = text(value);
  if (v === null) throw new HttpError(400, '"rfidUid" must be a text value');
  if (!v) {
    if (required) throw new HttpError(400, '"rfidUid" is required');
    return null;
  }
  const uid = normalizeRfidUid(v);
  if (!uid) throw new HttpError(400, '"rfidUid" is invalid (expected 4-10 hex bytes, e.g. A1:B2:C3:D4)');
  return uid;
}

export function parseWifiSignal(value) {
  const v = text(value);
  if (v === null) throw new HttpError(400, '"wifiSignal" must be a number');
  if (!v) return null;
  const n = Number(v);
  if (!/^-?\d{1,3}$/.test(v) || n < -127 || n > 0) {
    throw new HttpError(400, '"wifiSignal" must be an integer RSSI between -127 and 0 dBm');
  }
  return n;
}

export function parseIpAddress(value) {
  const v = text(value);
  if (v === null) throw new HttpError(400, '"ipAddress" must be a text value');
  if (!v) return null;
  if (v.length > 45 || !isIP(v)) throw new HttpError(400, '"ipAddress" must be a valid IPv4 or IPv6 address');
  return v;
}

/**
 * Optional device clock value. ESP32 clocks are only right after NTP sync, so an unparseable
 * or implausible timestamp falls back to server time instead of rejecting the capture.
 */
export function parseDeviceTimestamp(value, now = new Date()) {
  const v = text(value);
  let ms = NaN;
  if (v && /^\d{10}$/.test(v)) ms = Number(v) * 1000;
  else if (v && /^\d{13}$/.test(v)) ms = Number(v);
  else if (v && ISO_TIMESTAMP_RE.test(v)) ms = Date.parse(v);

  const nowMs = now.getTime();
  const plausible = Number.isFinite(ms) && ms >= nowMs - 24 * 3600 * 1000 && ms <= nowMs + 2 * 60 * 1000;
  return plausible ? { timestamp: new Date(ms), source: 'device' } : { timestamp: now, source: 'server' };
}

/** Query date: YYYY-MM-DD (local day in APP_TIMEZONE) or a full ISO-8601 timestamp. */
export function parseDateParam(value, field, { endOfDay = false } = {}) {
  const v = text(value);
  if (v === null) throw new HttpError(400, `"${field}" must be a text value`);
  if (!v) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw new HttpError(400, `"${field}" is not a real calendar date`);
    }
    const start = zonedMidnight(year, month, day, getTimeZone());
    // endOfDay returns the next midnight; callers use it as an exclusive upper bound.
    return endOfDay ? { date: new Date(start.getTime() + 24 * 3600 * 1000), exclusive: true } : { date: start, exclusive: false };
  }
  if (ISO_TIMESTAMP_RE.test(v) && Number.isFinite(Date.parse(v))) {
    return { date: new Date(Date.parse(v)), exclusive: false };
  }
  throw new HttpError(400, `"${field}" must be YYYY-MM-DD or an ISO-8601 timestamp with time zone`);
}

export function parseIntParam(value, field, { def, min, max }) {
  if (value === null || value === undefined || value === '') return def;
  if (typeof value !== 'string' || !/^\d{1,7}$/.test(value)) {
    throw new HttpError(400, `"${field}" must be a whole number`);
  }
  const n = Number(value);
  if (n < min || n > max) throw new HttpError(400, `"${field}" must be between ${min} and ${max}`);
  return n;
}

export function parseEnum(value, field, allowed, required = false) {
  const v = text(value);
  if (v === null) throw new HttpError(400, `"${field}" must be a text value`);
  if (!v) {
    if (required) throw new HttpError(400, `"${field}" is required`);
    return null;
  }
  const upper = v.toUpperCase();
  if (!allowed.includes(upper)) throw new HttpError(400, `"${field}" must be one of: ${allowed.join(', ')}`);
  return upper;
}

/** Confidence is a probability in [0, 1] or null when no model produced it. */
export function parseConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, '"confidence" must be a number between 0 and 1, or null');
  return n;
}

export function parseObjectId(value, notFoundMessage = 'Not found') {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new HttpError(404, notFoundMessage);
  return new ObjectId(value);
}

/** Identifies the real file type from its first bytes instead of trusting the declared MIME type. */
export function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { format: 'jpg', mimeType: 'image/jpeg' };
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length >= 8 && pngSignature.every((byte, i) => buffer[i] === byte)) {
    return { format: 'png', mimeType: 'image/png' };
  }
  return null;
}

export function normalizeUsername(value) {
  const v = text(value);
  if (!v) return null;
  const lower = v.toLowerCase();
  return USERNAME_RE.test(lower) ? lower : null;
}

export function normalizeEmail(value) {
  const v = text(value);
  if (!v) return null;
  const lower = v.toLowerCase();
  return lower.length <= 254 && EMAIL_RE.test(lower) ? lower : null;
}
