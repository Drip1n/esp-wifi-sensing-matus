# Wi-Fi CSI Explorer (v0.1)

An ESP32-S3 experiment that reads **Channel State Information** from a live Wi-Fi link
and draws it, so you can watch the radio channel change when someone walks through it.

```text
Wi-Fi → ESP32-S3 CSI → USB Serial → Browser → sub-carrier magnitudes → change vs baseline
```

> The previous milestone, **RSSI v0.2**, is preserved on branch `mino`. This branch
> (`mino-csi`) is a different firmware for the same board.

## RSSI vs CSI

**RSSI** is *one* number per packet: total received power. It is a summary — everything
the radio did to the signal, averaged into a single value.

**CSI** is *many* numbers per packet. Wi-Fi sends data on dozens of narrow frequencies
called **OFDM sub-carriers**, and CSI reports how the channel treated each one separately.

Why that matters:

```text
        AP  ))))))))))  direct path  ))))))))))  ESP32
             \                                    /
              \        reflected path            /
               \                                /
                \            PERSON            /
                 ))))))))))))  X  ))))))))))))
```

A radio signal reaches the receiver several times over: straight through, and bounced off
walls, floor and people. Those copies arrive slightly out of step and add up differently
at each frequency — this is **multipath**. When a person moves, the reflected paths change
length, so some sub-carriers get stronger while others get weaker. RSSI averages that
structure away; CSI shows it.

### What RSSI v0.2 built
Adaptive, noise-aware motion detection from a single RSSI value at 20 Hz: calibration
measured the link's own noise floor, and the threshold was derived from it.

### What CSI v0.1 adds
Per-sub-carrier magnitudes instead of one number, a captured **baseline** of the still
room, and a live per-sub-carrier **difference** from that baseline. It deliberately stops
there: this release is about *seeing* the channel, not classifying it.

## What this does NOT do

CSI v0.1 shows **how the propagation channel changed**. That is all.

It does not measure a person's distance, position, direction or pose, and it does not do
breathing or heart rate. A changing pattern means the radio path changed — a person, a
door, a moved phone, or the AP changing its own behaviour. The cause is not identified.

Phase is deliberately not displayed. Raw ESP32 CSI phase contains uncorrected hardware
timing offsets, so plotting it as "physical phase" would be misleading without correction.

## Hardware and setup

* ESP32-S3 dev board (tested target: `esp32-s3-devkitm-1`, N16R8).
* A 2.4 GHz access point. **An iPhone hotspot must have "Maximize Compatibility" ON**,
  otherwise it runs 5 GHz only and the ESP32 cannot see it at all.
* Connect the board's **native USB port** (see *Which USB port?* below).

1. Copy `include/secrets.example.h` to `include/secrets.h` and fill in your Wi-Fi details.
2. PlatformIO **Upload**.
3. From the project root: `python3 -m http.server 8000`
4. Open <http://localhost:8000/dashboard/> in desktop Chrome or Edge.
5. Press **Connect ESP32**, pick the device, and wait for frames.
6. Keep the room still and press **Capture baseline** (3 seconds).
7. Walk through the link and watch the lower graph.

### Which USB port?

Many ESP32-S3 N16R8 boards have **two** USB-C sockets: one wired to a USB-UART bridge
chip (often labelled `COM`/`UART`) and one wired to the chip's own USB peripheral
(labelled `USB`). This firmware is built with `ARDUINO_USB_CDC_ON_BOOT=1` and
`ARDUINO_USB_MODE=1`, so it speaks over the **native USB port**.

This matters more for CSI than it did for RSSI: at 20 Hz a CSI line is ~890 bytes, which
is **17.4 kB/s — more than a 115200 baud UART can carry (11.5 kB/s)**. Native USB CDC
ignores the baud setting and runs at USB speed, so it has ample headroom. If you plug into
the UART port you will get dropped and truncated lines.

If you are unsure which socket is which, plug in and check the device name: the native
port usually appears as `/dev/cu.usbmodem*`, a bridge chip as `/dev/cu.usbserial*` or
`/dev/cu.wchusbserial*`. If CSI frames never arrive, try the other socket first.

## How CSI is acquired

The firmware uses the official ESP-IDF CSI C API directly (`esp_wifi_set_csi_config`,
`esp_wifi_set_csi_rx_cb`, `esp_wifi_set_csi`).

CSI only exists when a packet is *received*, so the firmware **pings the gateway every
50 ms**. Each echo reply is a received packet, and each received packet carries a channel
measurement — that is what makes the ~20 Hz rate steady and repeatable instead of
depending on whatever traffic happens to be in the air.

Frames are filtered to the access point's BSSID. CSI from any other transmitter describes
a completely different path through the room, so mixing it in would make the baseline
meaningless.

The Wi-Fi callback only copies each frame into a queue; a separate loop formats and prints
it. Anything slower than a `memcpy` inside that callback would stall the Wi-Fi stack.

### CSI configuration used

| Field | Value | Why |
| --- | --- | --- |
| `lltf_en` | true | The legacy training field is in every packet type |
| `htltf_en` | true | The 802.11n training field |
| `stbc_htltf2_en` | false | Not needed; only makes frames longer |
| `ltf_merge_en` | true | Average LLTF and HT-LTF for HT packets |
| `channel_filter_en` | **false** | Smoothing would destroy the per-sub-carrier independence that makes CSI useful |
| `manu_scale` | false | Automatic gain (see normalisation below) |

Bandwidth is forced to **HT20** so every frame has the same shape.

### Frame format on the wire

```text
CSI,seq,rssi,noise,channel,sig_mode,timestamp_us,first_word_invalid,len,v0,v1,...
STAT,uptime_ms,rate,emitted,drop_queue,drop_mac,drop_size,truncated,rssi,free_heap
INFO,...
```

`len` counts **bytes**. Each sub-carrier is two signed bytes, **imaginary first, then
real**, so `v[2k]` and `v[2k+1]` are one sub-carrier. HT20 gives 256 bytes: an LLTF block
of 64 sub-carriers followed by an HT-LTF block of 64.

The host visualises the **LLTF block**, because it is present whether the AP replied with
11g or 11n, so the vector keeps the same meaning.

### From I/Q to a picture

```text
magnitude = sqrt(I² + Q²)
```

Two further steps matter:

* **Sub-carrier order.** The hardware stores indices `0..31` then `-32..-1`. The graph
  reorders them so `-32` is on the left and `+31` on the right.
* **Normalisation.** Automatic gain control makes the absolute scale drift between frames,
  so each frame is divided by its own average. That cancels the gain and leaves the
  *shape* across sub-carriers, which is the part multipath actually changes.

Only sub-carriers `±1..±26` are analysed. Index 0 is the DC null and `|k| > 26` are guard
bands — they carry nothing. The first two array positions are always dropped as well,
because the hardware can flag the first four bytes invalid, and letting that flag toggle
in and out of the average would look like channel activity.

## Physical test plan

Put the AP and the ESP32 **2–3 m apart** and leave both untouched for the whole session.

1. Start the stream and check **CSI frames/s** is steady near 20.
2. With the room empty and still, press **Capture baseline**.
3. Stand still, off the path. The lower graph should stay near zero.
4. Walk **directly through** the AP ↔ ESP32 line. Expect large bars.
5. Stop and stand **between** them. Expect a changed but steady pattern.
6. Leave the path. The bars should shrink again.
7. Move **beside** the path. Expect a weaker response.
8. **Last**, move the AP itself. Expect a very large change — and note that the dashboard
   does not claim this was a person.

Record **Channel activity** for each step, plus frame rate and the Diagnostics counters.

## Troubleshooting

Open **Diagnostics** at the bottom of the dashboard.

| What you see | What it means |
| --- | --- |
| `CSI frames parsed` stays 0 while `Lines received` grows | Serial works, but the firmware is not producing CSI — check it joined Wi-Fi |
| `Malformed lines` climbing | Usually the UART port instead of the native USB port |
| `Sequence gaps` climbing | Frames lost between firmware and browser |
| `Firmware rate / drops` shows `q` > 0 | The firmware queue overflowed: USB back-pressure |
| `Firmware rate / drops` shows `m` > 0 | CSI from other transmitters, correctly filtered out |
| Frame rate far below 20 | The AP is not answering pings at the requested rate |
