# esp32cameramodule
#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>

// =====================================================
// RFID-1 PINS
// =====================================================
#define RFID1_SS_PIN   10
#define RFID1_RST_PIN   9

// =====================================================
// RFID-2 PINS
// =====================================================
#define RFID2_SS_PIN    7
#define RFID2_RST_PIN   8

// =====================================================
// SERVO PIN
// =====================================================
#define SERVO_PIN       6

// =====================================================
// ESP32-CAM TRIGGER PIN
// =====================================================
// Arduino sends a HIGH pulse to ESP32-CAM
// when an RFID tag is detected.
#define ESP32_TRIGGER_PIN 5

// =====================================================
// SERVO ANGLES
// =====================================================
#define RFID1_ANGLE 45
#define RFID2_ANGLE 135
#define HOME_ANGLE  90

// =====================================================
// CREATE RFID OBJECTS
// =====================================================
MFRC522 rfid1(RFID1_SS_PIN, RFID1_RST_PIN);
MFRC522 rfid2(RFID2_SS_PIN, RFID2_RST_PIN);

// =====================================================
// CREATE SERVO OBJECT
// =====================================================
Servo cameraServo;

// Prevent repeated detection while the same card
// remains near the reader.
bool rfid1CardPresent = false;
bool rfid2CardPresent = false;

// =====================================================
// SETUP
// =====================================================
void setup()
{
  Serial.begin(9600);

  Serial.println();
  Serial.println("====================================");
  Serial.println("  TWO RFID + SERVO SYSTEM");
  Serial.println("  Arduino UNO Controller");
  Serial.println("====================================");

  // ---------------------------------------------------
  // ESP32-CAM trigger pin
  // ---------------------------------------------------
  pinMode(ESP32_TRIGGER_PIN, OUTPUT);
  digitalWrite(ESP32_TRIGGER_PIN, LOW);

  // ---------------------------------------------------
  // Start SPI
  // ---------------------------------------------------
  SPI.begin();

  // ---------------------------------------------------
  // Initialize RFID readers
  // ---------------------------------------------------
  rfid1.PCD_Init();
  delay(50);

  rfid2.PCD_Init();
  delay(50);

  // ---------------------------------------------------
  // Initialize servo
  // ---------------------------------------------------
  cameraServo.attach(SERVO_PIN);

  // Move camera to center position
  cameraServo.write(HOME_ANGLE);

  delay(500);

  Serial.println("RFID-1 initialized.");
  Serial.println("RFID-2 initialized.");
  Serial.println("Servo initialized.");
  Serial.println();
  Serial.println("System READY.");
  Serial.println("Waiting for RFID cards/tags...");
  Serial.println();
}

// =====================================================
// LOOP
// =====================================================
void loop()
{
  // Check RFID-1
  checkRFID1();

  // Check RFID-2
  checkRFID2();

  // Small delay for stable operation
  delay(50);
}

// =====================================================
// RFID-1 FUNCTION
// =====================================================
void checkRFID1()
{
  // Check if a new card is present
  if (!rfid1.PICC_IsNewCardPresent())
  {
    // Card is no longer detected
    rfid1CardPresent = false;
    return;
  }

  // Read the card
  if (!rfid1.PICC_ReadCardSerial())
  {
    return;
  }

  // Prevent repeated triggering
  if (rfid1CardPresent)
  {
    rfid1.PICC_HaltA();
    rfid1.PCD_StopCrypto1();
    return;
  }

  rfid1CardPresent = true;

  Serial.println("------------------------------------");
  Serial.println("RFID-1 DETECTED!");
  Serial.println("Camera moving to RFID-1 position...");

  // Print UID
  printUID(rfid1.uid.uidByte, rfid1.uid.size);

  // Move camera
  cameraServo.write(RFID1_ANGLE);

  // Give servo time to rotate
  delay(700);

  // Send trigger to ESP32-CAM
  triggerESP32CAM();

  Serial.println("ESP32-CAM capture signal sent.");
  Serial.println("------------------------------------");
  Serial.println();

  // Stop communication with card
  rfid1.PICC_HaltA();
  rfid1.PCD_StopCrypto1();

  // Return camera to center
  delay(500);
  cameraServo.write(HOME_ANGLE);
}

// =====================================================
// RFID-2 FUNCTION
// =====================================================
void checkRFID2()
{
  // Check if a new card is present
  if (!rfid2.PICC_IsNewCardPresent())
  {
    // Card is no longer detected
    rfid2CardPresent = false;
    return;
  }

  // Read the card
  if (!rfid2.PICC_ReadCardSerial())
  {
    return;
  }

  // Prevent repeated triggering
  if (rfid2CardPresent)
  {
    rfid2.PICC_HaltA();
    rfid2.PCD_StopCrypto1();
    return;
  }

  rfid2CardPresent = true;

  Serial.println("------------------------------------");
  Serial.println("RFID-2 DETECTED!");
  Serial.println("Camera moving to RFID-2 position...");

  // Print UID
  printUID(rfid2.uid.uidByte, rfid2.uid.size);

  // Move camera
  cameraServo.write(RFID2_ANGLE);

  // Give servo time to rotate
  delay(700);

  // Send trigger to ESP32-CAM
  triggerESP32CAM();

  Serial.println("ESP32-CAM capture signal sent.");
  Serial.println("------------------------------------");
  Serial.println();

  // Stop communication with card
  rfid2.PICC_HaltA();
  rfid2.PCD_StopCrypto1();

  // Return camera to center
  delay(500);
  cameraServo.write(HOME_ANGLE);
}

// =====================================================
// ESP32-CAM TRIGGER FUNCTION
// =====================================================
void triggerESP32CAM()
{
  // HIGH signal
  digitalWrite(ESP32_TRIGGER_PIN, HIGH);

  // Keep HIGH for 200 ms
  delay(200);

  // LOW signal
  digitalWrite(ESP32_TRIGGER_PIN, LOW);
}

// =====================================================
// PRINT RFID UID
// =====================================================
void printUID(byte *buffer, byte bufferSize)
{
  Serial.print("Card UID: ");

  for (byte i = 0; i < bufferSize; i++)
  {
    if (buffer[i] < 0x10)
    {
      Serial.print("0");
    }

    Serial.print(buffer[i], HEX);

    if (i < bufferSize - 1)
    {
      Serial.print(":");
    }
  }

  Serial.println();
}
