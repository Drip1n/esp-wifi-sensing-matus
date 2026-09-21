# Decisions

Lightweight ADRs. One entry per decision that would be expensive or confusing to
re-litigate later.

Statuses: **ACTIVE** · **SUPERSEDED** · **REVISIT REQUIRED**.

When a decision changes: keep the old entry, mark it SUPERSEDED with a pointer, and write
a new one. Never rewrite history so that the previous decision appears never to have
existed.

Every entry below was reconstructed from repository evidence — code, comments, commits
and existing docs at `cda7b15`. Where the original motivation is not recoverable from
that evidence, the entry says so rather than inventing a rationale.

---

## DEC-001 — PlatformIO + Arduino rather than native ESP-IDF

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1 (`4485ecb`)
**Status:** ACTIVE

**Context.** CSI requires the ESP-IDF C API (`esp_wifi_set_csi_config`,
`esp_wifi_set_csi_rx_cb`, `esp_wifi_set_csi`). The question was only which build system
delivers it. The preceding RSSI work already used PlatformIO + Arduino.

**Decision.** Keep PlatformIO + Arduino and call the official ESP-IDF CSI API directly.

**Alternatives.** A native ESP-IDF project.

**Why.** Verified on this machine and recorded in [CSI-NOTES.md](CSI-NOTES.md): the
installed Arduino core's S3 sdkconfig has `CONFIG_ESP32_WIFI_CSI_ENABLED=y`, `nm` shows
the CSI symbols compiled into `libnet80211.a`, and `ping_sock.h` is present so controlled
traffic needs no extra library. A native ESP-IDF project would have meant installing a
toolchain, CMake and Ninja (none present) for no gain at this milestone. Arduino is only
the build system and the USB serial driver.

**Consequences.** Pinned to ESP-IDF 4.4.7 via Arduino core 2.0.17, which is the "legacy"
CSI config field set. Espressif's `esp-radar` library and the newer `csi_recv_router`
example are ESP-IDF projects and are not directly usable.

**Revisit when.** We want `esp-radar` or a newer Espressif CSI example verbatim, or the
4.4 CSI API becomes a limitation.

**Evidence.** [CSI-NOTES.md](CSI-NOTES.md) §"Why PlatformIO + Arduino", §"ESP-IDF version".

---

## DEC-002 — Native USB CDC rather than UART

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1
**Status:** ACTIVE

**Context.** The RSSI project ran over 115200 baud. A typical HT20 CSI line is 893 bytes;
at 20 Hz that is 17.9 kB/s, and a 115200 baud UART carries 11.5 kB/s.

**Decision.** Build with `ARDUINO_USB_CDC_ON_BOOT=1` and `ARDUINO_USB_MODE=1` and use the
board's native USB port.

**Alternatives.** A UART bridge at a higher baud rate; reducing the frame rate; sending
binary instead of text.

**Why.** UART cannot carry the data rate at 20 Hz — the RSSI project's assumption could
not simply be carried over. USB CDC ignores the baud setting and runs at USB speed, with
ample headroom even at 50 Hz.

**Consequences.** The user must plug into the correct socket on a two-socket board, which
is now a documented troubleshooting step. Web Serial needs DTR asserted explicitly after
`port.open()`, because the ESP32-S3 USB-CDC stack gates transmission on it. The TX ring
must be sized above one whole line (`Serial.setTxBufferSize(4096)` **before**
`Serial.begin()`), because `HWCDC::begin()` only allocates when the ring is null.

**Revisit when.** A binary protocol or a higher rate changes the arithmetic.

**Evidence.** [CSI-NOTES.md](CSI-NOTES.md) §"Transport arithmetic"; `src/main.cpp`
`setup()`; `platformio.ini`; `tests/serial-link.test.mjs`.

---

## DEC-003 — JSONL rather than CSV for datasets

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1.1 (`cda7b15`)
**Status:** ACTIVE

**Context.** Recording needed a format that streams, survives truncation, holds several
record types (session header, CSI frames, firmware stats, events) and explains itself to
someone opening it weeks later.

**Decision.** JSON Lines, schema version 1, one JSON object per line.

**Alternatives.** CSV; a binary container; MCAP.

**Why.** CSV needs separate files or ragged rows for mixed record types and 256 unnamed
columns for one CSI frame, and means nothing without its header row. JSONL costs about
25 % more bytes, which is not the constraint here.

**Consequences.** ~953–1458 bytes per frame; 2.2–3.3 MB for a 2-minute recording. A
schema version field, rejected by name if it is not 1, with no migration framework —
deliberately. This is a **local experimental format**, not an RYS container; RYS's own
position (Doc 03 §12) is to use MCAP or plain files plus JSON sidecars rather than invent
one.

**Revisit when.** Datasets need to be exchanged with another system, or the size becomes
a real constraint.

**Evidence.** [DATASET-FORMAT.md](DATASET-FORMAT.md); `dashboard/csi-core.js`
serialisation section; `tests/dataset.test.mjs`.

---

## DEC-004 — HT20 bandwidth, forced before association

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1
**Status:** ACTIVE

**Context.** HT40 changes the sub-carrier layout per packet.

**Decision.** `esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20)`, called **before**
`WiFi.begin()` so the association is negotiated with it in force.

**Alternatives.** Leave the bandwidth to negotiation; use HT40 for more sub-carriers.

**Why.** Every CSI frame then has the same shape, which is a needless variable removed
for v0.1.

**Consequences.** 256 bytes per frame: an LLTF block of 64 sub-carriers then an HT-LTF
block of 64. It also fixes the usable bandwidth at 20 MHz, so range resolution
ΔR = c/2B ≈ 7.5 m — which is the physical reason this configuration cannot do ranging
or localisation.

**Revisit when.** A research question genuinely needs the wider channel, and the cost of
a variable frame shape has been accepted.

**Evidence.** `src/main.cpp` `setup()`; [README](../README.md) §"CSI configuration used".

---

## DEC-005 — Filter CSI to the access point's BSSID

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1, hardened in v0.1.1
**Status:** ACTIVE

**Context.** The CSI callback receives frames from any transmitter the radio hears.

**Decision.** Accept only frames whose source MAC matches the associated AP's BSSID;
count the rest as `drop_mac`. Re-read the association every 2 s and flush the queue when
the link identity changes.

**Alternatives.** Accept everything and filter on the host; no filtering.

**Why.** CSI from another transmitter describes a completely different path through the
room, so mixing it in makes the baseline meaningless. The 2-second re-read exists because
a STA can roam to a different BSSID, or follow the AP to a different channel, **without
ever emitting a disconnect event** — after which the filter would reject every frame and
the only symptom would be `drop_mac` climbing.

**Consequences.** A non-zero, slowly growing `drop_mac` is correct behaviour and is
documented as such. A link change announces `INFO,link,<bssid>,<channel>` so the host can
invalidate its baseline.

**Revisit when.** Multi-link or multi-node work needs frames from more than one
transmitter — at which point they need separate `link_id`s, not a removed filter.

**Evidence.** `src/main.cpp` `onCsiFrame()`, `refreshLink()`;
[CSI-NOTES.md](CSI-NOTES.md) §"Firmware hardening (v0.1.1)".

---

## DEC-006 — Build record/replay before any detection algorithm

**Date:** 2026-09-21 (recorded); decision made in `cda7b15`
**Status:** ACTIVE

**Context.** Hardware was not available, and the alternative use of that time would have
been to tune a detector against invented data.

**Decision.** Build recording and exact replay first, and make live and replay share one
processing implementation. Do not build CSI v0.2 detection until real CSI has been
recorded and replayed.

**Alternatives.** Build the motion detector now and add recording later.

**Why.** Without recording, every algorithm comparison is against a different walk
through the room, so a change in the output could be the algorithm or could be the walk.
With recording, the same RF event goes through version A and version B. It also means a
hardware session — which is expensive — is spent once, carefully, and the ten algorithm
iterations afterwards cost seconds each.

**Consequences.** The invariant that makes it work: every time-dependent decision inside
`CsiPipeline` uses the frame's own `tHostMs`, never the wall clock, with `tickWatchdog()`
the one documented exception. Breaking that silently breaks equivalence.
`tests/equivalence.test.mjs` guards it across ten scenarios to 1e-12. Independently, this
matches the RYS build order (Doc 03 §3), which places the recorder second for the same
reason.

**Revisit when.** Never, unless the equivalence invariant becomes impossible to hold — in
which case that is a new decision, not a quiet change.

**Evidence.** `tests/equivalence.test.mjs`; [CSI-NOTES.md](CSI-NOTES.md) §"Host
architecture"; [README](../README.md) §"Why record and replay matters".

---

## DEC-007 — Do not display CSI phase

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1
**Status:** ACTIVE

**Context.** CSI is complex-valued, so phase is available at no cost.

**Decision.** Display and analyse magnitude only. Store raw I/Q so phase remains
recoverable.

**Alternatives.** Plot raw phase; implement offset correction now.

**Why.** Raw ESP32 CSI phase contains uncorrected hardware timing offsets. Plotting it as
"physical phase" would be misleading without a correction step that does not exist here.

**Consequences.** Some sensing literature that relies on phase is not directly
reproducible here yet. Because the dataset stores raw int8 I/Q verbatim, a future phase
method can be applied to old captures without recollecting them.

**Revisit when.** A phase-offset correction is implemented and validated against real
frames.

**Evidence.** [README](../README.md) §"What this does NOT do"; `dashboard/csi-core.js`
`magnitudeFromPair`.

---

## DEC-008 — Normalise each frame; keep raw available

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1.1
**Status:** ACTIVE

**Context.** `manu_scale` is false, so automatic gain control scales whole frames. An AGC
step is the receiver reacting, not the room changing.

**Decision.** Default to per-frame normalisation (divide by the frame's own mean over the
analysed sub-carriers); keep a raw view; always compute the activity metric in the
normalised domain regardless of which view is displayed.

**Alternatives.** Manual gain with a fixed shift; raw only; normalised only.

**Why.** Normalisation cancels anything that scales the whole frame equally and leaves
the shape across sub-carriers, which is the part multipath changes. Keeping raw available
preserves the "did the amount of power change" question. Computing activity always in one
domain keeps the number comparable between datasets.

**Consequences.** Absolute amplitude is not comparable between frames. The
`common_gain_scaling` fixture makes the difference concrete: a drifting scale factor
produces normalised activity below 0.02 and a raw difference above 3.

**Revisit when.** Absolute scale is genuinely needed — then switch to manual scaling with
a fixed shift and re-check clipping.

**Evidence.** [README](../README.md) §"Raw vs normalised magnitude"; `tests/fixtures.mjs`;
`src/main.cpp` `enableCsi()`.

---

## DEC-009 — No machine learning yet

**Date:** 2026-09-21 (recorded)
**Status:** ACTIVE

**Context.** Wi-Fi sensing literature is full of learned classifiers.

**Decision.** No ML until a real, labelled dataset from this hardware exists, and a
transparent baseline has been characterised on it.

**Alternatives.** Train something on synthetic data or on a public CSI dataset.

**Why.** There is no dataset. A transparent baseline that can be explained to a reviewer
is worth more than a model that cannot, and it is what makes a first result defensible.
A model trained on synthetic fixtures would learn the fixture generator.

**Consequences.** The activity metric stays a mean absolute difference with no threshold
and no adaptation, and is labelled experimental.

**Revisit when.** Real labelled datasets exist and a simple baseline has been shown to be
insufficient — not before.

**Evidence.** [EVIDENCE_REGISTER.md](EVIDENCE_REGISTER.md); `dashboard/csi-core.js`
`updateActivity()`.

---

## DEC-010 — Multi-node deferred; schema fields kept

**Date:** 2026-09-21 (recorded); decision made during CSI v0.1.1
**Status:** ACTIVE

**Context.** A second sensing node is an obvious future direction, and retrofitting
identity into a dataset format after captures exist is expensive.

**Decision.** Include `source`, `node_id` and `link_id` in the data model and the
firmware banner now. Build **no** multi-node functionality: no networking, no
time-division, no synchronisation, no fusion.

**Alternatives.** Add the fields later; build multi-node now.

**Why.** The fields cost almost nothing and mean a second node's data is a *superset* of
this format rather than a different one. The functionality costs a great deal and no
evidence yet requires it.

**Consequences.** The fields must never be cited as evidence of multi-node capability.
[EVIDENCE_REGISTER.md](EVIDENCE_REGISTER.md) states this explicitly for that reason.

**Revisit when.** A single link has been characterised and its limitation demonstrated —
not assumed.

**Evidence.** `src/main.cpp` `CSI_NODE_ID`; [DATASET-FORMAT.md](DATASET-FORMAT.md);
[README](../README.md) §"Node ID and link ID".

---

## DEC-011 — Current ESP32-S3 work is 2.4 GHz only

**Date:** 2026-09-21 (recorded)
**Status:** ACTIVE

**Context.** The Fontys research question is about comparing frequency bands, which makes
a 2.4 vs 5 GHz Wi-Fi CSI comparison an attractive idea.

**Decision.** Treat all current work as 2.4 GHz. Do not describe the current setup as
providing 5 GHz Wi-Fi CSI. Do not schedule 5 GHz work.

**Alternatives.** None — this is a hardware fact, recorded so it is not accidentally
forgotten in a later summary.

**Why.** The ESP32-S3 has a 2.4 GHz radio. A 5 GHz comparison needs different hardware.

**Consequences.** This repository can contribute a *within-band* result to the Fontys
frequency question, and the physics behind the trade-offs, but not a cross-band
measurement. Stated in [FONTYS_RESEARCH_CONTEXT.md](FONTYS_RESEARCH_CONTEXT.md) and
[ROADMAP.md](ROADMAP.md).

**Revisit when.** Hardware capable of 5 GHz CSI is available and a research question
justifies it.

**Evidence.** ESP32-S3 datasheet; `platformio.ini` board `esp32-s3-devkitm-1`;
[README](../README.md) hardware section.

---

## DEC-012 — Controlled AP + host laptop is the research configuration

**Date:** 2026-09-21 (recorded)
**Status:** REVISIT REQUIRED

**Context.** A standalone ESP (its own network, phone connects, dashboard served from the
board) would be much better for demos. Separately, the AP currently used for the RSSI
work was an iPhone hotspot.

**Decision.** Keep an external AP plus a wired host as the research configuration.
Document standalone mode as a future concept; do not implement it.

**Alternatives.** SoftAP / standalone mode now.

**Why.** In standalone mode the link under measurement becomes the link carrying the
data, which changes the radio architecture — exactly the variable an experiment is trying
to hold still.

**Consequences.** Every demo needs a laptop. Accepted for research.

**Why this is REVISIT REQUIRED.** The AP *type* is unresolved. A phone hotspot worked for
RSSI, but it may rate-limit or coalesce ICMP replies, and it may change channel — either
of which would destroy the steady frame rate CSI depends on. The documented fallback is
an ordinary fixed 2.4 GHz router, which removes the phone's power management from the
experiment entirely. This is blocker B2 in [PROJECT_STATUS.md](PROJECT_STATUS.md) and
must be settled by CSI-EXP-001.

**Evidence.** [CSI-NOTES.md](CSI-NOTES.md) §"Known open questions";
[README](../README.md) §"Future work".
