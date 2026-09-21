# Evidence register

One table, one job: stop a capability from becoming real because it appears in code, in
a dashboard label, in a roadmap, or in a demo. **Claims follow evidence.**

Last reviewed: 2026-09-21 · against `mino-csi` `cda7b15`.

## Status vocabulary

These are **repository engineering statuses**. They are not RYS evidence levels and must
never be mixed with them.

| Status | Means |
| --- | --- |
| SOFTWARE-VERIFIED | build, automated tests, replay or synthetic input verify software behaviour. No physical RF acquisition. |
| HARDWARE-OBSERVED | the behaviour was seen on real physical hardware. Not the same as scientifically demonstrated. |
| EXPERIMENTALLY-DEMONSTRATED | a defined experiment exists with method, retained dataset, configuration, result, limitations and reproducible evidence. |
| PLANNED | intended future engineering or research work. |
| NOT YET TESTED | no relevant evidence exists. |
| BLOCKED | cannot proceed because of a documented blocker. |
| SUPERSEDED | replaced by a later record; kept for history. |

## RYS evidence levels

The separate RYS scale (`RYS_04_VALIDATION_FRAMEWORK_v0.2`, §2) is L0 Assumption ·
L1 Literature · LP Historical predecessor evidence · L2 Observed · L3 Demonstrated ·
L4 Validated · L5 Product ready.

**Nothing in this repository is at RYS L2 or above.** Doc 04 records that as of
14 Sep 2026 every RYS capability sits at L0 or L1, and none of this work has been run as
an RYS-designated experiment under that framework. A passing test suite, a working
dashboard or a convincing demo does not move an RYS level. See
[RYS_CONTEXT.md](RYS_CONTEXT.md).

## Register

| Claim / question | Engineering status | RYS level | Evidence location | Current conclusion | Main limitation | Next evidence needed |
| --- | --- | --- | --- | --- | --- | --- |
| The ESP32-S3 can stream RSSI to a browser at ~20 Hz | HARDWARE-OBSERVED | n/a — not an RYS experiment | branch `mino` `242110e`; [progress/2026-09-20-rssi-v0.2.md](progress/2026-09-20-rssi-v0.2.md) | Works end to end on hardware | One link, one room, no retained dataset | — |
| A quiet RSSI link has a measurable noise floor that a threshold can be derived from | HARDWARE-OBSERVED | n/a | `mino` `10425bf` README ("measured on a real quiet link", fast score ≈ 0.01–0.02) | Adaptive thresholding is grounded in a real measurement | Single measurement, no dataset retained, exact conditions not recorded | Re-measure with a retained dataset if RSSI work resumes |
| RSSI responds to a person moving through the link | NOT YET TESTED | n/a | the 0.5/1/2/3 m experiment in `mino` README was never run | Unknown magnitude and repeatability | No experiment record exists | The RSSI geometry experiment set, or supersede it with CSI work |
| CSI software acquisition pipeline (parse → magnitude → normalise → baseline → activity) | SOFTWARE-VERIFIED | L0 | `dashboard/csi-core.js`; `tests/parser.test.mjs`, `tests/pipeline.test.mjs` | The software does what it says on synthetic input | Synthetic input only | Real frames (CSI-EXP-001) |
| Record → replay is numerically exact | SOFTWARE-VERIFIED | L0 | `tests/equivalence.test.mjs` — 10 scenarios agree to 1e-12 | Live and replay share one path and one result | Proven on fixtures, not on a recorded real session | Replay a real recorded dataset and compare |
| JSONL recording is lossless, bounded and survives corrupt lines | SOFTWARE-VERIFIED | L0 | `tests/dataset.test.mjs`; [DATASET-FORMAT.md](DATASET-FORMAT.md) | Schema v1 round-trips; memory sink caps at 24 MB | Never written from a real session | One real recording |
| Transport data-quality verdict reflects link health | SOFTWARE-VERIFIED | L0 | `tests/pipeline.test.mjs`; README §6 | Detects gaps, malformed lines, drops, rate error, jitter | Thresholds were chosen by reasoning, not from a measured baseline | A real GOOD baseline to check the thresholds against |
| **Real CSI acquisition from a physical ESP32-S3** | **NOT YET TESTED** | L0 | none | Unknown. The firmware compiles and the API is present in the SDK; no frame has been seen | The entire branch rests on this | CSI-EXP-001 |
| CSI frame rate of 20 Hz is achievable | NOT YET TESTED | L0 | transport arithmetic in [CSI-NOTES.md](CSI-NOTES.md) | The USB link has ample headroom; whether the AP answers 20 pings/s is unknown | Network and AP property, not a code property | CSI-EXP-001 |
| CSI frame rate of 50 Hz is achievable | NOT YET TESTED | L0 | `CSI_PING_INTERVAL_MS=20` compiles | Prepared only | Untested at every layer | After 20 Hz is confirmed |
| CSI activity metric responds to a channel change | SOFTWARE-VERIFIED | L0 | `tests/fixtures.mjs` synthetic scenarios | The arithmetic behaves as defined | A synthetic perturbation is not an RF event | Real still-vs-disturbed datasets |
| CSI activity distinguishes a moving person from a still room | NOT YET TESTED | L0 | none | Not demonstrated. The metric is a mean absolute difference from a baseline, nothing more | Cause of a change is not identified: a person, a door, a moved phone and AP behaviour all raise it | CSI-EXP-002 … 008 with ground truth |
| Human presence (static person) detection | NOT YET TESTED | L0 | none | Not demonstrated; harder than motion | No micro-motion processing exists | A dedicated experiment after motion is understood |
| Zone / spatial inference | NOT YET TESTED | L0 | none | Research direction only | One link carries no spatial separation | Multi-link experiments, only after single-link is understood |
| Localisation / range from CSI | NOT YET TESTED | L0 | none | Not demonstrated and not plausible on this configuration | HT20 = 20 MHz bandwidth → range resolution ΔR = c/2B ≈ **7.5 m** (`RYS_02_TECHNOLOGY_MAP_v0.2` §2) | Would need far more bandwidth or a different method; do not claim |
| Through-wall / through-barrier sensing | NOT YET TESTED | L0 | none | No claim. Not attempted | Not a designed capability of this setup | A designed barrier experiment, which is not on this roadmap |
| Multi-link sensing (two RF paths) | NOT YET TESTED | L0 | none | Not built | Single link only | A controlled second link first |
| Multi-node acquisition | NOT YET TESTED | L0 | `node_id` / `link_id` exist in the schema | **Data-model preparation only.** No networking, time-division, synchronisation or fusion exists | Fields in a schema are not a capability | A second node, and an experiment that needs one |
| Standalone / SoftAP CSI node | NOT YET TESTED | L0 | none | Documented as a future concept; deliberately not built | Would change the radio architecture: the measured link becomes the data link | A decision that demo portability outweighs research control |
| 5 GHz Wi-Fi CSI | NOT YET TESTED | L0 | none | **The current ESP32-S3 provides 2.4 GHz only** | Requires different hardware | Hardware selection, then a comparative experiment |
| RYS integration (SensorAdapter, normalised observation) | NOT YET TESTED | L0 | none | Future possibility only. `RYS_01_CURRENT_PLAN_v2.1` defines M0.1 on the IWR6843 / XM125 path; Wi-Fi CSI is not in the RYS sensor bring-up list | The JSONL format here is a **local experimental schema**, not the RYS container | An explicit RYS decision, not a repository decision |

## Rules for changing this table

1. A row moves up only on evidence of the matching kind. Software evidence cannot produce
   HARDWARE-OBSERVED; hardware observation cannot produce EXPERIMENTALLY-DEMONSTRATED
   without a retained dataset and stated limitations.
2. An RYS level changes only through the RYS validation process, never here.
3. When a row changes, link the experiment record that changed it.
4. A row that weakens is still an update. Record it; do not quietly delete it.
