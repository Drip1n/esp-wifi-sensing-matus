#pragma once

// Copy this file to include/secrets.h and fill in your own details.
// include/secrets.h is gitignored and must never be committed.
//
// These two values stay on the board. They are never printed to serial and
// therefore can never end up in a recorded dataset.

#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Optional: how often the board pings the access point, in milliseconds.
// Every reply produces one CSI frame, so this sets the sampling rate.
//
//   100 ms = 10 Hz    8.9 kB/s over USB   conservative
//    50 ms = 20 Hz   17.9 kB/s over USB   default
//    20 ms = 50 Hz   44.7 kB/s over USB   PREPARED, NOT VERIFIED ON HARDWARE
//
// USB CDC has ample bandwidth for all three. The open question at 50 Hz is
// whether the AP answers that fast and whether the radio delivers that many
// usable frames - do not assume it works until it has been measured.
// #define CSI_PING_INTERVAL_MS 50

// Optional: this node's identity, written into every recorded dataset.
// One node today; the field exists so a future two-node capture is a superset
// of this format rather than a different one.
// #define CSI_NODE_ID "esp01"
