# AGENTS.md — read this first

Operating rules for any coding agent working in this repository. Read this before
editing anything. It is deliberately short; the canonical documents it links to hold
the detail.

## 1. Project identity

A **Wi-Fi RSSI / CSI sensing research and engineering proof-of-technology environment**
running on an ESP32-S3 with a browser-based host pipeline.

It is **not** the Fontys Personal Project, and it is **not** the RYS platform. It is one
experimental RF track that can supply evidence to both. See
[docs/FONTYS_RESEARCH_CONTEXT.md](docs/FONTYS_RESEARCH_CONTEXT.md) and
[docs/RYS_CONTEXT.md](docs/RYS_CONTEXT.md).

## 2. Current verified state

| Thing | Status |
| --- | --- |
| RSSI v0.2 (branch `mino`) | HARDWARE-OBSERVED |
| CSI v0.1 software pipeline | SOFTWARE-VERIFIED |
| CSI v0.1.1 hardening + record/replay | SOFTWARE-VERIFIED |
| **Real CSI from a physical ESP32-S3** | **NOT YET HARDWARE-OBSERVED** |
| Any sensing claim (motion, presence, position) | NOT DEMONSTRATED |

Full detail: [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) ·
[docs/EVIDENCE_REGISTER.md](docs/EVIDENCE_REGISTER.md)

Do not upgrade any of these without new evidence of the right kind. A passing test is
not a radio measurement.

## 3. Branch rules

* Work on **`mino-csi`** unless told otherwise.
* `mino` and `mino-codex` hold the RSSI v0.2 milestone (`10425bf`). Do not touch them.
* Do not merge branches. Do not touch `main` or `matus`.
* `RYS-Systems/rys-alpha` and `RYS-Systems/Landing_Page` are read-only references.
  Never commit to them.
* Never edit the canonical Google Drive documents. Use the
  *External documentation follow-up* block instead (§11).

## 4. Source-of-truth hierarchy

| Question | Authority |
| --- | --- |
| What the code actually does | this repository, current branch |
| Repository history | git |
| Academic scope, research question, planning | Fontys Drive / Portflow |
| RYS capability, validation, evidence levels | RYS Drive canonical set (Docs 00–06) |
| RYS implementation conventions | `RYS-Systems/rys-alpha` |

If a repository document disagrees with a canonical external document about scope or
terminology: use the canonical source, record the mismatch, and raise an external
follow-up. Do not invent a resolution.

## 5. Canonical documents in this repository

| File | Owns |
| --- | --- |
| `README.md` | how to install, run and use the software |
| `docs/CSI-NOTES.md` | CSI implementation and engineering detail |
| `docs/DATASET-FORMAT.md` | the dataset schema |
| `docs/WIFI_CSI_PROJECT.md` | technical master context, RF/CSI concepts |
| `docs/FONTYS_RESEARCH_CONTEXT.md` | academic relationship and boundaries |
| `docs/RYS_CONTEXT.md` | relationship to RYS, relevant principles |
| `docs/PROJECT_STATUS.md` | current truth |
| `docs/ROADMAP.md` | future tracks and gates |
| `docs/EVIDENCE_REGISTER.md` | claim → evidence, anti-inflation |
| `docs/EXPERIMENT_PROTOCOL.md` | how experiments are run and recorded |
| `docs/experiments/*.md` | one experiment each |
| `docs/PROGRESS_LOG.md` | chronological index of meaningful progress |
| `docs/progress/*.md` | detailed milestone records |
| `docs/DECISIONS.md` | technical/research decisions and rationale |

One fact, one home. Do not restate a fact owned elsewhere — link to it.

## 6. Build and test

Verified working on this machine:

```sh
npm test                            # 96 host tests, no hardware needed
~/.platformio/penv/bin/pio run      # ESP32-S3 firmware build
python3 -m http.server 8000         # then open http://localhost:8000/dashboard/
```

`include/secrets.h` is required for the firmware build and is git-ignored. Copy
`include/secrets.example.h`.

## 7. Non-negotiable engineering rules

* Inspect the current implementation before editing. An old prompt or old document is
  not evidence about today's code.
* The CSI callback stays lightweight: validate → BSSID filter → `memcpy` into a bounded
  queue → return. No formatting, no maths, no `Serial`, no blocking.
* Memory stays bounded. Queues, buffers and recording sinks have explicit caps.
* Health metrics stay visible. A sensor failure must never render as "nothing detected".
* Preserve LIVE/REPLAY equivalence: every time-dependent decision inside `CsiPipeline`
  uses the frame's own `tHostMs`, never the wall clock (`tickWatchdog` is the one
  documented exception). `tests/equivalence.test.mjs` guards this.
* `dashboard/csi-core.js` stays free of DOM, Web Serial and timers — that is what makes
  it testable under Node.
* Never silently change the dataset schema. Version it in `docs/DATASET-FORMAT.md`.
* Never silently change the scientific meaning of an output.
* Prefer simple, explainable algorithms first.
* Never commit secrets. Never commit datasets (`*.jsonl` is ignored).

## 8. Scientific honesty

The CSI activity metric means **"the channel changed relative to a baseline"**. Nothing
more. Acceptable wording: *channel changed*, *CSI magnitude changed*, *RF disturbance*,
*experimental activity metric*, *observed under these conditions*.

Never write, without an experiment that supports it: *human detected*, *person located*,
*presence confirmed*, *through-wall*, *distance*, *direction*, *validated system*.

* Synthetic fixtures prove software behaviour only. They are never evidence of RF
  acquisition or sensing performance.
* If a value is a heuristic score, call it a score — never a probability.
* If range or angle is not measured, it is absent/null, not zero.
* Negative and inconclusive results are valid results. Do not tune a metric until it
  produces the expected ordering; report the ordering you got.
* No ML until a real labelled dataset exists. No localisation because it demos well.

## 9. Data rules

* Raw recorded data is immutable. Derived data may be regenerated.
* Never modify a dataset to improve a result. Never delete a run because it contradicts
  the hypothesis — mark it DEGRADED or INVALID FOR X and keep it.
* Retain provenance where it exists: dataset, node/link, configuration, firmware and app
  version, git commit. Do not invent provenance that was never recorded.

## 10. Experiment rules

Experiments are defined **before** data is collected, with a falsifiable hypothesis.
Use [docs/EXPERIMENT_PROTOCOL.md](docs/EXPERIMENT_PROTOCOL.md) and
`docs/experiments/TEMPLATE.md`. IDs are local (`CSI-EXP-001`), never RYS `RYS-EXP-NNN`
unless the work is explicitly designated an RYS experiment.

A distance written in experiment metadata is **ground-truth geometry**, never a
CSI-measured distance.

## 11. Documentation workflow

```text
CODE / EXPERIMENT / RESULT
        ↓
DOCUMENTATION IMPACT CHECK
        ↓
UPDATE ONLY THE RELEVANT CANONICAL FILE(S)
        ↓
COMMIT TOGETHER
```

### Documentation impact check

Before finishing any meaningful task, ask:

```text
Did the verified project state change?
Did the architecture change?
Did the meaning of an algorithm change?
Did experiment evidence change?
Did the dataset/schema change?
Did hardware assumptions change?
Did roadmap direction or a gate change?
Did branch/milestone state change?
Did the RYS relationship change?
Did Fontys relevance change?
Did a known limitation change?
Did a scientific claim change?
Did new evidence appear?
Did an assumption become false?
```

**Yes** → update only the owning document(s), in the same commit.
**No** → change nothing. Do not touch documentation to create activity. Formatting fixes,
typos and trivial refactors get no documentation.

Where an experiment result belongs: the experiment record first; `PROGRESS_LOG.md` only
if it is meaningful progress; `EVIDENCE_REGISTER.md` only if a claim changed;
`PROJECT_STATUS.md` only if current state changed; `DECISIONS.md` only if a decision
was actually made.

### External documentation follow-up

When repository evidence implies a canonical Drive document should change, do not edit
it. Append a block to the owning repository document:

```markdown
## External documentation follow-up

### Fontys
Suggested update:
Reason:
Evidence:
Status: NOT YET SYNCHRONIZED
```

## 12. History rule

Progress records, experiments and decisions are append-only in spirit. When new evidence
contradicts an old interpretation, keep the old record, add a new one, and mark the old
interpretation superseded. How understanding changed is itself evidence.

## 13. Git rules

* Commit documentation together with the change it describes.
* Do not merge, rebase across branches, or force-push.
* Keep `include/secrets.h` and `*.jsonl` out of every commit.

## 14. When to stop and ask

* The change would alter firmware behaviour or a sensing algorithm during a docs task.
* A canonical Fontys or RYS document contradicts the repository in a way that needs a
  human decision.
* A change would weaken or strengthen a capability claim without matching evidence.
* Hardware evidence is needed and no hardware is available.
* The task implies building something listed in §15.

## 15. Do not build yet

Not because they are bad ideas — because no evidence requires them:

* CSI v0.2 motion/presence detection (blocked on real CSI)
* localisation, zone inference, spatial mapping
* machine learning of any kind
* multi-node acquisition, mesh, time-division, synchronisation
* radar / multi-modal fusion
* an RYS SensorAdapter or any RYS integration
* SoftAP / standalone demo mode
* 5 GHz work (the current ESP32-S3 is 2.4 GHz only)

`node_id`, `link_id` and `source` exist as data-model preparation only. They prove
nothing about multi-node capability.
