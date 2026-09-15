# 🛡️ Raksha Rail

RFID-triggered railway safety monitoring. An Arduino UNO reads RFID tags and triggers an ESP32-CAM. The
ESP32-CAM uploads the photo over Wi-Fi/HTTPS to a **public Vercel API**. The image is stored in
**Cloudinary**, the detection record in **MongoDB Atlas**, and the existing Raksha Rail web pages show it live.

Nothing runs on your laptop in production: no localhost, no local database, no local image folder.

```
 RFID-1 / RFID-2 tag
        │
        ▼
 Arduino UNO ── rotates servo ── UART "RFID,<uid>,<reader>" ──▶ ESP32-CAM
                                                                 │ capture RGB565 (QVGA)
                                                                 │ software JPEG (frame2jpg)
                                                                 │ Wi-Fi + HTTPS multipart
                                                                 ▼
                                             Vercel serverless API  (https://<app>.vercel.app/api/...)
                                                   │                          │
                                        image bytes│                          │ metadata + imageUrl
                                                   ▼                          ▼
                                              Cloudinary                 MongoDB Atlas
                                                   │                          │
                                                   └────────────┬─────────────┘
                                                                ▼
                                    Raksha Rail web app (same Vercel domain, polls every 3 s)
```

---

## 1. Project structure

```
raksha-rail/
├── public/                     ← served as the website (Vercel output directory)
│   ├── index.html              existing login page (now calls /api/auth/login)
│   ├── page2.html              existing dashboard (now shows real cloud stats)
│   ├── page3.html              existing camera/threat page (latest ESP32 image, RFID data, history)
│   └── js/raksha-api.js        shared fetch/session/polling helpers (same-origin, no hard-coded host)
├── api/                        ← Vercel serverless functions (Node.js 24, Web Request/Response)
│   ├── health.js               GET  /api/health
│   ├── auth/login.js           POST /api/auth/login
│   ├── auth/logout.js          POST /api/auth/logout
│   ├── auth/me.js              GET  /api/auth/me
│   ├── device/detection.js     POST /api/device/detection   (ESP32 upload)
│   ├── device/heartbeat.js     POST /api/device/heartbeat   (ESP32 status)
│   ├── detections/index.js     GET  /api/detections         (history)
│   ├── detections/latest.js    GET  /api/detections/latest
│   ├── detections/[id].js      GET/PATCH /api/detections/:id (review / future AI results)
│   └── dashboard/stats.js      GET  /api/dashboard/stats
├── lib/                        ← shared server code (never served to browsers)
│   ├── mongodb.js              cached Atlas connection + indexes
│   ├── cloudinary.js           server-side image upload
│   ├── auth.js                 bcrypt, JWT session cookie, device keys
│   ├── validation.js           input + image validation
│   ├── rateLimit.js            MongoDB-backed rate limiting
│   ├── records.js              detection/device serialization, online status
│   ├── analysis.js             PENDING/UNKNOWN defaults + future AI webhook hook
│   ├── telegram.js             optional Telegram alerts
│   └── time.js                 "today" in APP_TIMEZONE
├── scripts/
│   ├── create-user.mjs         add officers/operators/admins
│   └── test-upload.mjs         simulate the ESP32 from a computer
├── firmware/
│   ├── esp32cam_raksha/        ESP32-CAM sketch (+ secrets.example.h)
│   └── arduino_uno_rfid/       Arduino UNO reference sketch (2× MFRC522 + servo)
├── package.json   vercel.json   .env.example   .gitignore
```

The three original pages moved into `public/` so Vercel serves only the website. `lib/`, `scripts/` and
`firmware/` are never publicly downloadable. The pages keep their original layout, colors, cards, animations and navigation.

### What changed in the existing pages

| Page | Before | Now |
|---|---|---|
| `index.html` | any input "logged in" | real login (`/api/auth/login`), inline error message, "Remember me" = 7-day session, auto-redirect if already signed in |
| `page2.html` | hard-coded "98% CLEAR", "VAPOR SENSORS ONLINE" | real device status, detection counts, pending count; security index shows **N/A** until captures are actually analyzed; narcotics/explosive cards and modals say **NOT ANALYZED / model not integrated** |
| `page3.html` | browser webcam + fake "Unattended Bag 94%" | latest ESP32-CAM image from Cloudinary, RFID UID, reader, platform, device ID, timestamp, threat status, camera online/offline, Wi-Fi signal, paginated + filterable detection history, auto-update every 3 s, toast on new event |
| Logout links | pointed to non-existent `loginform.html` | clear the session and return to `index.html` |

---

## 2. API reference

All responses are JSON. Errors look like `{ "success": false, "error": "message" }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/device/detection` | `X-Device-Key` | ESP32 image + RFID upload |
| POST | `/api/device/heartbeat` | `X-Device-Key` | ESP32 online status |
| POST | `/api/auth/login` | public | website login, sets session cookie |
| POST | `/api/auth/logout` | – | clears session cookie |
| GET | `/api/auth/me` | session | current user |
| GET | `/api/detections/latest` | session | newest detection (`null` if none) |
| GET | `/api/detections` | session | history: `page, limit(≤100), readerId, rfidUid, platform, deviceId, threatStatus, fromDate, toDate` |
| GET | `/api/detections/:id` | session | one detection |
| PATCH | `/api/detections/:id` | admin/officer session **or** `X-Analysis-Key` | record review/AI result |
| GET | `/api/dashboard/stats` | session | `totalDetections, detectionsToday, latestDetection, cameraStatus, activeDevices, pendingThreats, …` |
| GET | `/api/health` | public | deployment check (configured / connected, never secret values) |

### ESP32 upload — exact request

```
POST https://<your-app>.vercel.app/api/device/detection
X-Device-Key: <DEVICE_API_KEY>
Content-Type: multipart/form-data; boundary=----RakshaRail1a2b3c
```

| Field | Required | Rule | Example |
|---|---|---|---|
| `image` | yes | file, JPEG or PNG (checked by magic bytes), 128 B – 3 MB | `captured.jpg` |
| `rfidUid` | yes | 4–10 hex bytes, separators `: - space` optional; stored as `A1:B2:C3:D4` | `A1:B2:C3:D4` |
| `readerId` | yes | letters/digits/`_.-`, ≤32 | `RFID-1` |
| `deviceId` | yes | letters/digits/`_.-`, ≤64 | `ESP32-CAM-01` |
| `platform` | yes | letters/digits/spaces/`_.-`, ≤40 | `Platform 1` |
| `timestamp` | no | ISO-8601 with `Z`/offset, or epoch s/ms; ignored if not within the last 24 h (server time used) | `2026-09-12T10:15:30Z` |
| `wifiSignal` | no | integer dBm −127…0 | `-62` |

Raw body (what the firmware builds):

```
------RakshaRail1a2b3c
Content-Disposition: form-data; name="rfidUid"

A1:B2:C3:D4
------RakshaRail1a2b3c
Content-Disposition: form-data; name="readerId"

RFID-1
------RakshaRail1a2b3c
Content-Disposition: form-data; name="deviceId"

ESP32-CAM-01
------RakshaRail1a2b3c
Content-Disposition: form-data; name="platform"

Platform 1
------RakshaRail1a2b3c
Content-Disposition: form-data; name="image"; filename="captured.jpg"
Content-Type: image/jpeg

<JPEG bytes>
------RakshaRail1a2b3c--
```

Success `200`:

```json
{
  "success": true,
  "eventId": "66e2b1f4c9a1d2e3f4a5b6c7",
  "imageUrl": "https://res.cloudinary.com/<cloud>/image/upload/v1726136130/raksha-rail/detections/2026-09-12T10-15-30-000Z_1a2b3c4d.jpg",
  "threatStatus": "PENDING",
  "detectionType": "UNKNOWN",
  "timestamp": "2026-09-12T10:15:30.000Z",
  "message": "Detection recorded successfully"
}
```

Errors: `400` bad field · `401` missing/invalid device key · `403` key not allowed for that deviceId ·
`413` image too large · `415` not multipart / not JPEG-PNG · `422` Cloudinary rejected the image ·
`429` more than 30 uploads/minute per device · `502` Cloudinary unreachable · `503` database unreachable.

What the server does, in order: authenticate device key → validate fields → validate image type and size →
upload to Cloudinary → insert the MongoDB document with `imageUrl` and `imagePublicId`, never image bytes. If the insert fails, the Cloudinary image is deleted →
mark device ONLINE → return JSON → send the optional Telegram alert / AI webhook after the response.

### Heartbeat

```
POST https://<your-app>.vercel.app/api/device/heartbeat
X-Device-Key: <DEVICE_API_KEY>
Content-Type: application/json

{ "deviceId": "ESP32-CAM-01", "wifiSignal": -62, "ipAddress": "192.168.1.20" }
```

A device is **ONLINE** if a heartbeat or upload arrived within `DEVICE_OFFLINE_AFTER_SECONDS` (default 90 s),
otherwise **OFFLINE**. The firmware sends a heartbeat every 30 s.

### MongoDB collections

- `users`: `_id, username, email, passwordHash (bcrypt, cost 12), role (admin|officer|operator), isActive, createdAt, lastLoginAt`
- `detections`: `_id, rfidUid, readerId, platform, deviceId, imageUrl, imagePublicId, image{width,height,bytes,format}, threatStatus, detectionType, confidence, analysis{status,source,model,notes,analyzedAt,reviewedBy}, timestamp, timestampSource, createdAt`
- `devices`: `_id, deviceId, deviceName, deviceType, status, ipAddress, wifiSignal, lastSeen, createdAt`
- `rate_limits`: short-lived counters (TTL index removes them automatically)

Indexes are created automatically on first connection.

### Threat detection: honest by design

No narcotics/explosive AI model is integrated. Every new detection is stored as
`threatStatus: "PENDING"`, `detectionType: "UNKNOWN"`, `confidence: null`, `analysis.status: "NOT_ANALYZED"`,
and the UI says so. To add AI later:

1. Set `ANALYSIS_WEBHOOK_URL` and `ANALYSIS_API_KEY` in Vercel.
2. Each new detection is POSTed to your service: `{ eventId, imageUrl, rfidUid, readerId, platform, deviceId, timestamp, callbackUrl }`.
3. Your service replies later with
   `PATCH callbackUrl` + header `X-Analysis-Key` + `{ "threatStatus": "CLEAR|SUSPICIOUS|THREAT", "detectionType": "NONE|NARCOTICS|EXPLOSIVE|WEAPON|OTHER", "confidence": 0.0-1.0, "model": "name" }`.
4. The dashboard picks the result up on its next poll. Officers/admins can record a manual review with the same PATCH.

---

## 3. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (Production). `.env.example` lists them
with placeholders. Never commit real values. **After changing any variable, redeploy.**

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | ✅ | Atlas `mongodb+srv://…` connection string |
| `MONGODB_DB` | – | default `raksha_rail` |
| `CLOUDINARY_CLOUD_NAME` | ✅ | |
| `CLOUDINARY_API_KEY` | ✅ | |
| `CLOUDINARY_API_SECRET` | ✅ | server-side only |
| `CLOUDINARY_FOLDER` | – | default `raksha-rail/detections` |
| `JWT_SECRET` | ✅ | ≥32 chars random |
| `SESSION_HOURS` | – | default 12 |
| `DEVICE_API_KEY` | ✅ | ≥16 chars (use 32+ random); same value goes in the firmware |
| `DEVICE_KEYS` | – | per-device keys `ESP32-CAM-01:key1,ESP32-CAM-02:key2` |
| `DEVICE_OFFLINE_AFTER_SECONDS` | – | default 90 |
| `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` / `BOOTSTRAP_ADMIN_EMAIL` | first deploy | creates the first admin while `users` is empty; password ≥10 chars; delete the password variable after first login |
| `APP_TIMEZONE` | – | default `Asia/Kolkata` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | – | optional alerts |
| `ANALYSIS_WEBHOOK_URL` / `ANALYSIS_API_KEY` | – | optional future AI service |

Generate secrets (run twice, one for `JWT_SECRET`, one for `DEVICE_API_KEY`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. MongoDB Atlas setup

1. Go to <https://www.mongodb.com/cloud/atlas/register> and sign up.
2. **Create a free cluster**: choose the **Free (M0)** tier. Pick a region close to your Vercel function region.
   For India use **AWS Mumbai (ap-south-1)** and set Vercel's function region to **Mumbai (bom1)** (step 5.8).
3. **Create a database user**: Security → *Database & Network Access* → **Database Users** → *Add New Database User* →
   Password authentication → username e.g. `raksha_app`, click *Autogenerate Secure Password* (copy it) →
   role **Read and write to any database** → *Add User*.
4. **Network access**: *IP Access List* → *Add IP Address* → **Allow access from anywhere (`0.0.0.0/0`)** → Confirm.
   Vercel functions have no fixed IP address, so this is required on the free tier. The strong database password protects access.
5. **Connection string**: *Clusters* → **Connect** → *Drivers* → Node.js → copy
   `mongodb+srv://raksha_app:<db_password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`.
   Replace `<db_password>`. If the password contains `@ : / ? # [ ] %`, URL-encode those characters.
6. Put it in Vercel as `MONGODB_URI` (section 6, step 7).
7. **Test**: after deploying, open `https://<your-app>.vercel.app/api/health` → `"database": "connected"`.
   After the first login/upload, Atlas → *Browse Collections* shows database `raksha_rail` with `users`, `detections`, `devices`.

## 5. Cloudinary setup

1. Sign up (free) at <https://cloudinary.com/users/register_free>.
2. Open the Console → **Settings → API Keys** (also shown on the Dashboard as product environment credentials).
3. Copy **Cloud name**, **API Key**, **API Secret**.
4. Add them to Vercel as `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
   The secret is used only inside `lib/cloudinary.js` on the server; the browser and ESP32 never see it.
5. **Test**: run the simulated upload in section 8.1. Cloudinary → **Media Library → Folders → `raksha-rail/detections`**
   shows the image, tagged with the device and reader IDs.

## 6. Deploy to Vercel

1. **Create a GitHub repository** (e.g. `raksha-rail`, private or public) at <https://github.com/new>. Don't add a README.
2. **Upload the project** from this folder:
   ```bash
   git init
   git add .
   git commit -m "Raksha Rail cloud version"
   git branch -M main
   git remote add origin https://github.com/<you>/raksha-rail.git
   git push -u origin main
   ```
   `.gitignore` keeps `node_modules`, `.env` and `firmware/**/secrets.h` out of Git. Check with `git status` before pushing.
3. **Create a Vercel account** at <https://vercel.com/signup> using "Continue with GitHub".
4. **Import**: Vercel dashboard → *Add New… → Project* → pick the `raksha-rail` repo → *Import*.
   Name the project `raksha-rail` to get `raksha-rail.vercel.app` if it's free.
5. **Build settings**: Framework Preset **Other**. Leave Build Command empty and Output Directory as-is: `vercel.json` sets
   `outputDirectory: public`, and Node 24 comes from `package.json`.
6. Complete MongoDB Atlas (section 4) and Cloudinary (section 5).
7. **Environment variables**: expand *Environment Variables* and add every ✅ variable from section 3, plus
   `BOOTSTRAP_ADMIN_USERNAME=admin` and a strong `BOOTSTRAP_ADMIN_PASSWORD`.
8. **Deploy**. Once it's live, open *Settings → Functions → Function Region* and select the region matching Atlas
   (e.g. Mumbai `bom1`), then *Deployments → ⋯ → Redeploy*.
9. **Public URL**: *Project → Domains* shows `https://raksha-rail.vercel.app` (or similar). Use this **production** domain everywhere.
   Preview URLs (`raksha-rail-git-…vercel.app`) are behind Vercel Deployment Protection by default and will reject the ESP32.
10. **Test health**: `https://<your-app>.vercel.app/api/health` → `"ok": true`.
11. **Test login**: open `https://<your-app>.vercel.app` → sign in with the bootstrap admin → you land on the dashboard.
    Then delete `BOOTSTRAP_ADMIN_PASSWORD` in Vercel (the account stays) and redeploy.
12. **Test dashboard + upload**: section 8.1 (simulated ESP32). Page 3 updates within ~3 s.
13. **Test ESP32**: section 7, then section 8.2.

### Adding more users

Users are stored in Atlas; this runs once from any computer with Node 24:

```bash
npm install
# create .env with MONGODB_URI=... (git-ignored)
npm run create-user -- --username rpf-officer1 --role officer --email officer1@example.com
npm run create-user -- --username rpf-officer1 --reset-password
```

A strong password is generated and printed once (or pass `--password`). Roles: `admin`, `officer` (can record reviews), `operator` (view only).

---

## 7. ESP32-CAM firmware

Hardware: AI-Thinker ESP32-CAM with the **RHYX-M21-45 (GC2145-type)** sensor. It has **no hardware JPEG**, so the sketch
captures `PIXFORMAT_RGB565` at `FRAMESIZE_QVGA` and converts to JPEG in software with `frame2jpg()` before uploading.

1. Arduino IDE → Boards Manager → install **esp32 by Espressif Systems** (2.0.14+ or 3.x).
2. Open `firmware/esp32cam_raksha/esp32cam_raksha.ino`.
3. Copy `secrets.example.h` → `secrets.h` and set `WIFI_SSID`, `WIFI_PASSWORD` (2.4 GHz network),
   `API_HOST` (e.g. `raksha-rail.vercel.app`, no `https://`), `DEVICE_API_KEY` (same as Vercel), `DEVICE_ID`, `PLATFORM_NAME`.
4. Tools: Board **AI Thinker ESP32-CAM**, PSRAM **Enabled**, Partition **Huge APP**. Flash with GPIO0 → GND, then remove the jumper and reset.
5. Keep `TEST_MODE 1` for the first test. Open Serial Monitor at 115200 baud. Power the board from a solid **5 V / 2 A** supply
   (brown-outs during Wi-Fi TX are the #1 ESP32-CAM problem).

Expected Serial Monitor output:

```
=== Raksha Rail ESP32-CAM ===
Camera sensor PID: 0x2145 (GC2145)
Camera ready (RGB565, QVGA)
WiFi connecting...
WiFi connected
IP address: 192.168.1.20
Signal: -58 dBm
Heartbeat -> HTTP 200
TEST_MODE: uploading a test capture now (type 'c' to capture again)
Capturing image...
Frame: 320x240, 153600 bytes, format 0
Converting RGB565 to JPEG...
JPEG size: 9412 bytes
Uploading... (attempt 1/3, 10133 bytes to https://raksha-rail.vercel.app/api/device/detection)
HTTP response: 200
{"success":true,"eventId":"66e2b1f4…","imageUrl":"https://res.cloudinary.com/…","threatStatus":"PENDING",…}
Upload successful
Image URL: https://res.cloudinary.com/...
Event ID: 66e2b1f4...
```

Firmware options at the top of the sketch: `SWAP_RGB565_BYTES` (colors wrong), `FLIP_VERTICAL` / `MIRROR_HORIZONTAL`,
`JPEG_QUALITY`, `XCLK_FREQ_HZ` (try 10 MHz if frames are garbled), `USE_FLASH_LED`.

**TLS:** by default the sketch uses `setInsecure()`. Traffic is still encrypted, but the server certificate isn't verified.
For stronger security, export the root CA of your Vercel domain's certificate chain (browser padlock → certificate → top of the chain → PEM) into
`ROOT_CA_PEM` in `secrets.h`.

### Arduino UNO + RFID integration

After the test works, set `TEST_MODE 0`. The UNO sends one line per scan: `RFID,<uid>,<readerId>\n` at 9600 baud.
`firmware/arduino_uno_rfid/arduino_uno_rfid.ino` is a reference sketch for 2× MFRC522 + servo:

| UNO | ESP32-CAM |
|---|---|
| D3 (TX) → 1 kΩ → | GPIO13, with 2 kΩ from GPIO13 to GND (5 V → 3.3 V) |
| D2 (RX) ← | GPIO14 (replies `OK` / `ERR,UPLOAD`) |
| GND | GND |

The backend never talks to the Arduino. Only the ESP32-CAM calls the API.

### Device key security

`DEVICE_API_KEY` is compiled into the firmware, so anyone with physical access to a board could extract it.
**If a board is lost or the key may have leaked:** generate a new key → update `DEVICE_API_KEY` in Vercel → redeploy →
update `secrets.h` → re-flash every board. With `DEVICE_KEYS` each board has its own key bound to its `deviceId`, so you can
rotate one board without touching the others, and a stolen key can't impersonate other devices.

---

## 8. Test procedure

### 8.1 Without hardware (proves Vercel → Cloudinary → MongoDB → dashboard)

```bash
npm install
npm run test-upload -- --url https://<your-app>.vercel.app --key <DEVICE_API_KEY>
# optional: --image photo.jpg --rfid 04:A3:2B:1C --reader RFID-2 --platform "Platform 3"
```

Or with curl (Windows PowerShell: use `curl.exe`):

```bash
curl -X POST https://<your-app>.vercel.app/api/device/detection \
  -H "X-Device-Key: <DEVICE_API_KEY>" \
  -F "image=@captured.jpg;type=image/jpeg" \
  -F "rfidUid=A1:B2:C3:D4" -F "readerId=RFID-1" \
  -F "deviceId=ESP32-CAM-01" -F "platform=Platform 1"
```

Keep `page3.html` open while you run it. The new image, RFID UID and a toast alert should appear within ~3 s without refreshing.

### 8.2 With the ESP32-CAM

1. Flash with `TEST_MODE 1`. The Serial Monitor must show `HTTP response: 200` and `Upload successful`.
2. Type `c` in the Serial Monitor for another capture.
3. Set `TEST_MODE 0`, connect the UNO, scan a real tag on RFID-1 and RFID-2.

### 8.3 Verify every hop of ESP32 → Vercel → Cloudinary → MongoDB → Dashboard

| Hop | Where to look | What proves it works |
|---|---|---|
| ESP32 → Vercel | Serial Monitor | `HTTP response: 200`, an `eventId` and `imageUrl` |
| Vercel | Vercel → Project → **Logs** | `POST /api/device/detection 200`; no `[cloudinary]` / `[mongodb]` errors |
| Cloudinary | **Media Library → raksha-rail/detections** | a new image whose public ID equals the detection's `imagePublicId` |
| MongoDB | Atlas → **Browse Collections → raksha_rail.detections** | a document whose `_id` equals `eventId`, `imageUrl` = Cloudinary URL, `threatStatus: "PENDING"` |
| Device status | `raksha_rail.devices` | `ESP32-CAM-01`, `status: "ONLINE"`, fresh `lastSeen` |
| Dashboard | `https://<your-app>.vercel.app/page3.html` | same image + RFID data within ~3 s; history row; page 2 counts increase |
| Cloud-only | turn your laptop **off**, open the URL on a phone using mobile data | everything is still there |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `/api/health` → `not_configured` | variable missing → add in Vercel → **redeploy** |
| `database: connection_failed` / API 503 | Atlas IP Access List must contain `0.0.0.0/0`; check password URL-encoding |
| ESP32 `HTTP response: 401` `Invalid device key` | key mismatch or stray spaces; redeploy after changing it |
| ESP32 gets HTML / 401 from Vercel | you used a preview URL; use the production domain |
| ESP32 `HTTP response: -1` | `API_HOST` must not include `https://`; Wi-Fi must be 2.4 GHz; check power supply |
| `Camera init failed: 0x…` | reseat the ribbon cable, PSRAM Enabled, try `XCLK_FREQ_HZ 10000000` |
| Colors look wrong | `SWAP_RGB565_BYTES 1` |
| `Brownout detector was triggered` | 5 V / 2 A supply, short thick wires |
| Login `429` | 10 failed attempts per ID (or 30 per IP) in 15 min; wait |

---

## 9. Security summary

- Passwords hashed with bcrypt (cost 12); plaintext is never stored or logged. Response timing doesn't reveal whether an ID exists.
- Sessions: signed JWT (HS256) in an **HttpOnly, Secure, SameSite=Strict** cookie. JavaScript can't read it, and cross-site requests don't send it.
- All dashboard APIs require a session; PATCH requires `admin`/`officer` or the analysis-service key.
- Device API uses a separate `X-Device-Key` (constant-time comparison), optionally bound per device.
- Image validation by magic bytes (JPEG/PNG only), 3 MB cap (below Vercel's 4.5 MB request limit).
- All inputs validated to plain strings/numbers, so MongoDB operator injection is impossible; queries use fixed field names.
- Rate limits stored in MongoDB (they work across serverless instances): login per IP and per ID, uploads and heartbeats per device.
- Secrets live only in Vercel environment variables; `.env`, `secrets.h` are git-ignored; `/api/health` reports only configured/not configured.
- `vercel.json` adds CSP (`connect-src 'self'`, images only from self/Cloudinary/Unsplash), `X-Frame-Options: DENY`, `nosniff`, and `Referrer-Policy` headers.
- No CORS headers: the browser app and API share one origin, and the ESP32 isn't a browser, so CORS isn't needed.
- Polling cost: an open page 3 calls the API about every 3 s; polling pauses automatically when the tab is hidden.
