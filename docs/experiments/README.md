# Experiments

One file per experiment. The method lives in
[../EXPERIMENT_PROTOCOL.md](../EXPERIMENT_PROTOCOL.md); this note is only the local
convention.

**Nothing here has been run yet.** The directory currently holds this README and the
template.

## Naming

```text
CSI-EXP-NNN-short-slug.md
```

`NNN` is sequential, never reused, never renumbered. IDs are **local to this
repository** — they are not RYS experiment IDs and never become `RYS-EXP-NNN` unless RYS
explicitly designates the work as an RYS experiment.

## Creating one

1. Copy `TEMPLATE.md`.
2. Fill everything down to *Results* — including the hypothesis and the falsified-if —
   **before** collecting data, and commit it. A hypothesis written after the data is not
   a hypothesis.
3. Run it, then complete the record. Limitations are mandatory.

## Datasets

Datasets are **not committed** (`*.jsonl` is git-ignored: they are large, and they are
experiment data rather than source). The record carries the filename, the checksum, the
schema version and where the file actually lives, so that the result can be regenerated
from the data plus the configuration plus the commit.

Raw data is immutable. Derived plots and processed output can be regenerated and are
safe to delete.

## Relationship to the other documents

| Document | Update it when |
| --- | --- |
| [../PROGRESS_LOG.md](../PROGRESS_LOG.md) | the experiment is meaningful progress — one short entry plus a link, not a copy |
| [../EVIDENCE_REGISTER.md](../EVIDENCE_REGISTER.md) | the experiment changes a claim's status, up **or down** |
| [../PROJECT_STATUS.md](../PROJECT_STATUS.md) | current project state changed |
| [../DECISIONS.md](../DECISIONS.md) | a decision was actually made as a result |
| [../ROADMAP.md](../ROADMAP.md) | direction or a gate changed |

If none of those changed, update none of them.

## History rule

Experiment records are append-only in spirit. A record is not edited to match a later
understanding. If a later experiment contradicts it, write the new record and add a short
note to the old one pointing at the successor. How the understanding changed is itself
evidence.

A negative result, an inconclusive result and a failed run are all valid records and are
kept with the same care as a successful one.
