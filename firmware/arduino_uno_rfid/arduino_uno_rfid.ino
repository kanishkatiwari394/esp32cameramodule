/*
 * Raksha Rail - Arduino UNO reference sketch
 * ------------------------------------------
 * Two MFRC522 RFID readers + a servo. When a tag is read:
 *   1. build the UID string (A1:B2:C3:D4)
 *   2. know which reader saw it (RFID-1 / RFID-2)
 *   3. rotate the servo so the camera faces that reader
 *   4. send  RFID,<uid>,<readerId>\n  to the ESP32-CAM over UART
 * The UNO never talks to the cloud; only the ESP32-CAM does.
 *
 * Libraries: MFRC522 (GithubCommunity), Servo, SoftwareSerial (built in)
 *
 * Wiring (adapt to your build)
 *   MFRC522 x2 : 3.3V, GND, SCK=13, MISO=12, MOSI=11 (shared), RST=9 (shared)
 *                SDA/SS reader 1 = D10, reader 2 = D8
 *   Servo      : signal = D6, power from a separate 5 V supply, common GND
 *   ESP32-CAM  : UNO D3 (TX) -> 1k -> ESP32 GPIO13, with 2k from GPIO13 to GND (5 V -> 3.3 V)
 *                ESP32 GPIO14 -> UNO D2 (RX)   (optional "OK"/"ERR" replies)
 *                Common GND between UNO and ESP32-CAM
 */

#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>
#include <SoftwareSerial.h>

const byte NUM_READERS = 2;
const byte RST_PIN = 9;
const byte SS_PINS[NUM_READERS] = {10, 8};
const char *READER_IDS[NUM_READERS] = {"RFID-1", "RFID-2"};
const int SERVO_ANGLES[NUM_READERS] = {45, 135};   // camera direction for each reader
const byte SERVO_PIN = 6;
const unsigned long SAME_TAG_COOLDOWN_MS = 5000;   // ignore the same tag held on the reader

MFRC522 readers[NUM_READERS];
Servo cameraServo;
SoftwareSerial esp32Link(2, 3);  // RX, TX

String lastUid = "";
unsigned long lastUidAt = 0;

String uidToString(const MFRC522::Uid &uid) {
  String s;
  for (byte i = 0; i < uid.size; i++) {
    if (i > 0) s += ':';
    if (uid.uidByte[i] < 0x10) s += '0';
    s += String(uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

void setup() {
  Serial.begin(9600);
  esp32Link.begin(9600);
  SPI.begin();

  for (byte i = 0; i < NUM_READERS; i++) {
    readers[i].PCD_Init(SS_PINS[i], RST_PIN);
    delay(10);
    Serial.print(READER_IDS[i]);
    Serial.print(F(": "));
    readers[i].PCD_DumpVersionToSerial();
  }

  cameraServo.attach(SERVO_PIN);
  cameraServo.write(90);
  Serial.println(F("Raksha Rail UNO ready - scan a tag"));
}

void loop() {
  for (byte i = 0; i < NUM_READERS; i++) {
    if (!readers[i].PICC_IsNewCardPresent() || !readers[i].PICC_ReadCardSerial()) continue;

    String uid = uidToString(readers[i].uid);
    readers[i].PICC_HaltA();
    readers[i].PCD_StopCrypto1();

    if (uid == lastUid && millis() - lastUidAt < SAME_TAG_COOLDOWN_MS) continue;
    lastUid = uid;
    lastUidAt = millis();

    Serial.print(F("Tag "));
    Serial.print(uid);
    Serial.print(F(" on "));
    Serial.println(READER_IDS[i]);

    cameraServo.write(SERVO_ANGLES[i]);
    delay(700);  // let the servo settle so the photo is not blurred

    esp32Link.print(F("RFID,"));
    esp32Link.print(uid);
    esp32Link.print(',');
    esp32Link.println(READER_IDS[i]);
  }

  // Show the ESP32-CAM replies ("OK" / "ERR,UPLOAD") in the UNO Serial Monitor.
  while (esp32Link.available()) Serial.write(esp32Link.read());
}
