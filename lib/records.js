import { COLLECTIONS } from './mongodb.js';

// ======================= Detections =======================

/** Small Cloudinary-transformed preview for history tables (original stays untouched). */
export function thumbnailUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://res.cloudinary.com/')) return url ?? null;
  return url.replace('/image/upload/', '/image/upload/c_fill,w_160,h_120,q_auto,f_auto/');
}

export function serializeDetection(doc) {
  if (!doc) return null;
  const id = String(doc._id);
  return {
    id,
    eventId: id,
    rfidUid: doc.rfidUid,
    readerId: doc.readerId,
    platform: doc.platform,
    deviceId: doc.deviceId,
    imageUrl: doc.imageUrl,
    thumbnailUrl: thumbnailUrl(doc.imageUrl),
    imagePublicId: doc.imagePublicId,
    threatStatus: doc.threatStatus,
    detectionType: doc.detectionType,
    confidence: doc.confidence ?? null,
    analysisStatus: doc.analysis?.status ?? (doc.threatStatus === 'PENDING' ? 'NOT_ANALYZED' : 'ANALYZED'),
    analysisSource: doc.analysis?.source ?? null,
    timestamp: doc.timestamp?.toISOString?.() ?? null,
    createdAt: doc.createdAt?.toISOString?.() ?? null,
  };
}

// ======================= Devices =======================

export function offlineAfterSeconds() {
  const n = Number(process.env.DEVICE_OFFLINE_AFTER_SECONDS);
  return Number.isFinite(n) && n >= 15 ? n : 90;
}

/** ONLINE only if the device communicated recently; the stored status alone can be stale. */
export function effectiveDeviceStatus(device, now = new Date()) {
  if (!device?.lastSeen) return 'OFFLINE';
  return now.getTime() - new Date(device.lastSeen).getTime() <= offlineAfterSeconds() * 1000 ? 'ONLINE' : 'OFFLINE';
}

export function serializeDevice(doc, now = new Date()) {
  if (!doc) return null;
  return {
    deviceId: doc.deviceId,
    deviceName: doc.deviceName,
    deviceType: doc.deviceType,
    status: effectiveDeviceStatus(doc, now),
    ipAddress: doc.ipAddress ?? null,
    wifiSignal: doc.wifiSignal ?? null,
    lastSeen: doc.lastSeen?.toISOString?.() ?? null,
    createdAt: doc.createdAt?.toISOString?.() ?? null,
  };
}

/** Upserts the device and marks it ONLINE. Called by heartbeats and by every detection upload. */
export async function touchDevice(db, { deviceId, wifiSignal, ipAddress, deviceName, deviceType }, now = new Date()) {
  const set = { lastSeen: now, status: 'ONLINE' };
  const setOnInsert = { deviceId, createdAt: now };

  if (wifiSignal !== null && wifiSignal !== undefined) set.wifiSignal = wifiSignal;
  else setOnInsert.wifiSignal = null;
  if (ipAddress) set.ipAddress = ipAddress;
  else setOnInsert.ipAddress = null;
  if (deviceName) set.deviceName = deviceName;
  else setOnInsert.deviceName = deviceId;
  if (deviceType) set.deviceType = deviceType;
  else setOnInsert.deviceType = 'ESP32-CAM';

  const devices = db.collection(COLLECTIONS.devices);
  const upsert = () =>
    devices.findOneAndUpdate({ deviceId }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true, returnDocument: 'after' });

  let result;
  try {
    result = await upsert();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    result = await upsert(); // concurrent first contact from the same device
  }
  return result && Object.hasOwn(result, 'value') && Object.hasOwn(result, 'ok') ? result.value : result;
}
