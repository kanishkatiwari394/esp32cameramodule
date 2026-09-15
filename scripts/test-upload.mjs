// Simulates the ESP32-CAM from any computer: heartbeat + multipart image upload to the PUBLIC deployment.
// Proves Vercel -> Cloudinary -> MongoDB works before touching the hardware.
//
//   npm run test-upload -- --url https://raksha-rail.vercel.app
//   npm run test-upload -- --url https://raksha-rail.vercel.app --image ./photo.jpg --rfid A1:B2:C3:D4 --reader RFID-2
//
// The device key comes from --key or DEVICE_API_KEY in your local .env.

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    key: { type: 'string' },
    image: { type: 'string' },
    rfid: { type: 'string', default: 'A1:B2:C3:D4' },
    reader: { type: 'string', default: 'RFID-1' },
    platform: { type: 'string', default: 'Platform 1' },
    device: { type: 'string', default: 'ESP32-CAM-01' },
  },
});

const base = (values.url || '').replace(/\/+$/, '');
const key = values.key || process.env.DEVICE_API_KEY;
if (!/^https?:\/\//.test(base) || !key) {
  console.error('Usage: npm run test-upload -- --url https://<your-app>.vercel.app [--key <DEVICE_API_KEY>] [--image file.jpg]');
  process.exit(1);
}

async function loadImage() {
  if (values.image) return readFile(values.image);
  // A public 320x240 JPEG (same size as the ESP32-CAM QVGA frames).
  const sample = 'https://res.cloudinary.com/demo/image/upload/c_fill,w_320,h_240/sample.jpg';
  const response = await fetch(sample);
  if (!response.ok) throw new Error(`Could not download sample image (${response.status}); pass --image <file.jpg>`);
  return Buffer.from(await response.arrayBuffer());
}

async function show(label, response) {
  const text = await response.text();
  console.log(`\n${label}: HTTP ${response.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 500));
  }
  return response.ok;
}

const heartbeatOk = await show(
  'POST /api/device/heartbeat',
  await fetch(`${base}/api/device/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': key },
    body: JSON.stringify({ deviceId: values.device, wifiSignal: -55, ipAddress: '192.168.1.50' }),
  }),
);

const image = await loadImage();
console.log(`\nImage: ${image.length} bytes`);

const form = new FormData();
form.append('rfidUid', values.rfid);
form.append('readerId', values.reader);
form.append('deviceId', values.device);
form.append('platform', values.platform);
form.append('timestamp', new Date().toISOString());
form.append('wifiSignal', '-55');
form.append('image', new Blob([image], { type: 'image/jpeg' }), 'captured.jpg');

const started = Date.now();
const uploadOk = await show(
  'POST /api/device/detection',
  await fetch(`${base}/api/device/detection`, { method: 'POST', headers: { 'X-Device-Key': key }, body: form }),
);
console.log(`Upload round trip: ${Date.now() - started} ms`);

console.log(heartbeatOk && uploadOk ? '\nPASS - open page3.html on the deployment; the image should appear within ~3 s.' : '\nFAIL - see the error messages above.');
process.exitCode = heartbeatOk && uploadOk ? 0 : 1;
