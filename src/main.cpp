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
//
// NOTHING HERE HAS BEEN VERIFIED AGAINST REAL CSI YET. It compiles and its
// logic is reasoned about and tested on the host side; no frame from a real
// radio has been observed.
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
// frame, so this is effectively our sampling rate.
//
//   100 ms = 10 Hz   ~8.9 kB/s over USB
//    50 ms = 20 Hz  ~17.9 kB/s over USB   <- default
//    20 ms = 50 Hz  ~44.7 kB/s over USB   <- PREPARED, NOT VERIFIED
//
// (Figures for a typical 893-byte HT20 line; a worst-case line of all
// three-digit values is about 1.5x that. See docs/CSI-NOTES.md.)
//
// 50 Hz is configuration only. Whether the AP actually answers 50 pings a
// second, and whether the radio delivers 50 usable frames a second, is an
// open hardware question - do not assume it works until it is measured.
#ifndef CSI_PING_INTERVAL_MS
#define CSI_PING_INTERVAL_MS 50
#endif
static_assert(CSI_PING_INTERVAL_MS >= 20 && CSI_PING_INTERVAL_MS <= 1000,
              "CSI_PING_INTERVAL_MS must be between 20 ms (50 Hz) and 1000 ms (1 Hz)");

// Identity for the dataset's data model. One node today; the field exists so a
// two-node capture is a superset of this one rather than a different format.
#ifndef CSI_NODE_ID
#define CSI_NODE_ID "esp01"
#endif

#define CSI_FIRMWARE_VERSION "csi-0.1.1"

namespace {

// ESP32-S3 in HT20 normally gives 256 bytes of CSI: two long-training-field
// blocks (LLTF then HT-LTF) of 64 sub-carriers each, 2 bytes per sub-carrier.
// The cap is set at 384 rather than 256 so that a frame carrying a third LTF
// block is RECORDED (with its true length reported) instead of being counted
// as "oversized" and thrown away. Anything past 384 really is wrong.
constexpr size_t kCsiMaxBytes = 384;
constexpr size_t kQueueDepth = 12;
constexpr unsigned long kStatsIntervalMs = 1000;
constexpr unsigned long kReconnectIntervalMs = 10000;
// How often the association is re-read. The STA can roam to a different BSSID
// or follow the AP to a different channel WITHOUT ever reporting a disconnect;
// without this check the MAC filter would keep matching the old BSSID and
// silently drop every frame.
constexpr unsigned long kLinkCheckIntervalMs = 2000;

// A line is at most: 49 bytes of header + kCsiMaxBytes values of up to 5 bytes
// each (",-128") + a newline = 1970 bytes.
constexpr size_t kLineBufferBytes = 2048;
// The default HWCDC transmit ring is 256 bytes - far smaller than one CSI
// line, which forces every write into a blocking multi-chunk loop that can
// stall the main loop for milliseconds per frame. Sizing the ring above a full
// line lets the whole line go in one non-blocking push.
constexpr size_t kUsbTxBufferBytes = 4096;

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
uint8_t apChannel = 0;
bool wasConnected = false;
bool csiEnabled = false;
unsigned long lastReconnectAttemptAt = 0;
unsigned long lastStatsAt = 0;
unsigned long lastLinkCheckAt = 0;

// Counters. Every one of these is printed, because a silent drop is the
// difference between "the channel is calm" and "we lost half the data".
//
// All are uint32_t. At 20 Hz the emitted counter needs 6.8 years to wrap, and
// the host treats any counter going BACKWARDS as an ESP32 restart (which
// invalidates its baseline) rather than as a negative delta.
volatile uint32_t frameSeq = 0;
volatile uint32_t droppedQueueFull = 0;
volatile uint32_t droppedWrongMac = 0;
volatile uint32_t droppedOversized = 0;
uint32_t emittedTotal = 0;
uint32_t truncatedWrites = 0;
uint32_t droppedUsbBusy = 0;
uint32_t emittedSinceStats = 0;

// ---------------------------------------------------------------------------
// CSI callback. This runs on the Wi-Fi task, so it must stay tiny: copy the
// frame into a queue and return. Formatting text or touching Serial here would
// stall the Wi-Fi stack and cost us packets.
//
// validate -> MAC filter -> memcpy into a bounded queue -> return. Nothing else
// belongs in this function.
// ---------------------------------------------------------------------------
void onCsiFrame(void *ctx, wifi_csi_info_t *info) {
  (void)ctx;
  if (info == nullptr || info->buf == nullptr) return;
  // The callback can in principle outlive the queue (allocation failure, or a
  // future teardown path). Sending to a null queue would be a crash.
  if (csiQueue == nullptr) return;

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
  // (one Wi-Fi task) and a 400-byte frame is a lot to put on that task's stack.
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
//
// timestamp_us is rx_ctrl.timestamp: a 32-bit microsecond counter, so it wraps
// roughly every 71.6 minutes. It is recorded as-is and is only ever used as a
// relative time; the host's own receive timestamp is the replay clock.
// ---------------------------------------------------------------------------
char lineBuffer[kLineBufferBytes];

void emitFrame(const CsiFrame &frame) {
  int n = snprintf(lineBuffer, sizeof(lineBuffer),
                   "CSI,%u,%d,%d,%u,%u,%u,%u,%u",
                   (unsigned)frame.seq, (int)frame.rssi, (int)frame.noiseFloor,
                   (unsigned)frame.channel, (unsigned)frame.sigMode,
                   (unsigned)frame.timestamp, (unsigned)frame.firstWordInvalid,
                   (unsigned)frame.len);
  if (n <= 0 || (size_t)n >= sizeof(lineBuffer)) return;

  for (uint16_t i = 0; i < frame.len; i++) {
    // Space for ",-128" plus the newline plus the terminator, checked before
    // every value rather than trusting snprintf's return to stay in range.
    const size_t remaining = sizeof(lineBuffer) - (size_t)n;
    if (remaining < 8) return;
    const int written = snprintf(lineBuffer + n, remaining, ",%d", (int)frame.data[i]);
    if (written <= 0 || (size_t)written >= remaining) return;
    n += written;
  }
  if ((size_t)n + 1 >= sizeof(lineBuffer)) return;
  lineBuffer[n++] = '\n';

  // Never emit HALF a line. If the USB transmit ring cannot take the whole
  // line, the write would block in a chunked retry loop and stall the drain;
  // dropping the frame and counting it is both faster and more honest, because
  // a partial line reaches the host as corruption.
  const int space = Serial.availableForWrite();
  if (space >= 0 && space < n) {
    droppedUsbBusy++;
    return;
  }

  // A short write means USB back-pressure cut the line anyway. The host will
  // reject the malformed line; we count it so the cause is never a mystery.
  size_t written = Serial.write((const uint8_t *)lineBuffer, (size_t)n);
  if (written != (size_t)n) truncatedWrites++;
  emittedTotal++;
  emittedSinceStats++;
}

void emitStats(unsigned long now) {
  const float seconds = (now - lastStatsAt) / 1000.0f;
  const float rate = seconds > 0 ? emittedSinceStats / seconds : 0.0f;
  Serial.printf("STAT,%lu,%.1f,%u,%u,%u,%u,%u,%u,%d,%u\n",
                now, rate, (unsigned)emittedTotal,
                (unsigned)droppedQueueFull, (unsigned)droppedWrongMac,
                (unsigned)droppedOversized, (unsigned)truncatedWrites,
                (unsigned)droppedUsbBusy,
                WiFi.RSSI(), (unsigned)ESP.getFreeHeap());
  emittedSinceStats = 0;
  lastStatsAt = now;
}

void announceLink() {
  Serial.printf("INFO,link,%02X:%02X:%02X:%02X:%02X:%02X,%u\n",
                apBssid[0], apBssid[1], apBssid[2], apBssid[3], apBssid[4], apBssid[5],
                (unsigned)apChannel);
}

// Re-read the association. Returns true when the link identity changed, which
// the host treats as "this is a different radio path, throw the baseline away".
bool refreshLink(bool announceWhenUnchanged) {
  wifi_ap_record_t ap = {};
  if (esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return false;

  const bool changed = !bssidValid || memcmp(ap.bssid, apBssid, 6) != 0 || ap.primary != apChannel;
  memcpy(apBssid, ap.bssid, 6);
  apChannel = ap.primary;
  bssidValid = true;
  if (changed || announceWhenUnchanged) announceLink();
  return changed;
}

void startPing() {
  if (pingHandle != nullptr) return;

  // DHCP has finished by the time WiFi.status() is WL_CONNECTED, but a gateway
  // of 0.0.0.0 would make every ping fail silently and produce no CSI at all.
  const uint32_t gateway = WiFi.gatewayIP();
  if (gateway == 0) {
    Serial.println("INFO,Gateway not known yet - ping deferred");
    return;
  }

  // Pinging the gateway is what actually generates our CSI: every echo reply
  // the AP sends back is a packet we receive, and every received packet
  // carries a channel measurement. Without traffic there is almost nothing to
  // measure except the AP's ~10 Hz beacons.
  esp_ping_config_t config = ESP_PING_DEFAULT_CONFIG();
  ip_addr_t target = {};
  target.type = IPADDR_TYPE_V4;
  target.u_addr.ip4.addr = gateway;
  config.target_addr = target;
  config.count = ESP_PING_COUNT_INFINITE;
  config.interval_ms = CSI_PING_INTERVAL_MS;
  config.timeout_ms = 1000;
  config.task_stack_size = 4096;

  esp_ping_callbacks_t callbacks = {};
  if (esp_ping_new_session(&config, &callbacks, &pingHandle) != ESP_OK) {
    pingHandle = nullptr;
    Serial.println("INFO,Ping session could not be created");
    return;
  }
  if (esp_ping_start(pingHandle) != ESP_OK) {
    // Do not leak the session: without this the handle stays non-null and
    // startPing() would never try again.
    esp_ping_delete_session(pingHandle);
    pingHandle = nullptr;
    Serial.println("INFO,Ping session could not be started");
    return;
  }
  Serial.printf("INFO,Ping started at %d ms interval\n", CSI_PING_INTERVAL_MS);
}

void stopPing() {
  if (pingHandle == nullptr) return;
  esp_ping_stop(pingHandle);
  esp_ping_delete_session(pingHandle);
  pingHandle = nullptr;
}

void enableCsi() {
  // Without a queue there is nowhere to put a frame, so registering the
  // callback would only burn Wi-Fi task time.
  if (csiQueue == nullptr) {
    Serial.println("INFO,CSI not enabled - no queue");
    return;
  }

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

  // Registering the same callback again is idempotent; this runs on every
  // reconnect so a reassociation cannot leave CSI unhooked.
  err = esp_wifi_set_csi_rx_cb(onCsiFrame, nullptr);
  if (err != ESP_OK) Serial.printf("INFO,csi_rx_cb failed 0x%x\n", err);

  err = esp_wifi_set_csi(true);
  if (err != ESP_OK) {
    csiEnabled = false;
    Serial.printf("INFO,csi_enable FAILED 0x%x - CSI is not available\n", err);
  } else {
    csiEnabled = true;
    Serial.println("INFO,CSI enabled");
  }
}

void disableCsi() {
  if (!csiEnabled) return;
  esp_wifi_set_csi(false);
  csiEnabled = false;
}

void beginWifiConnection(const char *message) {
  Serial.println(message);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastReconnectAttemptAt = millis();
}

}  // namespace

void setup() {
  // Must come before begin(): begin() only creates the ring if none exists.
  Serial.setTxBufferSize(kUsbTxBufferBytes);
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  // Allow a short stall under USB back-pressure instead of silently shredding
  // a line. With a transmit ring larger than one line this rarely engages at
  // all, because emitFrame() checks for room first.
  Serial.setTxTimeoutMs(20);
#endif
  delay(500);

  Serial.println("INFO,Wi-Fi CSI Explorer v0.1");
  Serial.println("INFO,firmware," CSI_FIRMWARE_VERSION);
  Serial.println("INFO,node," CSI_NODE_ID);
  Serial.printf("INFO,rate,%d,%d\n", 1000 / CSI_PING_INTERVAL_MS, CSI_PING_INTERVAL_MS);
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

  // HT20 keeps every CSI frame the same shape. HT40 would change the
  // sub-carrier layout per packet, which is a needless variable for V0.1.
  // Set before begin() so the association is negotiated with it in force.
  esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);

  beginWifiConnection("INFO,Connecting");
  lastStatsAt = millis();
  lastLinkCheckAt = lastStatsAt;
}

void loop() {
  const unsigned long now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected) {
      wasConnected = true;

      if (!refreshLink(true)) {
        Serial.println("INFO,Connected but BSSID unavailable - CSI will not be MAC filtered");
      }
      Serial.print("INFO,IP,");
      Serial.println(WiFi.localIP());
      Serial.print("INFO,Gateway,");
      Serial.println(WiFi.gatewayIP());

      enableCsi();
      startPing();
      // A fresh window, so the first STAT line is not a rate averaged over
      // however long the board spent disconnected.
      lastStatsAt = now;
      emittedSinceStats = 0;
      lastLinkCheckAt = now;
    }

    // The STA can roam or follow the AP to another channel without reporting a
    // disconnect. Re-reading the association keeps the MAC filter pointed at
    // the transmitter we are actually listening to, and tells the host the
    // radio path changed so it can drop a baseline that no longer applies.
    if (now - lastLinkCheckAt >= kLinkCheckIntervalMs) {
      lastLinkCheckAt = now;
      if (refreshLink(false)) {
        // Frames captured under the old link are a different measurement.
        xQueueReset(csiQueue);
      }
    }

    // Ping may have been deferred because the gateway was not known yet.
    if (pingHandle == nullptr) startPing();

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
    apChannel = 0;
    stopPing();
    disableCsi();
    // Anything still queued was measured on a link we have now lost.
    if (csiQueue != nullptr) xQueueReset(csiQueue);
    Serial.println("INFO,Disconnected");
  }

  if (now - lastReconnectAttemptAt >= kReconnectIntervalMs) {
    beginWifiConnection("INFO,Reconnecting");
  }
}
