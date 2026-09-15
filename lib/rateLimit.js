import { COLLECTIONS } from './mongodb.js';
import { HttpError } from './http.js';

/**
 * Fixed-window counter stored in MongoDB. In-memory counters don't work on serverless
 * (every instance has its own memory), so the counter lives in the shared database.
 * Old windows are removed automatically by the TTL index on expiresAt.
 */
export async function consumeRateLimit(db, { key, limit, windowSeconds }) {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const id = `${key}:${windowStart}`;
  const collection = db.collection(COLLECTIONS.rateLimits);

  const increment = () =>
    collection.findOneAndUpdate(
      { _id: id },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs + 60_000) } },
      { upsert: true, returnDocument: 'after' },
    );

  let result;
  try {
    result = await increment();
  } catch (err) {
    // Two concurrent upserts for a brand-new window can collide once; the retry updates the winner's doc.
    if (err?.code !== 11000) throw err;
    result = await increment();
  }

  // mongodb driver v5 returns { value }, v6+ returns the document itself.
  const doc = result && Object.hasOwn(result, 'value') && Object.hasOwn(result, 'ok') ? result.value : result;
  const count = doc?.count ?? 1;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  };
}

export async function enforceRateLimit(db, options, message = 'Too many requests, please slow down') {
  const result = await consumeRateLimit(db, options);
  if (!result.allowed) {
    throw new HttpError(429, message, undefined, { 'Retry-After': String(result.retryAfterSeconds) });
  }
  return result;
}
