#pragma once

// Copy this file to include/secrets.h and fill in your own details.
// include/secrets.h is gitignored and must never be committed.

#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Optional: how often the board pings the access point, in milliseconds.
// Every reply produces one CSI frame, so this sets the sampling rate.
// 50 ms = 20 Hz. Lower values need more USB bandwidth.
// #define CSI_PING_INTERVAL_MS 50
