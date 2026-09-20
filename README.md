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

The firmware prints samples such as `RSSI,-57`. Diagnostic lines begin with `INFO,`.

## Launch the dashboard

From the project root, run:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/dashboard/> in desktop Chrome or Edge. Then:

1. Press **Connect ESP32** and choose its serial device.
2. Press **Calibrate**.
3. Keep the environment still for about 5 seconds.
4. Move around the Wi-Fi link and watch the graph and motion score.

Web Serial requires a Chromium browser and a secure page; `localhost` is allowed. Close the PlatformIO Serial Monitor before connecting because only one program can use the serial port at a time.

## A good first experiment

```text
Phone hotspot / router
        ↓
   Wi-Fi radio link
        ↓
      ESP32-S3
```

Put the ESP32 a few metres from a phone hotspot or 2.4 GHz router. Walk through the link, or carefully move the phone, and observe how RSSI variation changes. This is a learning prototype, so results depend on the room, radio traffic, and device placement.
