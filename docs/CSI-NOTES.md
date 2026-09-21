# CSI engineering notes

Working notes for the v0.1 acquisition path. The README explains the concepts; this file
records the decisions and the evidence behind them.

## Why PlatformIO + Arduino rather than ESP-IDF

The CSI work is done with the official ESP-IDF C API. The question was only which build
system delivers it. Checked on this machine:

* `~/.platformio/packages/framework-arduinoespressif32/tools/sdk/esp32s3/sdkconfig`
  contains `CONFIG_ESP32_WIFI_CSI_ENABLED=y`.
* `nm` on `libnet80211.a` shows `esp_wifi_set_csi`, `esp_wifi_set_csi_config` and
  `esp_wifi_set_csi_rx_cb` are compiled in, and `libpp.a` has the `ic_*` CSI plumbing.
* `lwip/include/apps/ping/ping_sock.h` is present and `esp_ping_new_session` /
  `esp_ping_start` are linked, so controlled traffic needs no extra library.

So CSI is fully available without installing ESP-IDF. Against that, a native ESP-IDF
project would have meant installing the toolchain, CMake and Ninja (none present here)
for no gain at this milestone. The Arduino layer is only the build system and the USB
serial driver; every CSI call is the official one.

**When to revisit:** if we want Espressif's `esp-radar` sensing library or the newer
`csi_recv_router` example verbatim, those are ESP-IDF projects and we should move.

## ESP-IDF version

The Arduino core in use (`framework-arduinoespressif32` 3.20017, Arduino core 2.0.17) is
built on **ESP-IDF 4.4.7** — confirmed from `esp_idf_version.h` in the S3 SDK.

This was not chosen for novelty. It is the version the installed, working toolchain
already pins, which makes the build reproducible on this machine today. The CSI API shape
on 4.4 is the "legacy" field set (`lltf_en`, `htltf_en`, `stbc_htltf2_en`, `ltf_merge_en`,
`channel_filter_en`, `manu_scale`, `shift`) — the same fields Espressif's own examples use
for every chip except the C5/C6 family, which have a newer `acquire_csi_*` config.

## Transport arithmetic

Sizes are decimal throughout this table (1 kB = 1000 bytes), and a 115200 baud 8N1 UART
carries 11520 B/s = **11.5 kB/s**.

A realistic HT20 line measured **893 bytes**. The worst case — every one of the 256 samples
rendering as `-128` — is **1328 bytes**, which is what the firmware's 2048-byte line buffer
and 4096-byte USB TX ring are sized against.

| Rate | Typical (893 B) | Worst case (1328 B) | vs 115200 baud UART |
| --- | --- | --- | --- |
| 10 Hz | 8.9 kB/s | 13.3 kB/s | typical fits, worst case does not |
| **20 Hz** | **17.9 kB/s** | **26.6 kB/s** | **1.6x over — UART cannot carry it** |
| 50 Hz | 44.7 kB/s | 66.4 kB/s | 3.9x over |
| 100 Hz | 89.3 kB/s | 132.8 kB/s | 7.8x over |

Hence native USB CDC, where the baud setting is ignored and the link runs at USB
full-speed. 20 Hz uses a small fraction of that. This is why the RSSI project's 115200
assumption could not simply be carried over.

(An earlier comment in `src/main.cpp` said "~28 kB/s at 20 Hz" while this table said 17.4.
Both were defensible — one was the worst-case line, the other a typical line in KiB — but
they read as a contradiction. The figures above are now the single source, in decimal kB,
and `src/main.cpp` quotes them.)

Espressif's Python tooling sometimes recommends UART over USB Serial/JTAG. That advice is
about their host scripts and the small USB-Serial-JTAG FIFO dropping data when the host
stops reading. Our mitigation is different: the firmware sizes the TX ring above one whole
line, refuses to start a line it cannot fit, counts every drop, and the browser reports all
of them. Nothing is dropped silently.

## Firmware hardening (v0.1.1)

Found by reading the code and the Arduino core, all fixable without hardware.

**The USB transmit ring was 256 bytes.** `HWCDC::begin()` creates a 256-byte TX ring if
none exists. A CSI line is ~900-1330 bytes, so every single `Serial.write()` was entering
the chunked blocking retry path in `HWCDC::write()`, waiting up to `tx_timeout_ms` per
chunk. Fixed with `Serial.setTxBufferSize(4096)` **before** `Serial.begin()` — `begin()`
only allocates when the ring is null, so the order matters.

**A partial line could be written under back-pressure.** `emitFrame()` now checks
`Serial.availableForWrite()` and, if a whole line does not fit, drops the frame and counts
it (`drop_usb_busy`) instead of blocking mid-line. A truncated line reaches the host as
corruption; a counted drop is information.

**A roam or channel-follow silently killed the capture.** The STA can move to a different
BSSID, or follow the AP to a different channel, without ever emitting a disconnect event.
The BSSID filter would then reject *every* frame and the only symptom would be
`drop_mac` climbing. The association is now re-read every 2 s; a change updates the filter,
announces `INFO,link,<bssid>,<channel>` so the host can drop its baseline, and flushes the
queue of frames measured on the old link.

**The callback could send to a null queue.** If `xQueueCreate` failed, `setup()` returned
but `loop()` still ran and would still register the CSI callback. Guarded in both places.

**Oversized frames were discarded rather than recorded.** The cap was 256 bytes, so a frame
carrying a third LTF block would be counted as `drop_size` and lost. Raised to 384: such a
frame is now recorded with its true length and the host can decide. Anything past 384 is
still counted as corruption.

**`emitFrame` trusted `snprintf`'s return value.** It accumulated the *would-be* length,
which is only safe because the buffer happened to be large enough. Now every value checks
the remaining space explicitly before writing.

**Ping lifecycle leaks and races.** `esp_ping_start()` failing left a non-null handle, so
`startPing()` would never retry. A gateway of `0.0.0.0` produced a ping session that could
never generate traffic. Both handled; ping is retried from the loop if it was deferred.

**Stats window across a disconnect.** `lastStatsAt` was not reset on reconnect, so the first
STAT line after a long outage reported a rate averaged over the outage. Reset on connect.

**Bandwidth ordering.** `esp_wifi_set_bandwidth(HT20)` now runs before `WiFi.begin()` so the
association is negotiated with it in force.

### Deliberately not changed

* The counters stay `uint32_t`. At 20 Hz, `emitted` needs 6.8 years to wrap. The host treats
  a counter going *backwards* as an ESP32 restart, which is the case that actually happens.
* `rx_ctrl.timestamp` is a 32-bit microsecond counter and wraps every ~71.6 minutes. It is
  recorded as-is and only ever used as a relative value; the host's own receive timestamp is
  the replay clock, so the wrap is harmless. Documented rather than worked around.
* The static `CsiFrame` scratch in the callback stays. The callback runs on one task and is
  not reentrant, and 400 bytes is a lot to put on the Wi-Fi task's stack.
* The per-pass drain limit of 8 frames stays. At 20 Hz with a queue depth of 12, that is
  600 ms of slack.

## Host architecture

`dashboard/csi-core.js` holds every calculation and has no DOM, no Web Serial and no timers.
`dashboard/serial-link.js` holds the Web Serial lifecycle. `dashboard/index.html` is glue and
drawing. That split is what makes 96 Node tests possible with no browser and no board.

The rule that makes live and replay equivalent: **every time-dependent decision inside
`CsiPipeline` uses the frame's own `tHostMs`, never the wall clock.** Live stamps that value
and records it; replay feeds the recorded value straight back. Frame rate, jitter, the
rolling quality window and the baseline duration therefore all reproduce exactly. The single
exception is `tickWatchdog()`, which must use wall time because "the input stopped" cannot be
detected from data that never arrived — and it sits outside the measurement path, its only
power being to fail a baseline capture.

## Known open questions

* **Not yet verified on hardware.** Everything here is compile-verified and tested against
  synthetic frames. Real CSI acquisition has not been observed yet. The synthetic fixtures
  in `tests/fixtures.mjs` exist to test software behaviour; their numerical response is not
  evidence about sensing performance and must never be quoted as such.
* **50 Hz is prepared, not proven.** `CSI_PING_INTERVAL_MS=20` compiles and the transport
  has the bandwidth. Whether the AP answers 50 pings a second, and whether the radio
  delivers 50 usable frames a second, are hardware questions that are still open.
* **iPhone hotspot suitability is unproven for CSI.** It worked for RSSI, but a phone
  hotspot may rate-limit or coalesce ICMP replies, and it may change channel. If the frame
  rate is unstable, the minimum extra hardware is an ordinary 2.4 GHz Wi-Fi router used as
  a fixed AP — that removes the phone's power management from the experiment entirely.
* **Automatic gain.** `manu_scale` is false, so absolute amplitude is not comparable
  between frames; the host normalises each frame to compensate. If absolute scale is ever
  needed, switch to manual scaling with a fixed shift and re-check for clipping.
