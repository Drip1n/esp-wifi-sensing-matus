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
constexpr unsigned long kReconnectIntervalMs = 5000;

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
  delay(500);

  Serial.println("INFO,Wi-Fi RSSI Motion Detector v0");
  Serial.println("INFO,USB Serial ready at 115200 baud");

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  beginWifiConnection("INFO,Connecting");
}

void loop() {
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

      // A small machine-readable format keeps browser parsing reliable.
      Serial.print("RSSI,");
      Serial.println(WiFi.RSSI());
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
