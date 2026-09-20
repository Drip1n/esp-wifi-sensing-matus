# Wi-Fi Motion Detector

A small ESP32-S3 experiment that turns changes in a Wi-Fi radio link into a simple **STILL / MOTION** result.

```text
Wi-Fi → ESP32 RSSI → USB Serial → Browser → motion score → STILL / MOTION
```

This is **RSSI sensing, not CSI sensing**. It detects changes in signal strength, but it cannot determine exact direction, human position, pose, or reliable distance.

## Setup

1. Copy `include/secrets.example.h` to `include/secrets.h`.
2. Put your 2.4 GHz Wi-Fi SSID and password in `include/secrets.h`.
3. Connect the ESP32-S3 by USB.
4. In VS Code, use PlatformIO **Upload** (and **Monitor** at 115200 baud if you want to inspect the output).

The firmware prints one sample every 50 ms, such as `RSSI,-57`. Diagnostic lines begin with `INFO,`.

## Launch the dashboard

From the project root, run:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/dashboard/> in desktop Chrome or Edge. Then:

1. Press **Connect ESP32** and choose its serial device in the browser prompt.
2. Wait until the status line says *Connected. Keep the environment still and press Calibrate.*
3. Press **Calibrate**. It spends about 5 seconds measuring the link's normal RF noise, so keep the phone, the ESP32 and the room still.
4. When it says *Ready — move around the Wi-Fi link*, walk through the link. Watch the **Fast change vs threshold** graph and the **RF activity** field.
5. Press **Disconnect** when you are done. The port is fully released, so PlatformIO can use it again.

The big state word means:

| State | Meaning |
| --- | --- |
| **STILL** | Fast change is below the adaptive threshold. |
| **MOTION** | Fast change crossed the threshold — something disturbed the link right now. |
| **SIGNAL SHIFT** | The average signal level drifted away from the calibrated baseline. The radio path changed; *what* changed it is unknown. |

Recalibrate whenever you move the phone or the ESP32, because the baseline belongs to that exact geometry.

Web Serial requires a Chromium browser and a secure page; `localhost` is allowed. **Close the PlatformIO Serial Monitor before connecting** — only one program can use the serial port at a time.

Every connection asks you to pick the device. That is deliberate: automatic reconnection can silently hand the page a stale port that produces no data, and an explicit pick is always unambiguous.

## Troubleshooting

Open the **Diagnostics** panel at the bottom of the dashboard. It names the exact stage where the pipeline stopped:

| What you see | What it means |
| --- | --- |
| `Connection state: STREAMING` | Everything works. |
| `Bytes received: 0` and `DTR/RTS: SET` | The port is open but the ESP32 is not sending. Check that the Serial Monitor is closed and that you picked the right device. |
| `Bytes received: 0` and `DTR/RTS: FAILED` | The browser could not raise DTR. The ESP32-S3 native USB port only transmits once the host raises it, so no data can arrive. Try the other USB connector on the board. |
| Bytes grow but `RSSI samples parsed: 0` | Serial works, but the ESP32 has not joined Wi-Fi yet. Check the credentials in `include/secrets.h`. |
| `Cleanup completed: NO` | A disconnect step timed out. Replug the USB cable before connecting again. |
| Constant MOTION with nobody moving | The room is noisier than when you calibrated. Recalibrate, or lower Sensitivity. |
| Never triggers, even walking through | Raise Sensitivity, and check `Baseline mean / std` — a large std means calibration caught movement. |

## A good first experiment

```text
Phone hotspot / router
        ↓
   Wi-Fi radio link
        ↓
      ESP32-S3
```

Put the ESP32 a few metres from a phone hotspot or 2.4 GHz router. Walk through the link, or carefully move the phone, and observe how RSSI variation changes. This is a learning prototype, so results depend on the room, radio traffic, and device placement.

## How the detection works (v0.2)

RSSI is the strength of the Wi-Fi signal the ESP32 receives, in dBm. A human body
absorbs and reflects 2.4 GHz radio waves, so moving near the link changes how the
signal bounces around the room (**multipath**) and the received strength wobbles.

The detector measures two different things:

**Fast change** — the average difference between neighbouring RSSI samples over
about one second. Someone walking through the link scrambles the reflections, so
consecutive samples stop agreeing and this number jumps. This is what triggers
**MOTION**.

**Slow change** — how far the average RSSI of the last ~5 seconds has drifted from
the level measured during calibration, in dB. A body parked in the path, or a moved
phone, shifts the average even when the sample-to-sample jitter stays small. This
triggers **SIGNAL SHIFT**, which says *the radio path changed* — it deliberately
does **not** claim a person caused it.

### The adaptive threshold

Calibration does not just measure the average, it measures how much the quiet link
normally wobbles all by itself — the **RF noise floor** (a standard deviation):

```text
fast threshold = baseline mean + max(fixed margin, K × baseline std-dev)
```

* A **quiet** room gets a low threshold, so subtle disturbances still show up.
* A **noisy** room raises its own threshold, so it does not false-trigger all day.
* The fixed margin is what stops the threshold collapsing to zero on a very still link.

The Sensitivity slider moves both the fixed margin and `K`. Measured on a real quiet
link (baseline ≈ 0.02), the thresholds come out roughly:

| Sensitivity | Fast threshold | Roughly what it takes |
| --- | --- | --- |
| Low | ~0.52 | ~10 one-dB changes per second |
| Medium (default) | ~0.29 | ~5 one-dB changes per second |
| High | ~0.15 | ~3 one-dB changes per second |

In a noisy environment the same slider positions produce thresholds around 3.8–4.9
automatically, because the measured noise floor is much larger.

RSSI is reported in whole dBm, so a single 1 dB step spread over the 20-sample window
contributes `1/19 = 0.053`. That is why the margins above are expressed in "one-dB
changes per second" rather than as abstract numbers.

## THIS DOES NOT MEASURE DISTANCE OR LOCATION

The dashboard shows an **RF activity** level: how big the current disturbance is
compared with the trigger threshold. That is all it is.

A single RSSI link **cannot** tell you where a person is, how far away they are, or
which direction they moved. RSSI is affected by multipath, antenna orientation, body
orientation, walls, reflections, other traffic and the access point's own transmit
behaviour. Any "2.4 metres away" readout built on one RSSI stream would be fiction.
The activity field is drawn as a symmetric set of rings with no blips and no bearings
precisely so it cannot be mistaken for radar.

## The physical experiment

This is the interesting part — real measurements to tune the next version.

Set the phone hotspot and the ESP32 a fixed distance apart (2–3 m is a good start) and
keep them still for the whole session. Calibrate once, then for each test below press
**Reset peak**, run the movement for ~15 seconds, and write down the numbers.

Geometries to try, at **0.5 m, 1 m, 2 m and 3 m** from the link:

1. **Direct path** — walk straight between the phone and the ESP32.
2. **Near path** — move just beside the straight line between them.
3. **Off-axis** — move well away from the line joining them.

For each run record:

| Value | Where to read it |
| --- | --- |
| Peak activity (%) | RF activity card |
| Peak fast / peak slow | Diagnostics → *Peak fast / slow* |
| Fast threshold | Diagnostics → *Fast score / threshold* |
| Slow threshold | Diagnostics → *Slow score / threshold* |
| Baseline mean / std | Diagnostics → *Baseline mean / std* |
| Baseline RSSI / std | Diagnostics → *Baseline RSSI / std* |
| Did MOTION trigger? | The big state word |
| Samples / second | Detection card (should stay ~20) |

Also run a **quiet control** with nobody moving, and an **AP movement** test where you
move the phone itself. The control tells you the false-positive rate; the AP test shows
what a very strong disturbance looks like.

Peak activity above 100% means it crossed the threshold. The gap between the direct-path
and off-axis peaks is the number that matters: it tells us how much sensitivity is left
to gain before noise takes over.
