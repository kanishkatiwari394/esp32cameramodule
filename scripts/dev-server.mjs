// Local development server: serves the same public/ pages and api/ functions that Vercel runs.
// Production does NOT use this file - Vercel serves public/ and api/ directly.
//
//   npm run dev            -> http://localhost:3000
//
// With MONGODB_URI + CLOUDINARY_* in .env -> uses your real MongoDB Atlas + Cloudinary.
// Without them -> demo mode: temporary in-memory MongoDB and in-memory image store (lost on exit).

import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const cloudMode = Boolean(
  process.env.MONGODB_URI && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET,
);
const images = new Map();
let memoryServer = null;

if (!cloudMode) {
  const { MongoMemoryServer } = await import('mongodb-memory-server-core');
  console.log('Demo mode: starting a temporary in-memory MongoDB (the first run downloads it)...');
  memoryServer = await MongoMemoryServer.create();

  Object.assign(process.env, {
    MONGODB_URI: memoryServer.getUri(),
    MONGODB_DB: 'raksha_rail_demo',
    CLOUDINARY_CLOUD_NAME: 'local-demo',
    CLOUDINARY_API_KEY: 'local-demo',
    CLOUDINARY_API_SECRET: 'local-demo',
  });
  process.env.JWT_SECRET ||= 'local-demo-jwt-secret-never-use-in-production';
  process.env.DEVICE_API_KEY ||= 'local-demo-device-key';
  process.env.BOOTSTRAP_ADMIN_USERNAME ||= 'admin';
  process.env.BOOTSTRAP_ADMIN_PASSWORD ||= 'Admin-Demo-123';

  // Keep uploaded images in memory instead of sending them to Cloudinary.
  const { cloudinary } = await load('lib/cloudinary.js');
  cloudinary.uploader.upload_stream = (options, callback) => {
    const chunks = [];
    return new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk);
        done();
      },
      final(done) {
        const bytes = Buffer.concat(chunks);
        const publicId = `${options.folder}/${options.public_id}`;
        images.set(publicId, bytes);
        callback(undefined, {
          public_id: publicId,
          secure_url: `/dev-images/${encodeURIComponent(publicId)}`,
          width: null,
          height: null,
          bytes: bytes.length,
          format: bytes[0] === 0x89 ? 'png' : 'jpg',
        });
        done();
      },
    });
  };
  cloudinary.uploader.destroy = async (publicId) => {
    images.delete(publicId);
    return { result: 'ok' };
  };
}

// ---------- Vercel-style routing ----------
const ROUTES = {
  '/api/health': 'api/health.js',
  '/api/auth/login': 'api/auth/login.js',
  '/api/auth/logout': 'api/auth/logout.js',
  '/api/auth/me': 'api/auth/me.js',
  '/api/device/detection': 'api/device/detection.js',
  '/api/device/heartbeat': 'api/device/heartbeat.js',
  '/api/detections': 'api/detections/index.js',
  '/api/detections/latest': 'api/detections/latest.js',
  '/api/dashboard/stats': 'api/dashboard/stats.js',
};
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'host', 'expect', 'upgrade']);

const vercelConfig = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
function vercelHeaders(pathname) {
  const headers = {};
  for (const rule of vercelConfig.headers || []) {
    if (new RegExp(`^${rule.source}$`).test(pathname)) for (const h of rule.headers) headers[h.key] = h.value;
  }
  return headers;
}

async function handleApi(req, res, url) {
  const file = ROUTES[url.pathname] || (/^\/api\/detections\/[^/]+$/.test(url.pathname) ? 'api/detections/[id].js' : null);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Not found' }));
  }
  const mod = await load(file);
  if (typeof mod[req.method] !== 'function') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key) && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const response = await mod[req.method](
    new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
  );

  const out = vercelHeaders(url.pathname);
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') out[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(`${req.method} ${url.pathname} ${response.status}`);
}

async function handleStatic(res, url) {
  if (url.pathname.startsWith('/dev-images/')) {
    const bytes = images.get(decodeURIComponent(url.pathname.slice('/dev-images/'.length)));
    if (!bytes) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' });
    return res.end(bytes);
  }

  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const fullPath = path.resolve(PUBLIC_DIR, relative);
  if (!fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await readFile(fullPath);
    res.writeHead(200, { ...vercelHeaders(url.pathname), 'Content-Type': CONTENT_TYPES[path.extname(fullPath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// ---------- demo data: one simulated ESP32 heartbeat + capture ----------
function gradientPng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = 7 + ((x * 60) / width) | 0;
      raw[i + 1] = 60 + ((y * 120) / height) | 0;
      raw[i + 2] = 110 + ((x * 100) / width) | 0;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function seedDemoCapture() {
  const base = `http://127.0.0.1:${PORT}`;
  const key = process.env.DEVICE_API_KEY;
  let image;
  try {
    const sample = await fetch('https://res.cloudinary.com/demo/image/upload/c_fill,w_320,h_240/sample.jpg', { signal: AbortSignal.timeout(6000) });
    if (!sample.ok) throw new Error(String(sample.status));
    image = Buffer.from(await sample.arrayBuffer());
  } catch {
    image = gradientPng(320, 240);
  }
  await fetch(`${base}/api/device/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': key },
    body: JSON.stringify({ deviceId: 'ESP32-CAM-01', wifiSignal: -58, ipAddress: '192.168.1.20' }),
  });
  const form = new FormData();
  form.append('rfidUid', 'A1:B2:C3:D4');
  form.append('readerId', 'RFID-1');
  form.append('deviceId', 'ESP32-CAM-01');
  form.append('platform', 'Platform 1');
  form.append('image', new Blob([image], { type: 'image/jpeg' }), 'captured.jpg');
  await fetch(`${base}/api/device/detection`, { method: 'POST', headers: { 'X-Device-Key': key }, body: form });
}

if (!cloudMode) await seedDemoCapture();

console.log(`
  Raksha Rail is running at http://localhost:${PORT}

  Mode:        ${cloudMode ? 'cloud (MongoDB Atlas + Cloudinary from .env)' : 'demo (in-memory database + images, lost when you stop the server)'}
  Login:       ${process.env.BOOTSTRAP_ADMIN_USERNAME || '(your Atlas users)'} / ${cloudMode ? '(your password)' : process.env.BOOTSTRAP_ADMIN_PASSWORD}
  Device key:  ${cloudMode ? '(DEVICE_API_KEY from .env)' : process.env.DEVICE_API_KEY}

  Simulate an ESP32 upload (in another terminal):
    npm run test-upload -- --url http://localhost:${PORT} --key ${cloudMode ? '<DEVICE_API_KEY>' : process.env.DEVICE_API_KEY} --rfid 04:A3:2B:1C --reader RFID-2

  Press Ctrl+C to stop.
`);

async function shutdown() {
  server.close();
  const { closeDb } = await load('lib/mongodb.js');
  await closeDb().catch(() => {});
  if (memoryServer) await memoryServer.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
