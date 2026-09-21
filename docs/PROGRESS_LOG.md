# Progress log

Compact chronological index of meaningful technical and research progress. Newest first.

Not a commit log. Formatting changes, typo fixes and trivial refactors do not belong
here. Detail lives in [progress/](progress/) and [experiments/](experiments/); this page
is the index.

---

## 2026-09-21 — CSI v0.1.1: hardening + record/replay

**Commit:** `cda7b15` · **Branch:** `mino-csi` · **Status:** SOFTWARE-VERIFIED

**What changed.** Firmware hardening found by reading the code and the Arduino core
(USB TX ring sizing, no partial lines under back-pressure, roam/channel-follow detection,
null-queue guards, oversize handling, explicit buffer accounting, ping lifecycle, stats
window reset, bandwidth ordering). Host side: JSONL recording with a session header,
replay with recorded timing, transport data-quality verdict, clipping indicator, baseline
invalidation triggers, and 96 tests.

**Evidence produced.** `npm test` 96/96; `pio run` SUCCESS. No RF data.

**Key learning.** Live/replay equivalence is achievable exactly, but only if every
time-dependent decision uses the frame's own timestamp rather than the wall clock — that
invariant is the whole feature and is now test-guarded.

**Main limitation.** No CSI frame from a real radio has ever been observed. Every number
comes from synthetic fixtures.

**Decisions.** [DEC-003](DECISIONS.md#dec-003--jsonl-rather-than-csv-for-datasets),
[DEC-006](DECISIONS.md#dec-006--build-recordreplay-before-any-detection-algorithm),
[DEC-008](DECISIONS.md#dec-008--normalise-each-frame-keep-raw-available),
[DEC-010](DECISIONS.md#dec-010--multi-node-deferred-schema-fields-kept).

**Next action.** CSI-EXP-001 — prove real CSI frames arrive at all.

**Fontys relevance.** Iteration 1 → 2. A candidate practical direction now has a working
acquisition and record/replay path, which changes what is *feasible* to propose at D2 —
and changes nothing about what has been *measured*.

**RYS relevance.** Architecturally aligned with M0.1 principles (recorder-first, raw
immutable, documented format, replay, health visible). Does not complete RYS M0.1 and
produces no RYS evidence level.

**Detail:** [progress/2026-09-21-csi-v0.1.1-hardening-record-replay.md](progress/2026-09-21-csi-v0.1.1-hardening-record-replay.md)

---

## 2026-09-21 — CSI v0.1: ESP32-S3 CSI acquisition and visualisation

**Commit:** `4485ecb` · **Branch:** `mino-csi` · **Status:** SOFTWARE-VERIFIED

**What changed.** First CSI firmware: ESP-IDF CSI API via PlatformIO/Arduino, HT20,
gateway ping for controlled traffic at a configured 20 Hz, BSSID filtering, a lightweight
callback feeding a bounded queue, and a CSV line protocol over native USB CDC. Host: a
DOM-free processing core, per-sub-carrier magnitudes, normalisation, baseline capture and
a difference view.

**Evidence produced.** Firmware builds; host logic tested against synthetic frames.

**Key learning.** CSI requires *received* packets, so the sample rate has to be created
deliberately — pinging the gateway turns an uncontrolled property of the environment into
a configured parameter. Separately, the RSSI project's 115200 baud assumption does not
survive the data rate.

**Main limitation.** Not verified on hardware.

**Decisions.** [DEC-001](DECISIONS.md#dec-001--platformio--arduino-rather-than-native-esp-idf),
[DEC-002](DECISIONS.md#dec-002--native-usb-cdc-rather-than-uart),
[DEC-004](DECISIONS.md#dec-004--ht20-bandwidth-forced-before-association),
[DEC-005](DECISIONS.md#dec-005--filter-csi-to-the-access-points-bssid),
[DEC-007](DECISIONS.md#dec-007--do-not-display-csi-phase).

**Next action.** Record/replay before any detection work.

**Fontys relevance.** Moves an approach from "read about it" to "have it running",
which is the difference between a theoretical candidate and a testable one.

**RYS relevance.** Establishes acquisition separated from processing, and health
counters as first-class output.

**Detail:** [progress/2026-09-21-csi-v0.1-software.md](progress/2026-09-21-csi-v0.1-software.md)

---

## 2026-09-20 — RSSI v0.2: adaptive noise-aware detection

**Commit:** `10425bf` · **Branch:** `mino` (and `mino-codex`) · **Status:** HARDWARE-OBSERVED

**What changed.** Replaced a fixed motion threshold with one derived from the link's own
measured noise floor during calibration, and added a slow "SIGNAL SHIFT" metric that
reports a drift in average RSSI without claiming a person caused it.

**Evidence produced.** Measured on a real quiet link: a fast score (mean absolute
adjacent-sample RSSI delta over 20 samples) of about 0.01–0.02. RSSI is quantised to
whole dBm, so a single 1 dB step over the 20-sample window contributes 1/19 = 0.053 —
the unit in which all thresholds are reasoned. No dataset was retained.

**Key learning.** A threshold has to come from the measured noise floor, not from a
guess: the same slider positions produce thresholds around 0.15–0.52 on a quiet link and
3.8–4.9 in a noisy one.

**Main limitation.** RSSI cannot give distance, position or direction, and the planned
0.5/1/2/3 m geometry experiment was never run. No raw data was kept, so the measurement
cannot be re-analysed — which is precisely the gap that motivated record/replay on the
CSI branch.

**Next action.** Superseded in priority by the CSI track.

**Fontys relevance.** A concrete illustration that a single-scalar RF measurement has an
information ceiling, with the numbers to show where it sits.

**RYS relevance.** Predecessor-style work: real, but produced outside any validation
framework and with no retained dataset. It closes no gate.

**Detail:** [progress/2026-09-20-rssi-v0.2.md](progress/2026-09-20-rssi-v0.2.md)

---

## 2026-09-20 — RSSI v0.1: working end-to-end link

**Commits:** `45d1724` → `a1673f0` → `242110e` · **Branch:** `mino` · **Status:** HARDWARE-OBSERVED

**What changed.** ESP32-S3 → USB CDC → Chrome Web Serial → browser dashboard, ~20 Hz,
working end to end on hardware for the first time.

**Key learning.** Two Web Serial failures that are easy to confuse and have different
causes: a port that opens but streams nothing is the ESP32-S3 USB-CDC stack waiting for
the host to assert DTR; a UI that wedges and cannot reconnect is unbounded `cancel()` /
`close()` awaits that never settle when the device is physically gone. Fixing one does
not fix the other.

**Main limitation.** A plausible mechanism is not a confirmed diagnosis — `a1673f0`
claimed DTR was the root cause and the physical retest still failed. Confirmed only by
the user's physical retest after `242110e`.

**Fontys relevance.** The measurement chain itself — radio, transport, host, display — is
where most of the failure modes live, and they are not RF failures.

**RYS relevance.** A direct demonstration of "health is part of the output": the fix was
to make cleanup bounded and report `Cleanup completed: YES/NO` rather than hang silently.

**Detail:** no dedicated record — the material above is recoverable from the `mino`
README and git history, and is summarised in
[progress/2026-09-20-rssi-v0.2.md](progress/2026-09-20-rssi-v0.2.md).
