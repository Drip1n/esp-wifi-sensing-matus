#include <Arduino.h>
#include <WiFi.h>

// Credentials stay in a gitignored file so they cannot be committed by accident.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Missing include/secrets.h. Copy include/secrets.example.h and add your Wi-Fi credentials."
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#endif

#ifndef WIFI_SSID
#error "WIFI_SSID is not defined in include/secrets.h"
#endif

#ifndef WIFI_PASSWORD
#error "WIFI_PASSWORD is not defined in include/secrets.h"
#endif

namespace {
constexpr unsigned long kSampleIntervalMs = 50;
// Long enough that an association already in progress is not restarted; the
// Wi-Fi stack's own auto-reconnect handles the common case on its own.
constexpr unsigned long kReconnectIntervalMs = 10000;

// WiFi.RSSI() returns 0 when the radio has no valid measurement yet, which
// happens for a moment right after associating. Sending that would look like a
// 57 dB jump to the browser and trigger a false MOTION, so it is filtered here.
constexpr int kMinValidRssi = -120;
constexpr int kMaxValidRssi = -1;

unsigned long lastSampleAt = 0;
unsigned long lastReconnectAttemptAt = 0;
bool wasConnected = false;

void beginWifiConnection(const char *message) {
  Serial.println(message);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastReconnectAttemptAt = millis();
}
}  // namespace

void setup() {
  Serial.begin(115200);

#if ARDUINO_USB_CDC_ON_BOOT
  // Native USB CDC: without this, a write blocks while the host is not draining
  // the buffer (browser tab throttled, port closed). Dropping a sample is always
  // better than stalling the loop that keeps Wi-Fi alive.
  Serial.setTxTimeoutMs(0);
#endif

  delay(500);

  Serial.println("INFO,Wi-Fi RSSI Motion Detector v0");
  Serial.println("INFO,USB Serial ready at 115200 baud");

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  beginWifiConnection("INFO,Connecting");
}

void loop() {
  // Unsigned subtraction keeps this comparison correct across the ~49 day
  // millis() rollover, so no special case is needed.
  const unsigned long now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected) {
      wasConnected = true;
      Serial.println("INFO,Connected");
      Serial.print("INFO,IP,");
      Serial.println(WiFi.localIP());
    }

    // Repeated samples let the browser measure short-term radio-link variation.
    if (now - lastSampleAt >= kSampleIntervalMs) {
      lastSampleAt = now;

      const int rssi = WiFi.RSSI();
      if (rssi >= kMinValidRssi && rssi <= kMaxValidRssi) {
        // A small machine-readable format keeps browser parsing reliable.
        Serial.print("RSSI,");
        Serial.println(rssi);
      }
    }
    return;
  }

  if (wasConnected) {
    wasConnected = false;
    Serial.println("INFO,Disconnected");
  }

  if (now - lastReconnectAttemptAt >= kReconnectIntervalMs) {
    beginWifiConnection("INFO,Reconnecting");
  }
}
