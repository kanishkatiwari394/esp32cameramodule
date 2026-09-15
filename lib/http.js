// Small helpers shared by every Vercel API function (Web-standard Request/Response).

export class HttpError extends Error {
  constructor(status, message, details, headers) {
    super(message);
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** Wraps a handler so thrown HttpErrors become JSON responses and unexpected errors never leak internals. */
export function route(handler) {
  return async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof HttpError) {
        const body = { success: false, error: err.message };
        if (err.details) body.details = err.details;
        return json(body, err.status, err.headers);
      }
      console.error('[api] unhandled error:', err);
      return json({ success: false, error: 'Internal server error' }, 500);
    }
  };
}

/** Reads a small JSON (or urlencoded) body with a hard size limit. */
export async function readBody(request, maxBytes = 16 * 1024) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'Request body too large');
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new HttpError(413, 'Request body too large');
  if (!raw.trim()) return {};

  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return data;
}

/** Client IP as reported by Vercel's edge (x-real-ip / x-forwarded-for are set by Vercel, not the client). */
export function getClientIp(request) {
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}
