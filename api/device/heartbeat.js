// POST /api/device/heartbeat
// Header: X-Device-Key
// JSON: { "deviceId": "ESP32-CAM-01", "wifiSignal": -62, "ipAddress": "192.168.1.20" }

import { json, readBody, route } from '../../lib/http.js';
import { getDb } from '../../lib/mongodb.js';
import { assertDeviceAllowed, authenticateDevice } from '../../lib/auth.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';
import { serializeDevice, touchDevice } from '../../lib/records.js';
import { parseDeviceId, parseIpAddress, parseName, parseWifiSignal } from '../../lib/validation.js';

export const POST = route(async (request) => {
  const deviceAuth = authenticateDevice(request);
  const body = await readBody(request, 4 * 1024);

  const deviceId = parseDeviceId(body.deviceId);
  const wifiSignal = parseWifiSignal(body.wifiSignal);
  const ipAddress = parseIpAddress(body.ipAddress);
  const deviceName = parseName(body.deviceName, 'deviceName');
  const deviceType = parseName(body.deviceType, 'deviceType');
  assertDeviceAllowed(deviceAuth, deviceId);

  const db = await getDb();
  await enforceRateLimit(db, { key: `heartbeat:${deviceId}`, limit: 20, windowSeconds: 60 }, 'Heartbeat rate limit exceeded');

  const device = await touchDevice(db, { deviceId, wifiSignal, ipAddress, deviceName, deviceType });
  return json({ success: true, device: serializeDevice(device), serverTime: new Date().toISOString() });
});
