import { MongoClient } from 'mongodb';
import { attachDatabasePool } from '@vercel/functions';
import { HttpError } from './http.js';

export const COLLECTIONS = {
  users: 'users',
  detections: 'detections',
  devices: 'devices',
  rateLimits: 'rate_limits',
};

// Cached across invocations of the same warm function instance.
let clientPromise;
let indexesPromise;

function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new HttpError(500, 'Server is not configured: MONGODB_URI is missing');

  const client = new MongoClient(uri, {
    appName: 'raksha-rail',
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
  });
  try {
    // Lets Vercel Fluid compute release idle connections before the instance suspends.
    attachDatabasePool(client);
  } catch (err) {
    console.warn('[mongodb] attachDatabasePool unavailable:', err.message);
  }
  return client.connect();
}

export async function getDb() {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = undefined;
      throw err;
    });
  }

  let client;
  try {
    client = await clientPromise;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('[mongodb] connection failed:', err.message);
    throw new HttpError(503, 'Database connection failed');
  }

  const db = client.db(process.env.MONGODB_DB || 'raksha_rail');
  if (!indexesPromise) {
    indexesPromise = ensureIndexes(db).catch((err) => {
      indexesPromise = undefined;
      console.error('[mongodb] index creation failed:', err.message);
    });
  }
  await indexesPromise;
  return db;
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection(COLLECTIONS.users).createIndexes([
      { key: { username: 1 }, name: 'username_unique', unique: true },
      {
        key: { email: 1 },
        name: 'email_unique',
        unique: true,
        partialFilterExpression: { email: { $type: 'string' } },
      },
    ]),
    db.collection(COLLECTIONS.detections).createIndexes([
      { key: { createdAt: -1, _id: -1 }, name: 'created_desc' },
      { key: { timestamp: -1, _id: -1 }, name: 'timestamp_desc' },
      { key: { rfidUid: 1, timestamp: -1 }, name: 'rfid_timestamp' },
      { key: { readerId: 1, timestamp: -1 }, name: 'reader_timestamp' },
      { key: { platform: 1, timestamp: -1 }, name: 'platform_timestamp' },
      { key: { deviceId: 1, timestamp: -1 }, name: 'device_timestamp' },
      { key: { threatStatus: 1 }, name: 'threat_status' },
    ]),
    db.collection(COLLECTIONS.devices).createIndexes([
      { key: { deviceId: 1 }, name: 'deviceId_unique', unique: true },
      { key: { lastSeen: -1 }, name: 'last_seen_desc' },
    ]),
    db.collection(COLLECTIONS.rateLimits).createIndexes([
      { key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
    ]),
  ]);
}

/** Only for CLI scripts that must exit cleanly. */
export async function closeDb() {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = undefined;
  indexesPromise = undefined;
  if (client) await client.close();
}
