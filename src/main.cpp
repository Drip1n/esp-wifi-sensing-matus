// ---------------------------------------------------------------------------
// Wi-Fi CSI V0.1 - ESP32-S3
//
// RSSI (our previous milestone, preserved on branch `mino`) is ONE number per
// packet: total received power. CSI is many numbers per packet: it describes
// how the radio channel treated each OFDM sub-carrier separately. Because a
// moving body changes the reflected paths differently at different
// frequencies, CSI shows structure that a single RSSI number averages away.
//
// This firmware does the smallest honest job:
//   connect to Wi-Fi -> enable CSI -> ping the gateway to create traffic ->
//   copy each CSI frame out of the Wi-Fi callback -> print it as one CSV line.
//
// It uses the official ESP-IDF CSI C API directly (esp_wifi_set_csi_config,
// esp_wifi_set_csi_rx_cb, esp_wifi_set_csi). Arduino here is only the build
// system and the USB serial layer.
// ---------------------------------------------------------------------------
#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <ping/ping_sock.h>
#include <string.h>

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

// How often we ping the access point. Every reply we receive produces one CSI
// frame, so this is effectively our sampling rate. 50 ms = 20 Hz, the same
// cadence the RSSI milestone used: fast enough for walking humans (well under
// 5 Hz of real motion) and only ~28 kB/s over USB.
#ifndef CSI_PING_INTERVAL_MS
#define CSI_PING_INTERVAL_MS 50
#endif

namespace {

// ESP32-S3 in HT20 gives 256 bytes of CSI: two long-training-field blocks
// (LLTF then HT-LTF) of 64 sub-carriers each, 2 bytes per sub-carrier.
// We force HT20 so this length is predictable instead of varying per packet.
constexpr size_t kCsiMaxBytes = 256;
constexpr size_t kQueueDepth = 12;
constexpr unsigned long kStatsIntervalMs = 1000;
constexpr unsigned long kReconnectIntervalMs = 10000;

struct CsiFrame {
  uint32_t seq;
  uint32_t timestamp;   // ESP32 local time of reception, microseconds
  int8_t rssi;
  int8_t noiseFloor;
  uint8_t channel;
  uint8_t sigMode;      // 0 = non-HT (11b/g), 1 = HT (11n)
  uint8_t firstWordInvalid;
  uint16_t len;
  int8_t data[kCsiMaxBytes];
};

QueueHandle_t csiQueue = nullptr;
esp_ping_handle_t pingHandle = nullptr;

uint8_t apBssid[6] = {0};
bool bssidValid = false;
bool wasConnected = false;
unsigned long lastReconnectAttemptAt = 0;
unsigned long lastStatsAt = 0;

// Counters. Every one of these is printed, because a silent drop is the
// difference between "the channel is calm" and "we lost half the data".
volatile uint32_t frameSeq = 0;
volatile uint32_t droppedQueueFull = 0;
volatile uint32_t droppedWrongMac = 0;
volatile uint32_t droppedOversized = 0;
uint32_t emittedTotal = 0;
uint32_t truncatedWrites = 0;
uint32_t emittedSinceStats = 0;

// ---------------------------------------------------------------------------
// CSI callback. This runs on the Wi-Fi task, so it must stay tiny: copy the
// frame into a queue and return. Formatting text or touching Serial here would
// stall the Wi-Fi stack and cost us packets.
// ---------------------------------------------------------------------------
void onCsiFrame(void *ctx, wifi_csi_info_t *info) {
  (void)ctx;
  if (info == nullptr || info->buf == nullptr) return;

  // One radio link only. CSI from some other transmitter describes a
  // completely different path through the room, so mixing it in would make the
  // baseline meaningless.
  if (bssidValid && memcmp(info->mac, apBssid, 6) != 0) {
    droppedWrongMac++;
    return;
  }

  if (info->len == 0 || info->len > kCsiMaxBytes) {
    droppedOversized++;
    return;
  }

  // Static scratch rather than a stack local: this callback is not reentrant
  // (one Wi-Fi task) and a 280-byte frame is a lot to put on that task's stack.
  static CsiFrame frame;
  frame.seq = ++frameSeq;
  frame.timestamp = info->rx_ctrl.timestamp;
  frame.rssi = info->rx_ctrl.rssi;
  frame.noiseFloor = info->rx_ctrl.noise_floor;
  frame.channel = info->rx_ctrl.channel;
  frame.sigMode = info->rx_ctrl.sig_mode;
  frame.firstWordInvalid = info->first_word_invalid ? 1 : 0;
  frame.len = info->len;
  memcpy(frame.data, info->buf, info->len);

  if (xQueueSend(csiQueue, &frame, 0) != pdTRUE) {
    // The printer could not keep up. Counted, never hidden.
    droppedQueueFull++;
  }
}

// ---------------------------------------------------------------------------
// Emit one frame as a single CSV line.
//
// Format:
//   CSI,seq,rssi,noise,channel,sig_mode,timestamp_us,first_word_invalid,len,v0,v1,...
//
// The values are the raw CSI bytes in hardware order. Espressif stores each
// sub-carrier as TWO signed bytes, imaginary part first then real part, so
// v[2k] = imag(k) and v[2k+1] = real(k). The host pairs them up.
// ---------------------------------------------------------------------------
char lineBuffer[1700];

void emitFrame(const CsiFrame &frame) {
  int n = snprintf(lineBuffer, sizeof(lineBuffer),
                   "CSI,%u,%d,%d,%u,%u,%u,%u,%u",
                   (unsigned)frame.seq, (int)frame.rssi, (int)frame.noiseFloor,
                   (unsigned)frame.channel, (unsigned)frame.sigMode,
                   (unsigned)frame.timestamp, (unsigned)frame.firstWordInvalid,
                   (unsigned)frame.len);

  for (uint16_t i = 0; i < frame.len && n > 0 && n < (int)sizeof(lineBuffer) - 8; i++) {
    n += snprintf(lineBuffer + n, sizeof(lineBuffer) - n, ",%d", (int)frame.data[i]);
  }
  if (n <= 0 || n >= (int)sizeof(lineBuffer) - 2) return;
  lineBuffer[n++] = '\n';

  // A short write means USB back-pressure cut the line in half. The host will
  // reject the malformed line; we count it so the cause is never a mystery.
  size_t written = Serial.write((const uint8_t *)lineBuffer, n);
  if (written != (size_t)n) truncatedWrites++;
  emittedTotal++;
  emittedSinceStats++;
}

void emitStats(unsigned long now) {
  const float seconds = (now - lastStatsAt) / 1000.0f;
  const float rate = seconds > 0 ? emittedSinceStats / seconds : 0.0f;
  Serial.printf("STAT,%lu,%.1f,%u,%u,%u,%u,%u,%d,%u\n",
                now, rate, (unsigned)emittedTotal,
                (unsigned)droppedQueueFull, (unsigned)droppedWrongMac,
                (unsigned)droppedOversized, (unsigned)truncatedWrites,
                WiFi.RSSI(), (unsigned)ESP.getFreeHeap());
  emittedSinceStats = 0;
  lastStatsAt = now;
}

void startPing() {
  if (pingHandle != nullptr) return;

  // Pinging the gateway is what actually generates our CSI: every echo reply
  // the AP sends back is a packet we receive, and every received packet
  // carries a channel measurement. Without traffic there is almost nothing to
  // measure except the AP's ~10 Hz beacons.
  esp_ping_config_t config = ESP_PING_DEFAULT_CONFIG();
  ip_addr_t target = {};
  target.type = IPADDR_TYPE_V4;
  target.u_addr.ip4.addr = WiFi.gatewayIP();
  config.target_addr = target;
  config.count = ESP_PING_COUNT_INFINITE;
  config.interval_ms = CSI_PING_INTERVAL_MS;
  config.timeout_ms = 1000;
  config.task_stack_size = 4096;

  esp_ping_callbacks_t callbacks = {};
  if (esp_ping_new_session(&config, &callbacks, &pingHandle) == ESP_OK) {
    esp_ping_start(pingHandle);
    Serial.printf("INFO,Ping started at %d ms interval\n", CSI_PING_INTERVAL_MS);
  } else {
    pingHandle = nullptr;
    Serial.println("INFO,Ping session could not be created");
  }
}

void stopPing() {
  if (pingHandle == nullptr) return;
  esp_ping_stop(pingHandle);
  esp_ping_delete_session(pingHandle);
  pingHandle = nullptr;
}

void enableCsi() {
  // Field meanings, from the ESP-IDF Wi-Fi CSI API:
  //  lltf_en          - capture the legacy long training field (present in
  //                     every packet, so this is our dependable block)
  //  htltf_en         - capture the 802.11n HT long training field
  //  stbc_htltf2_en   - space-time-block-code LTF; off, we do not need it and
  //                     it only makes the frame longer
  //  ltf_merge_en     - average LLTF and HT-LTF together for HT packets
  //  channel_filter_en- smooths neighbouring sub-carriers. Turned OFF on
  //                     purpose: smoothing throws away exactly the per-
  //                     sub-carrier independence that makes CSI worth having.
  //  manu_scale/shift - manual gain. Left automatic; see the note in the
  //                     README about why the host normalises each frame.
  wifi_csi_config_t csiConfig = {};
  csiConfig.lltf_en = true;
  csiConfig.htltf_en = true;
  csiConfig.stbc_htltf2_en = false;
  csiConfig.ltf_merge_en = true;
  csiConfig.channel_filter_en = false;
  csiConfig.manu_scale = false;
  csiConfig.shift = 0;

  esp_err_t err = esp_wifi_set_csi_config(&csiConfig);
  if (err != ESP_OK) Serial.printf("INFO,csi_config failed 0x%x\n", err);

  err = esp_wifi_set_csi_rx_cb(onCsiFrame, nullptr);
  if (err != ESP_OK) Serial.printf("INFO,csi_rx_cb failed 0x%x\n", err);

  err = esp_wifi_set_csi(true);
  if (err != ESP_OK) {
    Serial.printf("INFO,csi_enable FAILED 0x%x - CSI is not available\n", err);
  } else {
    Serial.println("INFO,CSI enabled");
  }
}

void beginWifiConnection(const char *message) {
  Serial.println(message);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastReconnectAttemptAt = millis();
}

}  // namespace

void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  // Allow a short stall under USB back-pressure instead of silently shredding
  // a line. A stall shows up as a queue drop, which we report; a shredded line
  // would look like corrupt CSI.
  Serial.setTxTimeoutMs(20);
#endif
  delay(500);

  Serial.println("INFO,Wi-Fi CSI Explorer v0.1");
  Serial.println("INFO,format,CSI,seq,rssi,noise,channel,sig_mode,timestamp_us,first_word_invalid,len,values...");
  Serial.println("INFO,values are raw int8 pairs: imag,real per sub-carrier");

  csiQueue = xQueueCreate(kQueueDepth, sizeof(CsiFrame));
  if (csiQueue == nullptr) {
    Serial.println("INFO,FATAL could not allocate CSI queue");
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  // Modem sleep would park the radio between beacons, costing us CSI frames
  // and making rx_ctrl.timestamp imprecise.
  WiFi.setSleep(false);
  beginWifiConnection("INFO,Connecting");

  // HT20 keeps every CSI frame the same 256-byte shape. HT40 would change the
  // sub-carrier layout per packet, which is a needless variable for V0.1.
  esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);

  lastStatsAt = millis();
}

void loop() {
  const unsigned long now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected) {
      wasConnected = true;

      wifi_ap_record_t ap = {};
      if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        memcpy(apBssid, ap.bssid, 6);
        bssidValid = true;
        Serial.printf("INFO,Connected,bssid,%02X:%02X:%02X:%02X:%02X:%02X,channel,%u\n",
                      apBssid[0], apBssid[1], apBssid[2], apBssid[3], apBssid[4], apBssid[5],
                      (unsigned)ap.primary);
      } else {
        Serial.println("INFO,Connected but BSSID unavailable - CSI will not be MAC filtered");
      }
      Serial.print("INFO,IP,");
      Serial.println(WiFi.localIP());
      Serial.print("INFO,Gateway,");
      Serial.println(WiFi.gatewayIP());

      enableCsi();
      startPing();
    }

    // Drain whatever the callback queued. Bounded per pass so a burst cannot
    // starve the rest of the loop.
    static CsiFrame frame;
    for (int i = 0; i < 8; i++) {
      if (xQueueReceive(csiQueue, &frame, 0) != pdTRUE) break;
      emitFrame(frame);
    }

    if (now - lastStatsAt >= kStatsIntervalMs) emitStats(now);
    return;
  }

  if (wasConnected) {
    wasConnected = false;
    bssidValid = false;
    stopPing();
    esp_wifi_set_csi(false);
    Serial.println("INFO,Disconnected");
  }

  if (now - lastReconnectAttemptAt >= kReconnectIntervalMs) {
    beginWifiConnection("INFO,Reconnecting");
  }
}
