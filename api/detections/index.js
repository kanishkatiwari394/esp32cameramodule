// GET /api/detections?page=1&limit=20&readerId=RFID-1&rfidUid=A1:B2:C3:D4&platform=Platform%201
//                    &deviceId=ESP32-CAM-01&threatStatus=PENDING&fromDate=2026-09-01&toDate=2026-09-12

import { json, route } from '../../lib/http.js';
import { COLLECTIONS, getDb } from '../../lib/mongodb.js';
import { requireUser } from '../../lib/auth.js';
import { THREAT_STATUSES } from '../../lib/analysis.js';
import { serializeDetection } from '../../lib/records.js';
import {
  parseDateParam,
  parseDeviceId,
  parseEnum,
  parseIntParam,
  parsePlatform,
  parseReaderId,
  parseRfidUid,
} from '../../lib/validation.js';

export const GET = route(async (request) => {
  requireUser(request);
  const params = new URL(request.url).searchParams;

  const page = parseIntParam(params.get('page'), 'page', { def: 1, min: 1, max: 100000 });
  const limit = parseIntParam(params.get('limit'), 'limit', { def: 20, min: 1, max: 100 });

  // Every filter value is validated to a plain string, so no query operators can be injected.
  const filter = {};
  const readerId = parseReaderId(params.get('readerId'), false);
  const rfidUid = parseRfidUid(params.get('rfidUid'), false);
  const platform = parsePlatform(params.get('platform'), false);
  const deviceId = parseDeviceId(params.get('deviceId'), false);
  const threatStatus = parseEnum(params.get('threatStatus'), 'threatStatus', THREAT_STATUSES);
  if (readerId) filter.readerId = readerId;
  if (rfidUid) filter.rfidUid = rfidUid;
  if (platform) filter.platform = platform;
  if (deviceId) filter.deviceId = deviceId;
  if (threatStatus) filter.threatStatus = threatStatus;

  const from = parseDateParam(params.get('fromDate'), 'fromDate');
  const to = parseDateParam(params.get('toDate'), 'toDate', { endOfDay: true });
  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = from.date;
    if (to) filter.timestamp[to.exclusive ? '$lt' : '$lte'] = to.date;
  }

  const db = await getDb();
  const detections = db.collection(COLLECTIONS.detections);
  const [total, docs] = await Promise.all([
    detections.countDocuments(filter),
    detections.find(filter).sort({ timestamp: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
  ]);

  return json({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    items: docs.map(serializeDetection),
  });
});
