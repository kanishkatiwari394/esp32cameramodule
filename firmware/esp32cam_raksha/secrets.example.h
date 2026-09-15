// Copy this file to "secrets.h" in the same folder and fill in real values.
// secrets.h is git-ignored - never commit it.
#pragma once

#define WIFI_SSID        "your-wifi-name"
#define WIFI_PASSWORD    "your-wifi-password"

// Your public Vercel domain: no "https://", no trailing slash.
#define API_HOST         "raksha-rail.vercel.app"

// Must equal DEVICE_API_KEY (or this device's entry in DEVICE_KEYS) in Vercel.
// If this board is lost or the key leaks: change the value in Vercel, redeploy, and re-flash.
#define DEVICE_API_KEY   "replace-with-the-same-long-random-key-as-vercel"

#define DEVICE_ID        "ESP32-CAM-01"
#define PLATFORM_NAME    "Platform 1"

// Optional but recommended: verify the server certificate instead of setInsecure().
// Paste the ROOT certificate (PEM) of the CA that issued your Vercel domain's certificate.
// Find it in a browser: padlock -> Certificate -> top of the chain -> export as PEM.
// #define ROOT_CA_PEM \
// "-----BEGIN CERTIFICATE-----\n" \
// "....\n" \
// "-----END CERTIFICATE-----\n"
