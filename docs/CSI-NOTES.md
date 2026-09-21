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

A realistic HT20 line measured 893 bytes.

| Rate | Throughput | vs 115200 baud UART (11.5 kB/s) |
| --- | --- | --- |
| 10 Hz | 8.7 kB/s | fits |
| **20 Hz** | **17.4 kB/s** | **1.5× over — UART cannot carry it** |
| 50 Hz | 43.6 kB/s | 3.8× over |
| 100 Hz | 87.2 kB/s | 7.6× over |

Hence native USB CDC, where the baud setting is ignored and the link runs at USB
full-speed. 20 Hz uses a small fraction of that. This is why the RSSI project's 115200
assumption could not simply be carried over.

Espressif's Python tooling sometimes recommends UART over USB Serial/JTAG. That advice is
about their host scripts and the small USB-Serial-JTAG FIFO dropping data when the host
stops reading. Our mitigation is different: the firmware sets a 20 ms TX timeout so
back-pressure stalls briefly instead of shredding a line, the queue overflow is counted,
short writes are counted, and the browser reports both. Nothing is dropped silently.

## Known open questions

* **Not yet verified on hardware.** Everything here is compile-verified and tested against
  synthetic frames. Real CSI acquisition has not been observed yet.
* **iPhone hotspot suitability is unproven for CSI.** It worked for RSSI, but a phone
  hotspot may rate-limit or coalesce ICMP replies, and it may change channel. If the frame
  rate is unstable, the minimum extra hardware is an ordinary 2.4 GHz Wi-Fi router used as
  a fixed AP — that removes the phone's power management from the experiment entirely.
* **Automatic gain.** `manu_scale` is false, so absolute amplitude is not comparable
  between frames; the host normalises each frame to compensate. If absolute scale is ever
  needed, switch to manual scaling with a fixed shift and re-check for clipping.
