# Wi-Fi CSI Explorer (v0.1)

An ESP32-S3 experiment that reads **Channel State Information** from a live Wi-Fi link,
draws it, **records it to a file**, and **replays that file** through the same analysis
without the board attached.

```text
Wi-Fi → ESP32-S3 CSI → USB Serial → Browser → sub-carrier magnitudes → change vs baseline
                                       │
                                       ├─→ record → dataset.jsonl
                                       │                 │
                                       └──── replay ←────┘
```

> The previous milestone, **RSSI v0.2**, is preserved on branch `mino`. This branch
> (`mino-csi`) is a different firmware for the same board.

> **Not yet verified on hardware.** Everything here compiles, and the host pipeline has 96
> automated tests, but no frame from a real radio has been observed yet. Nothing in this
> repository should be read as evidence that CSI sensing works physically.

**Working on this repository?** Start with **[AGENTS.md](AGENTS.md)**, then
[docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) (what is true now),
[docs/ROADMAP.md](docs/ROADMAP.md) (where it is going),
[docs/EXPERIMENT_PROTOCOL.md](docs/EXPERIMENT_PROTOCOL.md) (how experiments are run) and
[docs/PROGRESS_LOG.md](docs/PROGRESS_LOG.md) (what happened so far).

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

### What CSI v0.1 shows
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

---

## Why record and replay matters

This is the point of the release, so it goes near the top.

Without recording, improving an algorithm looks like this:

```text
change algorithm → walk through the room → squint at the graph → change algorithm → walk again
```

Every comparison is against a **different** walk. The room, the body, the speed, the AP's
mood and the Wi-Fi traffic all changed between runs, so a difference in the output could be
the algorithm or could be the walk. There is no way to tell.

With recording it looks like this:

```text
REAL HARDWARE → RECORD → REPLAY → ANALYSE → MODIFY ALGORITHM → REPLAY THE SAME DATA → COMPARE
```

The same captured RF event goes through version A and version B. Any difference in the
output is the algorithm, because nothing else moved. Walking through the room becomes
something done **once**, carefully, and the ten algorithm iterations afterwards cost
seconds each and need no hardware at all.

It also means a good capture is an asset. A clean five-minute walk recorded today is still
answering questions next month.

For that to be true the replay has to be *exact*, not approximate. It is:
`tests/equivalence.test.mjs` feeds the same frames down both paths and asserts the magnitude
vector, the normalised vector, the baseline, the activity metric, the frame counters and the
data-quality verdict all match to 1e-12 across ten scenarios.

---

## Hardware and setup

* ESP32-S3 dev board (tested target: `esp32-s3-devkitm-1`, N16R8).
* A 2.4 GHz access point. **An iPhone hotspot must have "Maximize Compatibility" ON**,
  otherwise it runs 5 GHz only and the ESP32 cannot see it at all.
* Connect the board's **native USB port** (see *Which USB port?* below).

1. Copy `include/secrets.example.h` to `include/secrets.h` and fill in your Wi-Fi details.
2. PlatformIO **Upload**.
3. From the project root: `python3 -m http.server 8000`
4. Open <http://localhost:8000/dashboard/> in desktop Chrome or Edge.

The dashboard is an ES module, so it **must be served over http**. Opening `index.html`
as a `file://` URL will fail with a CORS error.

### Which USB port?

Many ESP32-S3 N16R8 boards have **two** USB-C sockets: one wired to a USB-UART bridge
chip (often labelled `COM`/`UART`) and one wired to the chip's own USB peripheral
(labelled `USB`). This firmware is built with `ARDUINO_USB_CDC_ON_BOOT=1` and
`ARDUINO_USB_MODE=1`, so it speaks over the **native USB port**.

This matters more for CSI than it did for RSSI: at 20 Hz a typical CSI line is 893 bytes,
which is **17.9 kB/s — more than a 115200 baud UART can carry (11.5 kB/s)**. Native USB CDC
ignores the baud setting and runs at USB speed, so it has ample headroom. If you plug into
the UART port you will get dropped and truncated lines.

If you are unsure which socket is which, plug in and check the device name: the native
port usually appears as `/dev/cu.usbmodem*`, a bridge chip as `/dev/cu.usbserial*` or
`/dev/cu.wchusbserial*`. If CSI frames never arrive, try the other socket first.

---

## 1. Live mode

Press **LIVE**, then **Connect ESP32** and pick the device. Frames should start within a
few seconds of the board joining Wi-Fi.

Keep the room still and press **Capture baseline** (3 seconds). Then walk through the link
and watch the lower graph.

The baseline is thrown away, with an explanation on screen, whenever the underlying
measurement changes — see *Sessions and baselines* below.

## 2. Recording a dataset

In live mode, optionally type an **experiment label** (`still`, `walk_direct`, `walk_near`,
`walk_off_axis`, `stand_in_path`, `move_ap`) and a free-text note, then press
**Start recording**.

* Chrome and Edge offer a **save dialog**. Choosing a file streams the dataset straight to
  disk as it arrives — nothing accumulates in the tab, and the length is limited by the
  disk, not by RAM.
* If the save dialog is unavailable or cancelled, the dataset is buffered **in the tab** in
  ~1 MB chunks and downloaded when you stop. That buffer stops at **24 MB** (14–21 minutes
  at 20 Hz); the partial dataset is still valid and still downloads.

Press **Stop recording** to finish. The label and the note go into the file's session
header, which is what makes a folder of datasets identifiable six weeks later.

**Secrets are never recorded.** The SSID and Wi-Fi password never leave `include/secrets.h`.

## 3. Replay mode

Press **REPLAY**, then **Load dataset…** and pick a `.jsonl` file. No ESP32 is needed and
none is touched.

| Control | What it does |
| --- | --- |
| **Play** / **Pause** | run / stop the dataset clock |
| **Restart** | back to the first frame (and the pipeline is reset) |
| **Step +1** | advance exactly one frame, ignoring the clock |
| **Playback speed** | 0.25× · 0.5× · 1× · 2× · 4× |
| **Baseline** / **Clear base** | the same baseline capture, run against recorded frames |

Playback uses the **recorded timestamps**, not an assumed 50 ms grid. If the capture had a
1.8-second stall in it, the replay has a 1.8-second stall in it. Rate jitter is reproduced
exactly as captured, because jitter is part of the experiment.

Switching modes wipes every measurement, so a live baseline can never colour a replayed
dataset.

## 4. Dataset format

JSON Lines, schema version 1. Fully specified in
**[docs/DATASET-FORMAT.md](docs/DATASET-FORMAT.md)**, including a Python reader.

## 5. Raw vs normalised magnitude

A toggle above the spectrum. **Normalised** is the default.

**Raw magnitude** — `sqrt(I² + Q²)` as the radio reported it. It keeps the frame's absolute
amplitude, so a genuine change in received power shows up. It is *also* moved by the
receiver's automatic gain control, which is the receiver reacting, not the room changing.

**Normalised magnitude** — each frame divided by its own mean over the analysed
sub-carriers. That cancels any change that scales the whole frame equally (AGC included) and
leaves the *shape* across sub-carriers, which is the part multipath actually changes.

Neither is universally correct. Normalised is better at "did the channel's structure change";
raw is better at "did the amount of power change". The `common_gain_scaling` test fixture
makes the difference concrete: a frame scaled by a drifting factor produces a normalised
activity below 0.02 and a raw difference above 3.

The **CSI activity** number is always computed in the normalised domain, whichever view is
on screen, so the number stays comparable between datasets.

## 6. Data-quality indicator

A badge above the metrics: **GOOD**, **DEGRADED**, **BAD**, or **UNKNOWN**.

This is **transport quality only** — did the measurements arrive intact and on time. It says
nothing about whether anything moved. An empty, still room scores GOOD. A room full of
people scores BAD if the USB cable is bad.

Measured over a rolling 10-second window:

```text
gapRatio       = sequence gaps      / (gaps + frames)
malformedRatio = malformed lines    / (malformed + frames)
espDropRatio   = (queue drops + usb-busy drops + truncated writes) / (that + frames)
rateError      = |measured rate - target rate| / target rate
jitter         = stdev(frame interval) / mean(frame interval)
```

| Verdict | Rule |
| --- | --- |
| **GOOD** | every ratio < 0.5 %, `rateError` < 20 %, `jitter` < 0.35 |
| **BAD** | any ratio > 5 %, or `rateError` > 50 %, or `jitter` > 1.0 |
| **DEGRADED** | anything in between |
| **UNKNOWN** | fewer than 20 frames in the window |

The badge names the worst offender, e.g. `sequence gaps 3.1%`.

**Use it to decide whether an experiment is worth keeping.** A BAD badge means the dataset
is measuring the USB link, not the room.

## 7. Potential clipping

Raw CSI samples are signed 8-bit, so they live in `[-128, +127]`. A sample sitting at the
very edge of that range may have been **clamped** rather than measured.

*Near the limit* is defined as `|v| >= 125` — the outermost three codes at each end, 6 of
256 code points. The dashboard reports the percentage of such samples across the analysed
sub-carriers of the last 10 seconds, and flags it above **1 %**.

This is a hint, not a proof. A high figure means "look at your gain settings before trusting
the amplitudes", not "the radio is definitely saturating".

## 8. Node ID and link ID

Every frame conceptually belongs to `(source, node_id, link_id)`:

```text
source  = "wifi_csi"
node_id = "esp01"          the sensing node
link_id = "esp01-ap"       the radio path between that node and its AP
```

There is **one** node today and this release implements no multi-node anything — no mesh, no
time-division, no synchronisation, no fusion. The fields exist so that when a second ESP32
(or a mmWave radar) is added, its data is a *superset* of this format rather than a different
one, and so host objects are not written as if there could only ever be one of each.

The firmware announces its own id with `INFO,node,esp01` (change with `-D CSI_NODE_ID=...`).

## 9. Experimental CSI activity metric

Labelled **EXP** on the dashboard, and labelled honestly here.

```text
activity = (1 / |A|) · Σ    | n(p) − b(p) |
                        p∈A
```

where `A` is the analysed sub-carrier set (array positions ≥ 2 whose sub-carrier index is
±1…±26), `n` is the current frame's normalised magnitude vector and `b` is the baseline's.

That is all it is: the mean absolute difference from the still-room baseline. No threshold,
no classifier, no adaptation, no machine learning.

It exists **to compare datasets to each other** — "this capture moved the channel more than
that one". It is not person motion, not presence, and not human detection. A door, a moved
phone, or the AP changing its transmit behaviour all raise it.

## 10. Sessions and baselines

A baseline describes one radio path at one moment. When that stops being true, the baseline
is **invalidated** and the dashboard says why:

| Trigger | Why it matters |
| --- | --- |
| BSSID changed | the STA roamed; a different transmitter means a different path |
| Channel changed | different frequencies, different multipath |
| CSI vector length changed | the measurement is a different shape |
| CSI sequence restarted | the firmware rebooted — new session |
| ESP32 counters went backwards | the board restarted between STAT lines |
| Mode switched (live ↔ replay) | different input entirely |
| USB reconnected | a new physical session |

Calibration also **never finishes silently on bad data**. If fewer than 20 frames arrive
during the 3-second window, or the input stops, or the vector changes shape mid-capture,
the baseline is reported as **failed** with the reason, rather than quietly averaging
rubbish.

The firmware helps here: it re-reads the association every 2 seconds and emits
`INFO,link,<bssid>,<channel>` when it changes, because the STA can roam *without* ever
reporting a disconnect.

## 11. Sampling rate

Configured in firmware with `CSI_PING_INTERVAL_MS` (or `-D CSI_PING_INTERVAL_MS=...`).

| Interval | Rate | Transport (typical line) | Status |
| --- | --- | --- | --- |
| 100 ms | 10 Hz | 8.9 kB/s | conservative |
| **50 ms** | **20 Hz** | **17.9 kB/s** | **default** |
| 20 ms | 50 Hz | 44.7 kB/s | **prepared, not verified** |

USB full-speed CDC has far more headroom than any of these. The open questions at 50 Hz are
whether the AP answers 50 pings a second and whether the radio delivers 50 usable frames a
second — both are properties of the hardware and the network, not of this code. **Do not
claim 50 Hz works until it has been measured.**

---

## How CSI is acquired

The firmware uses the official ESP-IDF CSI C API directly (`esp_wifi_set_csi_config`,
`esp_wifi_set_csi_rx_cb`, `esp_wifi_set_csi`).

CSI only exists when a packet is *received*, so the firmware **pings the gateway** at the
configured interval. Each echo reply is a received packet, and each received packet carries
a channel measurement — that is what makes the rate steady and repeatable instead of
depending on whatever traffic happens to be in the air.

Frames are filtered to the access point's BSSID. CSI from any other transmitter describes
a completely different path through the room, so mixing it in would make the baseline
meaningless.

The Wi-Fi callback does four things and nothing else: validate the frame, check the MAC,
`memcpy` into a bounded queue, return. A separate loop formats and prints. Anything slower
than a `memcpy` inside that callback would stall the Wi-Fi stack.

### CSI configuration used

| Field | Value | Why |
| --- | --- | --- |
| `lltf_en` | true | The legacy training field is in every packet type |
| `htltf_en` | true | The 802.11n training field |
| `stbc_htltf2_en` | false | Not needed; only makes frames longer |
| `ltf_merge_en` | true | Average LLTF and HT-LTF for HT packets |
| `channel_filter_en` | **false** | Smoothing would destroy the per-sub-carrier independence that makes CSI useful |
| `manu_scale` | false | Automatic gain (see normalisation above) |

Bandwidth is forced to **HT20** so every frame has the same shape.

### Frame format on the wire

```text
CSI,seq,rssi,noise,channel,sig_mode,timestamp_us,first_word_invalid,len,v0,v1,...
STAT,uptime_ms,rate,emitted,drop_queue,drop_mac,drop_size,truncated,drop_usb_busy,rssi,free_heap
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

* **Sub-carrier order.** The hardware stores indices `0..31` then `-32..-1`. The graph
  reorders them so `-32` is on the left and `+31` on the right.
* **Analysed set.** Only sub-carriers `±1..±26` are used. Index 0 is the DC null and
  `|k| > 26` are guard bands — they carry nothing. The first two array positions are always
  dropped as well, because the hardware can flag the first four bytes invalid, and letting
  that flag toggle in and out of the average would look like channel activity.

---

## Physical test plan

**Run this the first time the ESP32 is available.** Until it passes, nothing in this
repository is evidence about physical sensing.

### A. Prove CSI exists at all

1. Flash, open the dashboard, press **Connect ESP32**.
2. Watch Diagnostics. `Lines received` must grow. If it grows but `CSI frames processed`
   stays 0, the firmware is not producing CSI — check it joined Wi-Fi and look for
   `csi_enable FAILED` in the INFO lines.
3. Confirm `CSI length` is 256 bytes and `Packet type` is HT (11n) or non-HT.
4. Confirm **CSI frames/s** is steady near 20 and the quality badge reads **GOOD**.
5. Note `ESP wrong-MAC drops` — a non-zero, slowly growing number is correct and means the
   BSSID filter is doing its job.

**Stop here and report if any of this fails.** Everything below assumes real CSI is arriving.

### B. Record the reference experiments

Put the AP and the ESP32 **2–3 m apart** and leave both untouched for the whole session.
Record each of these as its own labelled dataset, 60–120 seconds each:

| Label | What to do |
| --- | --- |
| `still` | empty room, nothing moves |
| `stand_off_axis` | stand still, well off the AP↔ESP32 line |
| `walk_direct` | walk repeatedly straight through the line |
| `walk_near` | walk parallel, ~1 m to the side |
| `walk_off_axis` | walk across the far corner of the room |
| `stand_in_path` | stand still *between* AP and ESP32 |
| `move_ap` | move the AP itself (expect the largest change of all) |

For each: capture a baseline during the first still seconds, then press **Start recording**
before the activity begins. Write down the quality badge and the Diagnostics counters.

### C. Check the numbers, then check them again offline

8. Compare **CSI activity** across the datasets. The ordering you expect is
   `still < stand_off_axis < walk_off_axis < walk_near < walk_direct < move_ap`.
   **If it does not come out that way, that is a real result and must be reported as one** —
   do not tune the metric until it produces the expected ordering.
9. Reload every dataset in **REPLAY** and confirm the numbers reproduce. They should be
   identical; if they are not, the record/replay path has a bug and the hardware results are
   not yet trustworthy.
10. Switch to **RAW** magnitude and look at the same datasets again. If raw and normalised
    disagree sharply, suspect AGC and check **Potential clipping**.
11. Only after all of the above: try `CSI_PING_INTERVAL_MS=20` (50 Hz) and check whether the
    rate is actually 50 and the quality badge is still GOOD.

### D. What to write down

For each dataset: label, quality badge, CSI activity range, frames/s, sequence gaps,
malformed frames, ESP queue drops, USB truncated/busy, potential clipping, RSSI and noise
floor. The datasets themselves are the record; these are the summary.

---

## Troubleshooting

Open **Diagnostics** at the bottom of the dashboard.

| What you see | What it means |
| --- | --- |
| `CSI frames processed` stays 0 while `Lines received` grows | Serial works, but the firmware is not producing CSI — check it joined Wi-Fi |
| `Malformed frames` climbing | Usually the UART port instead of the native USB port |
| `Malformed reasons` shows `value_count_mismatch` | Lines are being truncated in transit |
| `Sequence gaps` climbing | Frames lost between firmware and browser |
| `ESP queue drops` > 0 | The firmware queue overflowed: USB back-pressure |
| `ESP wrong-MAC drops` > 0 | CSI from other transmitters, correctly filtered out |
| `USB truncated / busy` second number climbing | The host is not draining the port fast enough |
| `Firmware restarts seen` > 0 | The board rebooted; the baseline was invalidated |
| Frame rate far below the target | The AP is not answering pings at the requested rate |
| Replay stalls when the tab is hidden | Expected: browsers throttle `requestAnimationFrame` in background tabs |

---

## Tests

```sh
npm test                 # 96 host tests, no hardware needed
~/.platformio/penv/bin/pio run    # firmware build
```

| File | Covers |
| --- | --- |
| `tests/parser.test.mjs` | fragmented reads, truncation, bad fields, oversize, garbage, recovery |
| `tests/pipeline.test.mjs` | magnitudes, normalisation, baseline, activity, clipping, quality, invalidation |
| `tests/dataset.test.mjs` | serialisation, schema version, corrupt lines, 2-minute recording, memory bounds |
| `tests/equivalence.test.mjs` | **live vs replay produce identical numbers** |
| `tests/replay.test.mjs` | play, pause, restart, step, speed, recorded timing |
| `tests/serial-link.test.mjs` | Web Serial lifecycle, DTR, bounded cleanup |
| `tests/fixtures.mjs` | deterministic synthetic scenarios |

**The synthetic fixtures prove software behaviour only.** Their numerical response says
nothing about how well CSI senses a real person in a real room, and no sensing-performance
claim may be based on them.

---

## Future work (deliberately not built)

* **Multiple sensing nodes.** The data model is prepared (`node_id`, `link_id`, `source`);
  the networking, time-division and synchronisation are not.
* **Radar fusion** (TI mmWave, Acconeer) into a common sensing layer.
* **Standalone AP mode** — the ESP32 creates its own Wi-Fi, a phone connects, the dashboard
  is served from the board. Attractive for demos, but it changes the radio architecture:
  the link under measurement becomes the link carrying the data. For research, a controlled
  external AP plus a wired host is the cleaner experiment.
* **CSI v0.2 motion detection.** Not until real CSI has been recorded, replayed and
  understood.
