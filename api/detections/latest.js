// GET /api/detections/latest - the most recently received detection, or null if none exist yet.

import { json, route } from '../../lib/http.js';
import { COLLECTIONS, getDb } from '../../lib/mongodb.js';
import { requireUser } from '../../lib/auth.js';
import { serializeDetection } from '../../lib/records.js';

export const GET = route(async (request) => {
  requireUser(request);
  const db = await getDb();
  const doc = await db.collection(COLLECTIONS.detections).find({}).sort({ createdAt: -1, _id: -1 }).limit(1).next();
  return json(serializeDetection(doc));
});
