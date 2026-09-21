// ---------------------------------------------------------------------------
// serial-link.js - Web Serial lifecycle for the ESP32-S3 native USB port.
//
// Lifted out of the dashboard unchanged in behaviour so it can be exercised
// under Node against a fake `navigator.serial`. The two properties that matter
// were learned the hard way and are preserved exactly:
//
//   1. The native USB CDC port sends NOTHING until the host raises DTR. The
//      port opens perfectly and zero bytes arrive. setSignals() is mandatory.
//   2. Every await in cleanup is BOUNDED. An unplugged device makes
//      reader.cancel() and port.close() hang forever, and an unbounded await
//      there wedges the whole UI with no way back except a page reload.
// ---------------------------------------------------------------------------
"use strict";

export const LinkState = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  PORT_OPEN: "PORT OPEN",
  READING: "READING",
  STOPPING: "STOPPING",
  ERROR: "ERROR"
};

export const BAUD_RATE = 115200;        // ignored by native USB CDC, which runs at USB speed
export const SERIAL_BUFFER_SIZE = 8192; // CSI lines are ~1.3 kB, far bigger than the RSSI ones
export const CLEANUP_TIMEOUT_MS = 2000;

export function describeError(error) {
  if (!error) return "Unknown error";
  return error.message || error.name || String(error);
}

// Resolves to a result object and NEVER rejects or hangs. Cleanup uses this for
// every await so a dead USB device cannot wedge the state machine.
export function settle(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });
  const work = Promise.resolve(promise).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class SerialLink {
  constructor(options = {}) {
    this.serial = options.serial || (typeof navigator !== "undefined" ? navigator.serial : null);
    this.onChunk = options.onChunk || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onOpen = options.onOpen || (() => {});
    this.cleanupTimeoutMs = options.cleanupTimeoutMs || CLEANUP_TIMEOUT_MS;

    this.state = LinkState.DISCONNECTED;
    this.note = "Connect your ESP32-S3 to begin.";
    this.signalsState = "UNKNOWN";
    this.cleanupCompleted = true;
    this.lastError = "";
    this.session = null;
    this.sessionCounter = 0;
    this.connectedAt = 0;
  }

  get supported() { return Boolean(this.serial); }
  get live() { return this.state === LinkState.READING; }
  get busy() {
    return this.state === LinkState.CONNECTING ||
           this.state === LinkState.PORT_OPEN ||
           this.state === LinkState.STOPPING;
  }

  setState(next, note) {
    this.state = next;
    if (note !== undefined) this.note = note;
    this.onStateChange(this);
  }

  isCurrentSession(candidate) {
    return this.session === candidate && !candidate.stopping;
  }

  diagnostics() {
    return {
      state: this.state,
      port: Boolean(this.session && this.session.port),
      reader: Boolean(this.session && this.session.reader),
      readLoopActive: Boolean(this.session && this.session.readLoopActive),
      signals: this.signalsState,
      cleanupCompleted: this.cleanupCompleted,
      lastError: this.lastError,
      sessionId: this.session ? this.session.id : null
    };
  }

  async connect() {
    if (!this.supported) return false;
    // Double clicks, and clicks during teardown, are ignored.
    if (this.state !== LinkState.DISCONNECTED && this.state !== LinkState.ERROR) return false;

    this.lastError = "";
    this.signalsState = "UNKNOWN";
    this.cleanupCompleted = true;
    this.setState(LinkState.CONNECTING, "Choose the ESP32-S3 serial device in the browser prompt.");

    // Always ask explicitly. Reusing a port from getPorts() skips the picker and
    // can hand back a stale device that silently produces zero bytes.
    let port;
    try {
      port = await this.serial.requestPort();
    } catch (error) {
      if (error && error.name === "NotFoundError") {
        this.setState(LinkState.DISCONNECTED, "Connection cancelled. Press Connect ESP32 when you are ready.");
      } else {
        this.lastError = describeError(error);
        this.setState(LinkState.ERROR, "The browser refused to open the device picker.");
      }
      return false;
    }

    try {
      await this.openPort(port);
    } catch (error) {
      this.lastError = describeError(error);
      await settle(port.close(), this.cleanupTimeoutMs); // may not even be open; harmless
      this.setState(LinkState.ERROR,
        "Could not open the port. Close the PlatformIO Serial Monitor, replug the USB cable, and try again.");
      return false;
    }

    this.setState(LinkState.PORT_OPEN, "Port open. Raising DTR…");

    // The ESP32-S3 native USB port is a CDC device: its USB stack only starts
    // transmitting once the host raises DTR. Serial monitors do this for you;
    // Web Serial does not, so without setSignals the port opens perfectly and
    // zero bytes ever arrive. DTR and RTS go up together because on boards with
    // a USB-UART bridge that pair drives the auto-reset circuit, and equal
    // levels mean "no reset".
    const signalResult = await settle(
      port.setSignals({ dataTerminalReady: true, requestToSend: true }),
      this.cleanupTimeoutMs
    );
    if (signalResult.ok) {
      this.signalsState = "SET";
    } else {
      this.signalsState = "FAILED";
      this.lastError = signalResult.timedOut
        ? "setSignals timed out (DTR/RTS not applied)"
        : describeError(signalResult.error);
    }

    this.sessionCounter += 1;
    const session = {
      id: this.sessionCounter,
      port,
      reader: null,
      readLoopActive: false,
      stopping: false,
      done: null
    };
    this.session = session;
    this.connectedAt = Date.now();
    this.onOpen(session);
    this.setState(LinkState.READING, "Connected. Waiting for CSI frames…");
    session.done = this.runReadLoop(session);
    return true;
  }

  async openPort(port) {
    const options = { baudRate: BAUD_RATE, bufferSize: SERIAL_BUFFER_SIZE };
    try {
      await port.open(options);
    } catch (error) {
      // A previous cleanup that timed out can leave this exact port open.
      // Closing and retrying once turns a dead end into a working connection.
      if (error && error.name === "InvalidStateError") {
        await settle(port.close(), this.cleanupTimeoutMs);
        await port.open(options);
        return;
      }
      throw error;
    }
  }

  async runReadLoop(active) {
    let loopError = null;
    let reader = null;

    active.readLoopActive = true;
    try {
      if (!active.port.readable) throw new Error("The serial port is not readable.");
      reader = active.port.readable.getReader();
      active.reader = reader;

      while (this.isCurrentSession(active)) {
        const { value, done } = await reader.read();
        if (done) break; // cancel() was called, or the device closed the stream.
        if (value && value.byteLength > 0) this.onChunk(value);
      }
    } catch (error) {
      loopError = error;
    } finally {
      if (reader) {
        try { reader.releaseLock(); } catch (releaseError) { /* already released */ }
        if (active.reader === reader) active.reader = null;
      }
      active.readLoopActive = false;

      // Still the current session means the stream ended on its own: unplugged
      // USB, an ESP32 reset, or a fatal port error. Clean up the same way a
      // user-pressed Disconnect would, so the next Connect starts from zero.
      if (this.isCurrentSession(active)) {
        if (loopError) this.lastError = describeError(loopError);
        await this.disconnect(loopError
          ? "Connection lost while reading. Check the USB cable, then press Connect ESP32."
          : "The ESP32 stopped sending. Press Connect ESP32 to reconnect.", active);
      }
    }
  }

  // The one place resources are released. Idempotent, bounded at every step, and
  // it always ends with the references cleared even if the hardware misbehaves.
  async disconnect(note, target) {
    const active = target || this.session;
    if (!active || active.stopping) return;   // repeated Disconnect clicks are safe
    if (this.session !== active) return;      // a stale session cannot tear down a live one

    active.stopping = true;                   // invalidates the read loop immediately
    this.cleanupCompleted = false;
    this.setState(LinkState.STOPPING, "Disconnecting…");

    let clean = true;

    // 1. Cancel the reader so a pending read() resolves instead of hanging forever.
    if (active.reader) {
      const cancelled = await settle(active.reader.cancel(), this.cleanupTimeoutMs);
      if (!cancelled.ok) clean = false;
    }

    // 2. Wait for the read loop to actually leave, so it cannot touch state later.
    //    Skipped when disconnect was called from inside that loop's own finally.
    if (active.done && active.readLoopActive) {
      const finished = await settle(active.done, this.cleanupTimeoutMs);
      if (!finished.ok) clean = false;
    }

    // 3. The loop releases its own lock; this only covers the case where it hung.
    if (active.reader) {
      try { active.reader.releaseLock(); } catch (error) { /* already released */ }
      active.reader = null;
    }

    // 4. Drop DTR/RTS so the ESP32's USB stack sees the host detach.
    await settle(active.port.setSignals({ dataTerminalReady: false, requestToSend: false }),
                 this.cleanupTimeoutMs);

    // 5. Close the port. This is what actually releases the device to other apps.
    const closed = await settle(active.port.close(), this.cleanupTimeoutMs);
    if (!closed.ok) {
      clean = false;
      this.lastError = closed.timedOut ? "port.close() timed out" : describeError(closed.error);
    }

    this.session = null;
    this.cleanupCompleted = clean;
    this.setState(LinkState.DISCONNECTED, note || "Disconnected. Press Connect ESP32 when you are ready.");
  }
}
