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
3. Press **Calibrate** and keep the environment still for about 5 seconds.
4. When it says *Ready — move around the Wi-Fi link*, walk through the link and watch the graph and motion score.
5. Press **Disconnect** when you are done. The port is fully released, so PlatformIO can use it again.

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

## A good first experiment

```text
Phone hotspot / router
        ↓
   Wi-Fi radio link
        ↓
      ESP32-S3
```

Put the ESP32 a few metres from a phone hotspot or 2.4 GHz router. Walk through the link, or carefully move the phone, and observe how RSSI variation changes. This is a learning prototype, so results depend on the room, radio traffic, and device placement.

## How the detection works

* Every RSSI sample joins a rolling window of the last 20 samples (about one second).
* The **motion score** is the mean absolute change between neighbouring samples in that window.
* **Calibrate** measures that score for 5 quiet seconds and averages it into a **baseline**.
* The **threshold** is the baseline plus a margin set by the Sensitivity slider.
* MOTION starts when the score crosses the threshold, and needs a short hold plus a slightly lower score before it returns to STILL. That hysteresis is what stops the display flickering.
