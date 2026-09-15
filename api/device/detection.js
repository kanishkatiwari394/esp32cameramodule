// POST /api/device/detection
// Called by the ESP32-CAM over HTTPS. multipart/form-data with:
//   image (JPEG/PNG file), rfidUid, readerId, deviceId, platform, [timestamp], [wifiSignal]
// Header: X-Device-Key

import { waitUntil } from '@vercel/functions';
import { HttpError, json, route } from '../../lib/http.js';
import { COLLECTIONS, getDb } from '../../lib/mongodb.js';
import { assertDeviceAllowed, authenticateDevice } from '../../lib/auth.js';
import { deleteImage, uploadDetectionImage } from '../../lib/cloudinary.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';
import { initialAnalysisFields, requestAnalysis } from '../../lib/analysis.js';
import { notifyDetection } from '../../lib/telegram.js';
import { serializeDetection, touchDevice } from '../../lib/records.js';
import {
  MAX_IMAGE_BYTES,
  MAX_MULTIPART_BYTES,
  MIN_IMAGE_BYTES,
  detectImageType,
  parseDeviceId,
  parseDeviceTimestamp,
  parsePlatform,
  parseReaderId,
  parseRfidUid,
  parseWifiSignal,
} from '../../lib/validation.js';

export const POST = route(async (request) => {
  // 1. Authenticate the device before reading the (larger) body.
  const deviceAuth = authenticateDevice(request);

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    throw new HttpError(415, 'Content-Type must be multipart/form-data');
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
    throw new HttpError(413, `Image too large (max ${MAX_IMAGE_BYTES} bytes)`);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'Malformed multipart/form-data body');
  }

  // 2. Validate text fields.
  const now = new Date();
  const deviceId = parseDeviceId(form.get('deviceId'));
  const rfidUid = parseRfidUid(form.get('rfidUid'));
  const readerId = parseReaderId(form.get('readerId'));
  const platform = parsePlatform(form.get('platform'));
  const wifiSignal = parseWifiSignal(form.get('wifiSignal'));
  const { timestamp, source: timestampSource } = parseDeviceTimestamp(form.get('timestamp'), now);
  assertDeviceAllowed(deviceAuth, deviceId);

  // 3 + 4. Validate the image: must be a real file, sane size, JPEG/PNG by magic bytes.
  const image = form.get('image');
  if (!image || typeof image === 'string') throw new HttpError(400, 'Missing "image" file field');
  if (image.size > MAX_IMAGE_BYTES) throw new HttpError(413, `Image too large (max ${MAX_IMAGE_BYTES} bytes)`);
  if (image.size < MIN_IMAGE_BYTES) throw new HttpError(400, `Image too small (${image.size} bytes) - capture probably failed`);
  const buffer = Buffer.from(await image.arrayBuffer());
  const imageType = detectImageType(buffer);
  if (!imageType) throw new HttpError(415, 'Image must be a JPEG or PNG file');

  const db = await getDb();
  await enforceRateLimit(
    db,
    { key: `upload:${deviceId}`, limit: 30, windowSeconds: 60 },
    'Upload rate limit exceeded for this device (max 30 per minute)',
  );

  // 5. Upload to Cloudinary.
  const upload = await uploadDetectionImage(buffer, { deviceId, readerId, rfidUid });

  // 6. Store only the URL + metadata in MongoDB (never the image bytes).
  const doc = {
    rfidUid,
    readerId,
    platform,
    deviceId,
    imageUrl: upload.url,
    imagePublicId: upload.publicId,
    image: { width: upload.width, height: upload.height, bytes: upload.bytes, format: upload.format ?? imageType.format },
    ...initialAnalysisFields(),
    timestamp,
    timestampSource,
    createdAt: now,
  };

  try {
    const { insertedId } = await db.collection(COLLECTIONS.detections).insertOne(doc);
    doc._id = insertedId;
  } catch (err) {
    console.error('[detection] insert failed, removing orphaned image:', err.message);
    await deleteImage(upload.publicId).catch((e) => console.error('[detection] rollback failed:', e.message));
    throw new HttpError(503, 'Could not save detection to the database');
  }

  try {
    await touchDevice(db, { deviceId, wifiSignal }, now);
  } catch (err) {
    console.error('[detection] device status update failed:', err.message); // the detection itself is saved
  }

  const detection = serializeDetection(doc);
  // Optional side effects run after the response so the ESP32 isn't kept waiting.
  waitUntil(Promise.allSettled([notifyDetection(detection), requestAnalysis(detection, new URL(request.url).origin)]));

  // 7. JSON result for the ESP32.
  return json({
    success: true,
    eventId: detection.id,
    imageUrl: detection.imageUrl,
    threatStatus: detection.threatStatus,
    detectionType: detection.detectionType,
    timestamp: detection.timestamp,
    message: 'Detection recorded successfully',
  });
});
