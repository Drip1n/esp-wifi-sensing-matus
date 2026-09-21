# CSI dataset format — schema version 1

A dataset is a **JSON Lines** (`.jsonl`) file: one JSON object per line, UTF-8, `\n` separated.
The first line is always the session header.

## Why JSONL and not CSV

| | JSONL | CSV |
| --- | --- | --- |
| Streaming write | append one line per frame | same |
| Streaming read | `json.loads(line)` | needs a header row to mean anything |
| Mixed record types | `type` field, one file | needs separate files or ragged rows |
| 256 CSI columns | one `csi` array | 256 unnamed columns |
| Self-describing | yes | only with the header row |
| Size per frame | ~1.15 kB | ~0.9 kB |

JSONL costs about 25 % more bytes. At 20 Hz that is 24 kB/s instead of 19 kB/s, which is not
the constraint here — being able to hand someone a file that explains itself is worth more.
A truncated file (crash, unplug) loses at most its last line either way.

Both `json` in Python and `JSON.parse` in JS read it with no parser to write:

```python
import json
with open("esp01_walk_direct_2026-09-21T14-05-11.jsonl") as f:
    header = json.loads(f.readline())
    assert header["schema_version"] == 1
    for line in f:
        rec = json.loads(line)
        if rec["type"] != "csi":
            continue
        iq = rec["csi"]                       # signed ints, -128..127
        mags = [ (iq[2*k]**2 + iq[2*k+1]**2) ** 0.5 for k in range(rec["len"] // 2) ]
```

## Record types

### `session` — always the first line

```json
{"type":"session","schema_version":1,"source":"wifi_csi","node_id":"esp01",
 "link_id":"esp01-ap","started_at":"2026-09-21T14:05:11.492Z","target_rate_hz":20,
 "app_version":"csi-0.1.1-record-replay","firmware":"csi-0.1.1",
 "bssid":"AA:BB:CC:DD:EE:FF","channel":6,"label":"walk_direct","note":"AP 2.5 m, door closed"}
```

`label` and `note` are whatever the operator typed, and are the whole annotation system —
enough to tell `still` from `walk_off_axis` six weeks later, and no more than that.

**Secrets are never written.** The SSID and the Wi-Fi password stay in `include/secrets.h`
and never reach the firmware's serial output, so they cannot reach a dataset. `bssid` is the
access point's hardware address, which identifies the radio path and is not a credential;
drop the field if a dataset is going somewhere public.

### `csi` — one received CSI frame

```json
{"type":"csi","node_id":"esp01","link_id":"esp01-ap","seq":1337,"t_host_ms":66845.3,
 "t_esp_us":3417820416,"rssi":-54,"noise":-92,"channel":6,"sig_mode":1,
 "first_word_invalid":0,"len":256,"csi":[12,-33,14,-30, ... ]}
```

| Field | Meaning |
| --- | --- |
| `node_id` / `link_id` | which sensing node, and which radio link, produced this frame |
| `seq` | the firmware's own frame counter; gaps here are frames that never arrived |
| `t_host_ms` | ms since the host recording session started, 0.1 ms resolution — **the replay clock** |
| `t_esp_us` | `rx_ctrl.timestamp`, a 32-bit microsecond counter that wraps every ~71.6 min |
| `rssi` / `noise` | packet RSSI and noise floor, dBm |
| `channel` | Wi-Fi channel the frame was received on |
| `sig_mode` | 0 = non-HT (11b/g), 1 = HT (11n) |
| `first_word_invalid` | hardware flag: the first four bytes may be garbage |
| `len` | CSI length **in bytes** (always even; two bytes per sub-carrier) |
| `csi` | the raw int8 values exactly as the radio reported them, **imag first then real** |

`csi` is stored verbatim. The dataset is lossless with respect to the measurement: magnitude,
normalisation and everything downstream are recomputed from these bytes at replay time, which
is what lets a new algorithm be run against an old capture.

### `stat` — the firmware's own counters, once a second

```json
{"type":"stat","t_host_ms":67000.1,"rate":19.8,"emitted":1341,"drop_queue":0,
 "drop_mac":72,"drop_size":0,"truncated":0,"drop_usb_busy":0,"rssi":-54,"free_heap":214532}
```

### `event` — something changed

```json
{"type":"event","t_host_ms":66000.0,"event":"link","detail":{"kind":"link","bssid":"AA:BB:CC:DD:EE:FF","channel":6}}
```

Events recorded: `link` (BSSID/channel seen) and `baseline_armed`.

## Reader rules

* Unknown `type` values are ignored, so a future writer can add records without breaking this reader.
* A line that does not parse costs exactly that line; every other frame survives. The dashboard
  reports the count and the reason under **Replay parse errors**.
* A `session` line whose `schema_version` is not 1 is rejected by name. There is no migration
  framework yet, deliberately — when the format changes, the version will say so.
* Frames are sorted by `t_host_ms` on load, because the replay clock depends on it.

## Size

Measured on 256-byte CSI frames, per line including the newline:

| | bytes / frame |
| --- | --- |
| typical (mostly one- and two-digit samples) | 953 |
| loud channel (many three-digit samples) | 1 108 |
| worst case (every sample `-128`) | 1 458 |

| Recording | Frames at 20 Hz | Size (typical → worst) |
| --- | --- | --- |
| 2 minutes | 2 400 | 2.2 → 3.3 MB |
| 10 minutes | 12 000 | 11 → 17 MB |
| 60 minutes | 72 000 | 65 → 100 MB |

The dashboard's in-tab fallback buffer stops at **24 MB**, which is 14–21 minutes at 20 Hz
depending on the data. Recording straight to a file has no such limit — see
[the README](../README.md#2-recording-a-dataset).
