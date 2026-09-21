# Progress records

Detailed records for milestones that are broader than a single experiment — an
architectural step, a working end-to-end path, a capability that changed.

[../PROGRESS_LOG.md](../PROGRESS_LOG.md) is the index; these are the detail. One does not
repeat the other.

## Naming

```text
YYYY-MM-DD-short-slug.md
```

## When to write one

Write a record when a milestone changed what the project *is*: a new capability exists,
an architecture changed, a hardware assumption was confirmed or broken, or a significant
negative result arrived. Do not write one for a refactor, a doc edit or a bug fix.

For a single experiment, write an experiment record in
[../experiments/](../experiments/) instead, and link it from the progress log.

## Structure

Use the structure of the existing records: an **Evidence Card** at the top (date, commit,
branch, engineering status, hardware, software, real RF data, main result, main
limitation, next evidence needed), then goal · why it mattered · what changed · setup ·
evidence produced · results · problems · what we learned · limitations · decision ·
next action · Fontys relevance · RYS relevance · external follow-up.

Mermaid only where it materially improves understanding.

## History rule

Append-only in spirit. A record is not edited to match a later understanding. If later
evidence contradicts it, write a new record and add a pointer to it from the old one.

## Backfill honesty

These records were written on 2026-09-21 from git history, code and existing
documentation. Where a historical detail is not recoverable from that evidence, the
record says:

> Exact historical detail not recoverable from current repository evidence.

That is deliberate and is better than a plausible guess. Never invent a date, a
measurement, a setup or a motivation.
