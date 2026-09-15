// GET /api/dashboard/stats - real counts from MongoDB. Zero/empty values when no data exists.

import { json, route } from '../../lib/http.js';
import { COLLECTIONS, getDb } from '../../lib/mongodb.js';
import { requireUser } from '../../lib/auth.js';
import { THREAT_STATUSES, isAnalysisServiceConfigured } from '../../lib/analysis.js';
import { offlineAfterSeconds, serializeDetection, serializeDevice } from '../../lib/records.js';
import { getTimeZone, startOfToday } from '../../lib/time.js';

export const GET = route(async (request) => {
  requireUser(request);
  const db = await getDb();
  const detections = db.collection(COLLECTIONS.detections);
  const devices = db.collection(COLLECTIONS.devices);

  const now = new Date();
  const timeZone = getTimeZone();
  const todayStart = startOfToday(timeZone, now);
  const offlineCutoff = new Date(now.getTime() - offlineAfterSeconds() * 1000);

  // Keep the stored status honest for devices that stopped communicating.
  await devices.updateMany({ status: 'ONLINE', lastSeen: { $lt: offlineCutoff } }, { $set: { status: 'OFFLINE' } });

  const [statusRows, detectionsToday, latestDoc, deviceDocs] = await Promise.all([
    detections.aggregate([{ $group: { _id: '$threatStatus', count: { $sum: 1 } } }]).toArray(),
    detections.countDocuments({ timestamp: { $gte: todayStart } }),
    detections.find({}).sort({ createdAt: -1, _id: -1 }).limit(1).next(),
    devices.find({}).sort({ lastSeen: -1 }).limit(50).toArray(),
  ]);

  const byStatus = Object.fromEntries(THREAT_STATUSES.map((s) => [s, 0]));
  let totalDetections = 0;
  for (const row of statusRows) {
    totalDetections += row.count;
    if (Object.hasOwn(byStatus, row._id)) byStatus[row._id] = row.count;
  }
  const analyzed = byStatus.CLEAR + byStatus.SUSPICIOUS + byStatus.THREAT;

  const deviceList = deviceDocs.map((d) => serializeDevice(d, now));
  const cameras = deviceList.filter((d) => /cam/i.test(d.deviceType || '') || /cam/i.test(d.deviceId));
  const activeDevices = deviceList.filter((d) => d.status === 'ONLINE').length;

  return json({
    totalDetections,
    detectionsToday,
    latestDetection: serializeDetection(latestDoc),
    cameraStatus: cameras.some((d) => d.status === 'ONLINE') ? 'ONLINE' : 'OFFLINE',
    activeDevices,
    pendingThreats: byStatus.PENDING,
    totalDevices: deviceList.length,
    devices: deviceList,
    threatSummary: { ...byStatus, analyzed },
    // Share of analyzed detections marked CLEAR; null while nothing has been analyzed.
    securityIndex: analyzed > 0 ? Math.round((byStatus.CLEAR / analyzed) * 100) : null,
    aiAnalysis: isAnalysisServiceConfigured() ? 'CONFIGURED' : 'NOT_INTEGRATED',
    deviceOfflineAfterSeconds: offlineAfterSeconds(),
    timeZone,
    todayStart: todayStart.toISOString(),
    serverTime: now.toISOString(),
  });
});
