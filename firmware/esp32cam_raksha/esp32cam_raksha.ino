/*
 * Raksha Rail - ESP32-CAM detection uploader
 * ------------------------------------------
 * Board   : AI-Thinker ESP32-CAM
 * Sensor  : RHYX-M21-45 (GC2145-type) - it has NO hardware JPEG output
 * Pipeline: camera RGB565 (QVGA 320x240) -> frame2jpg() software JPEG -> HTTPS multipart/form-data -> Vercel API
 *
 * Arduino IDE setup
 *   Boards Manager : "esp32" by Espressif Systems (2.0.14+ or 3.x)
 *   Board          : AI Thinker ESP32-CAM
 *   PSRAM          : Enabled
 *   Partition      : Huge APP (3MB No OTA)
 *   Serial Monitor : 115200 baud
 *
 * Steps
 *   1. Copy secrets.example.h to secrets.h (same folder) and fill in Wi-Fi, API_HOST and DEVICE_API_KEY.
 *   2. TEST_MODE 1 -> uploads one test capture at boot, then every TEST_INTERVAL_MS,
 *                     or immediately when you type 'c' + Enter in the Serial Monitor.
 *   3. TEST_MODE 0 -> uploads only when the Arduino UNO sends "RFID,<uid>,<readerId>\n" to GPIO13.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "esp_camera.h"
#include "img_converters.h"
#include "secrets.h"

// ======================= Options =======================
#define TEST_MODE              1
#define TEST_INTERVAL_MS       60000UL
#define TEST_RFID_UID          "DE:AD:BE:EF"    // must be hex bytes
#define TEST_READER_ID         "RFID-TEST"

#define JPEG_QUALITY           80               // software JPEG quality 1-100
#define SWAP_RGB565_BYTES      0                // set 1 if colors look wrong (byte order of RGB565)
#define FLIP_VERTICAL          0
#define MIRROR_HORIZONTAL      0
#define USE_FLASH_LED          0                // 1 = light the on-board flash LED (GPIO4) while capturing
#define XCLK_FREQ_HZ           20000000         // try 10000000 if frames are garbled

#define HEARTBEAT_INTERVAL_MS  30000UL
#define UPLOAD_ATTEMPTS        3

// UART link to the Arduino UNO (UNO TX is 5 V -> use a 1k/2k voltage divider into GPIO13)
#define ARDUINO_RX_PIN         13
#define ARDUINO_TX_PIN         14
#define ARDUINO_BAUD           9600

// ======================= AI-Thinker ESP32-CAM pins =======================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define FLASH_LED_GPIO     4

HardwareSerial ArduinoLink(1);
String arduinoLine;
unsigned long lastHeartbeat = 0;
unsigned long lastTestCapture = 0;

// ======================= Wi-Fi + time =======================

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  Serial.println("WiFi connecting...");
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // more reliable uploads while the camera is running
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000UL) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi connection failed - check SSID/password and 2.4 GHz network");
    return false;
  }
  Serial.println("WiFi connected");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  Serial.printf("Signal: %d dBm\n", (int)WiFi.RSSI());

  configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC; used for the optional timestamp field
  return true;
}

String isoTimestamp() {
  time_t now = time(nullptr);
  if (now < 1700000000) return "";  // clock not synced yet -> server time is used
  struct tm utc;
  gmtime_r(&now, &utc);
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return String(buf);
}

void configureTls(WiFiClientSecure &client) {
#ifdef ROOT_CA_PEM
  client.setCACert(ROOT_CA_PEM);  // verifies the Vercel certificate
#else
  client.setInsecure();           // still encrypted, but the server certificate is not verified
#endif
}

// ======================= Camera =======================

bool initCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = XCLK_FREQ_HZ;
  config.pixel_format = PIXFORMAT_RGB565;  // GC2145 cannot output JPEG
  config.frame_size = FRAMESIZE_QVGA;      // 320x240
  config.jpeg_quality = 12;                // ignored for RGB565
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    config.fb_location = CAMERA_FB_IN_DRAM;
    Serial.println("WARNING: PSRAM not found - set Tools > PSRAM > Enabled");
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor) {
    Serial.printf("Camera sensor PID: 0x%04X%s\n", sensor->id.PID, sensor->id.PID == 0x2145 ? " (GC2145)" : "");
    if (FLIP_VERTICAL && sensor->set_vflip) sensor->set_vflip(sensor, 1);
    if (MIRROR_HORIZONTAL && sensor->set_hmirror) sensor->set_hmirror(sensor, 1);
  }

  // The first frames after power-up are often dark or green.
  for (int i = 0; i < 3; i++) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
    delay(100);
  }
  Serial.println("Camera ready (RGB565, QVGA)");
  return true;
}

// Captures a fresh RGB565 frame and converts it to JPEG. Caller must free(*jpgBuf).
bool captureJpeg(uint8_t **jpgBuf, size_t *jpgLen) {
  // Discard the frame already sitting in the buffer so the photo matches the moment of the RFID scan.
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);

#if USE_FLASH_LED
  digitalWrite(FLASH_LED_GPIO, HIGH);
  delay(150);
#endif
  Serial.println("Capturing image...");
  fb = esp_camera_fb_get();
#if USE_FLASH_LED
  digitalWrite(FLASH_LED_GPIO, LOW);
#endif

  if (!fb) {
    Serial.println("ERROR: camera capture failed");
    return false;
  }
  Serial.printf("Frame: %ux%u, %u bytes, format %d\n", fb->width, fb->height, (unsigned)fb->len, (int)fb->format);
  if (fb->format != PIXFORMAT_RGB565) {
    Serial.println("WARNING: frame is not RGB565");
  }

#if SWAP_RGB565_BYTES
  for (size_t i = 0; i + 1 < fb->len; i += 2) {
    uint8_t tmp = fb->buf[i];
    fb->buf[i] = fb->buf[i + 1];
    fb->buf[i + 1] = tmp;
  }
#endif

  Serial.println("Converting RGB565 to JPEG...");
  bool ok = frame2jpg(fb, JPEG_QUALITY, jpgBuf, jpgLen);
  esp_camera_fb_return(fb);

  if (!ok || *jpgLen == 0) {
    Serial.println("ERROR: JPEG conversion failed (out of memory?)");
    if (*jpgBuf) free(*jpgBuf);
    *jpgBuf = nullptr;
    return false;
  }
  Serial.printf("JPEG size: %u bytes\n", (unsigned)*jpgLen);
  return true;
}

// ======================= HTTPS API =======================

void addFormField(String &body, const String &boundary, const char *name, const String &value) {
  body += "--" + boundary + "\r\n";
  body += "Content-Disposition: form-data; name=\"" + String(name) + "\"\r\n\r\n";
  body += value + "\r\n";
}

String jsonStringField(const String &json, const char *key) {
  String pattern = String("\"") + key + "\":\"";
  int start = json.indexOf(pattern);
  if (start < 0) return "";
  start += pattern.length();
  int end = json.indexOf('"', start);
  return end < 0 ? "" : json.substring(start, end);
}

// POST https://API_HOST/api/device/detection (multipart/form-data). Returns the eventId or "" on failure.
String uploadDetection(const uint8_t *jpg, size_t jpgLen, const String &rfidUid, const String &readerId) {
  String boundary = "----RakshaRail" + String((uint32_t)esp_random(), HEX);

  String head;
  addFormField(head, boundary, "rfidUid", rfidUid);
  addFormField(head, boundary, "readerId", readerId);
  addFormField(head, boundary, "deviceId", DEVICE_ID);
  addFormField(head, boundary, "platform", PLATFORM_NAME);
  addFormField(head, boundary, "wifiSignal", String((int)WiFi.RSSI()));
  String timestamp = isoTimestamp();
  if (timestamp.length()) addFormField(head, boundary, "timestamp", timestamp);
  head += "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"image\"; filename=\"captured.jpg\"\r\n";
  head += "Content-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";

  size_t total = head.length() + jpgLen + tail.length();
  uint8_t *body = (uint8_t *)(psramFound() ? ps_malloc(total) : malloc(total));
  if (!body) {
    Serial.println("ERROR: not enough memory for the upload body");
    return "";
  }
  memcpy(body, head.c_str(), head.length());
  memcpy(body + head.length(), jpg, jpgLen);
  memcpy(body + head.length() + jpgLen, tail.c_str(), tail.length());

  String url = String("https://") + API_HOST + "/api/device/detection";
  String eventId = "";

  for (int attempt = 1; attempt <= UPLOAD_ATTEMPTS && eventId.length() == 0; attempt++) {
    WiFiClientSecure client;
    configureTls(client);
    HTTPClient http;
    http.setConnectTimeout(10000);
    http.setTimeout(25000);  // cold start + Cloudinary upload can take a few seconds

    if (!http.begin(client, url)) {
      Serial.println("ERROR: invalid API URL");
      break;
    }
    http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
    http.addHeader("X-Device-Key", DEVICE_API_KEY);

    Serial.printf("Uploading... (attempt %d/%d, %u bytes to %s)\n", attempt, UPLOAD_ATTEMPTS, (unsigned)total, url.c_str());
    int code = http.POST(body, total);
    Serial.printf("HTTP response: %d\n", code);

    bool retry = true;
    if (code > 0) {
      String response = http.getString();
      Serial.println(response);
      if (code == 200 && response.indexOf("\"success\":true") >= 0) {
        eventId = jsonStringField(response, "eventId");
        if (eventId.length() == 0) eventId = "ok";
        Serial.println("Upload successful");
        Serial.println("Image URL: " + jsonStringField(response, "imageUrl"));
      } else if (code >= 400 && code < 500 && code != 429) {
        Serial.println("Upload rejected - fix the request (see error above); not retrying");
        retry = false;
      }
    } else {
      Serial.printf("Connection error: %s\n", http.errorToString(code).c_str());
    }
    http.end();

    if (!retry) break;
    if (eventId.length() == 0 && attempt < UPLOAD_ATTEMPTS) delay(2000UL * attempt);
  }

  free(body);
  return eventId;
}

// POST https://API_HOST/api/device/heartbeat (JSON)
void sendHeartbeat() {
  WiFiClientSecure client;
  configureTls(client);
  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(15000);
  if (!http.begin(client, String("https://") + API_HOST + "/api/device/heartbeat")) return;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  String payload = String("{\"deviceId\":\"") + DEVICE_ID +
                   "\",\"wifiSignal\":" + String((int)WiFi.RSSI()) +
                   ",\"ipAddress\":\"" + WiFi.localIP().toString() + "\"}";
  int code = http.POST(payload);
  Serial.printf("Heartbeat -> HTTP %d\n", code);
  if (code != 200 && code > 0) Serial.println(http.getString());
  http.end();
}

bool captureAndUpload(const String &rfidUid, const String &readerId) {
  if (!connectWiFi()) return false;

  uint8_t *jpg = nullptr;
  size_t jpgLen = 0;
  if (!captureJpeg(&jpg, &jpgLen)) return false;

  String eventId = uploadDetection(jpg, jpgLen, rfidUid, readerId);
  free(jpg);
  if (eventId.length()) Serial.println("Event ID: " + eventId);
  return eventId.length() > 0;
}

// ======================= Arduino UNO trigger =======================

// Expected line from the UNO: RFID,<uid>,<readerId>   e.g.  RFID,A1:B2:C3:D4,RFID-1
void handleArduinoLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  if (!line.startsWith("RFID,")) {
    Serial.println("Ignoring from Arduino: " + line);
    return;
  }
  int comma = line.indexOf(',', 5);
  if (comma < 0) {
    Serial.println("Bad trigger, expected RFID,<uid>,<readerId>");
    ArduinoLink.println("ERR,FORMAT");
    return;
  }
  String uid = line.substring(5, comma);
  String reader = line.substring(comma + 1);
  uid.trim();
  reader.trim();

  Serial.println("Trigger from Arduino: UID=" + uid + " reader=" + reader);
  bool ok = captureAndUpload(uid, reader);
  ArduinoLink.println(ok ? "OK" : "ERR,UPLOAD");
}

// ======================= Setup / loop =======================

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("=== Raksha Rail ESP32-CAM ===");

#if USE_FLASH_LED
  pinMode(FLASH_LED_GPIO, OUTPUT);
  digitalWrite(FLASH_LED_GPIO, LOW);
#endif

  ArduinoLink.begin(ARDUINO_BAUD, SERIAL_8N1, ARDUINO_RX_PIN, ARDUINO_TX_PIN);

  if (!initCamera()) {
    Serial.println("Restarting in 10 s...");
    delay(10000);
    ESP.restart();
  }

  while (!connectWiFi()) delay(5000);
  sendHeartbeat();
  lastHeartbeat = millis();

#if TEST_MODE
  Serial.println("TEST_MODE: uploading a test capture now (type 'c' to capture again)");
  captureAndUpload(TEST_RFID_UID, TEST_READER_ID);
  lastTestCapture = millis();
#endif
}

void loop() {
  if (!connectWiFi()) {
    delay(5000);
    return;
  }

  while (ArduinoLink.available()) {
    char c = (char)ArduinoLink.read();
    if (c == '\n') {
      handleArduinoLine(arduinoLine);
      arduinoLine = "";
    } else if (c != '\r') {
      arduinoLine += c;
      if (arduinoLine.length() > 96) arduinoLine = "";  // garbage protection
    }
  }

#if TEST_MODE
  if (Serial.available()) {
    char c = (char)Serial.read();
    if (c == 'c' || c == 'C') {
      captureAndUpload(TEST_RFID_UID, TEST_READER_ID);
      lastTestCapture = millis();
    }
  }
  if (millis() - lastTestCapture >= TEST_INTERVAL_MS) {
    captureAndUpload(TEST_RFID_UID, TEST_READER_ID);
    lastTestCapture = millis();
  }
#endif

  if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }
  delay(10);
}
