// GET   /api/detections/:id - one detection (signed-in users)
// PATCH /api/detections/:id - record an analysis/review result
//   Allowed for: admin/officer users, or the AI analysis service via header X-Analysis-Key.
//   Body: { "threatStatus": "CLEAR|SUSPICIOUS|THREAT|PENDING", "detectionType": "NONE|NARCOTICS|...",
//           "confidence": 0.0-1.0 | null, "model": "...", "notes": "..." }

import { HttpError, json, readBody, route } from '../../lib/http.js';
import { COLLECTIONS, getDb } from '../../lib/mongodb.js';
import { hasValidAnalysisKey, requireUser } from '../../lib/auth.js';
import { DETECTION_TYPES, THREAT_STATUSES } from '../../lib/analysis.js';
import { serializeDetection } from '../../lib/records.js';
import { parseConfidence, parseEnum, parseObjectId } from '../../lib/validation.js';

function detectionIdFrom(request) {
  const url = new URL(request.url);
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  return parseObjectId(last === '[id]' ? url.searchParams.get('id') : last, 'Detection not found');
}

function optionalText(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `"${field}" must be text of at most ${max} characters`);
  return value.trim();
}

export const GET = route(async (request) => {
  requireUser(request);
  const _id = detectionIdFrom(request);
  const db = await getDb();
  const doc = await db.collection(COLLECTIONS.detections).findOne({ _id });
  if (!doc) throw new HttpError(404, 'Detection not found');
  return json(serializeDetection(doc));
});

export const PATCH = route(async (request) => {
  const fromService = hasValidAnalysisKey(request);
  const user = fromService ? null : requireUser(request, ['admin', 'officer']);
  const _id = detectionIdFrom(request);

  const body = await readBody(request, 8 * 1024);
  const threatStatus = parseEnum(body.threatStatus, 'threatStatus', THREAT_STATUSES);
  const detectionType = parseEnum(body.detectionType, 'detectionType', DETECTION_TYPES);
  if (!threatStatus && !detectionType) throw new HttpError(400, 'Provide threatStatus and/or detectionType');

  const set = {
    'analysis.status': threatStatus === 'PENDING' ? 'NOT_ANALYZED' : 'ANALYZED',
    'analysis.source': fromService ? 'ai' : 'manual',
    'analysis.model': optionalText(body.model, 'model', 64),
    'analysis.notes': optionalText(body.notes, 'notes', 500),
    'analysis.analyzedAt': new Date(),
    'analysis.reviewedBy': user ? user.username : null,
  };
  if (threatStatus) set.threatStatus = threatStatus;
  if (detectionType) set.detectionType = detectionType;
  if (Object.hasOwn(body, 'confidence')) set.confidence = parseConfidence(body.confidence);

  const db = await getDb();
  const result = await db
    .collection(COLLECTIONS.detections)
    .findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
  const doc = result && Object.hasOwn(result, 'value') && Object.hasOwn(result, 'ok') ? result.value : result;
  if (!doc) throw new HttpError(404, 'Detection not found');
  return json({ success: true, detection: serializeDetection(doc) });
});
