// Web Serial lifecycle, against a fake navigator.serial.
//
// The two properties that must never regress:
//   * DTR is raised on connect (the native USB CDC port sends nothing without it)
//   * every cleanup await is BOUNDED (an unplugged device must not wedge the UI)
import test from "node:test";
import assert from "node:assert/strict";
import { SerialLink, LinkState, settle, describeError } from "../dashboard/serial-link.js";

const encoder = new TextEncoder();

class FakePort {
  constructor(options = {}) {
    this.options = options;
    this.opened = false;
    this.closed = false;
    this.signals = [];
    this.chunks = options.chunks || [];
    this.index = 0;
    this.pendingRead = null;
    this.cancelled = false;
    this.readable = { getReader: () => this.makeReader() };
  }

  async open() {
    if (this.options.openError) {
      const error = new Error("open failed");
      error.name = this.options.openError;
      this.options.openError = this.options.openErrorOnce ? null : this.options.openError;
      throw error;
    }
    this.opened = true;
  }

  async setSignals(signals) {
    if (this.options.hangSignals) return new Promise(() => {});
    this.signals.push(signals);
  }

  async close() {
    if (this.options.hangClose) return new Promise(() => {});
    if (this.options.closeError) throw new Error("close failed");
    this.closed = true;
  }

  makeReader() {
    const port = this;
    return {
      locked: true,
      async read() {
        if (port.cancelled) return { done: true };
        if (port.index < port.chunks.length) {
          const value = port.chunks[port.index];
          port.index += 1;
          if (value === "ERROR") throw new Error("device went away");
          return { value: encoder.encode(value), done: false };
        }
        if (port.options.hangAfterChunks) {
          return new Promise((resolve) => { port.pendingRead = resolve; });
        }
        return { done: true };
      },
      async cancel() {
        if (port.options.hangCancel) return new Promise(() => {});
        port.cancelled = true;
        if (port.pendingRead) { port.pendingRead({ done: true }); port.pendingRead = null; }
      },
      releaseLock() { this.locked = false; }
    };
  }
}

function fakeSerial(port, options = {}) {
  return {
    requestPort: async () => {
      if (options.pickerError) {
        const error = new Error("picker");
        error.name = options.pickerError;
        throw error;
      }
      return port;
    },
    addEventListener() {}
  };
}

test("settle resolves rather than hanging or rejecting", async () => {
  assert.deepEqual(await settle(Promise.resolve(1), 50), { ok: true });
  const failed = await settle(Promise.reject(new Error("boom")), 50);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.message, "boom");
  const timedOut = await settle(new Promise(() => {}), 20);
  assert.deepEqual(timedOut, { ok: false, timedOut: true });
});

test("describeError never returns undefined", () => {
  assert.equal(describeError(null), "Unknown error");
  assert.equal(describeError(new Error("x")), "x");
  assert.equal(describeError({ name: "NotFoundError" }), "NotFoundError");
  assert.equal(describeError("plain string"), "plain string");
});

test("connect raises DTR and RTS, then reads to the end of the stream", async () => {
  const port = new FakePort({ chunks: ["INFO,one\n", "INFO,two\n"] });
  const received = [];
  const link = new SerialLink({ serial: fakeSerial(port), onChunk: (c) => received.push(c) });

  await link.connect();
  // The very first setSignals call must raise DTR, or the board stays silent.
  assert.deepEqual(port.signals[0], { dataTerminalReady: true, requestToSend: true });
  assert.equal(link.signalsState, "SET");

  // connect() returns as soon as the read loop is running; the loop itself
  // finishes when the device closes the stream.
  await link.session.done;
  assert.equal(received.length, 2);
  // The stream ending on its own tears down exactly like a user disconnect.
  assert.equal(link.state, LinkState.DISCONNECTED);
  assert.equal(link.session, null);
  assert.equal(port.closed, true);
  assert.equal(link.cleanupCompleted, true);
  // DTR is dropped on the way out so the ESP32 sees the host detach.
  assert.deepEqual(port.signals[port.signals.length - 1],
                   { dataTerminalReady: false, requestToSend: false });
});

test("a read error tears down and reports the cause", async () => {
  const port = new FakePort({ chunks: ["INFO,one\n", "ERROR"] });
  const link = new SerialLink({ serial: fakeSerial(port) });
  await link.connect();
  await link.session.done;
  assert.equal(link.state, LinkState.DISCONNECTED);
  assert.equal(link.lastError, "device went away");
  assert.match(link.note, /Connection lost/);
  assert.equal(port.closed, true);
});

test("cancelling the picker is not an error", async () => {
  const link = new SerialLink({ serial: fakeSerial(null, { pickerError: "NotFoundError" }) });
  assert.equal(await link.connect(), false);
  assert.equal(link.state, LinkState.DISCONNECTED);
  assert.equal(link.lastError, "");
  assert.match(link.note, /cancelled/);
});

test("a picker failure lands in ERROR, and a retry is still possible", async () => {
  const port = new FakePort({ chunks: [] });
  const link = new SerialLink({ serial: fakeSerial(port, { pickerError: "SecurityError" }) });
  await link.connect();
  assert.equal(link.state, LinkState.ERROR);
  assert.ok(link.lastError);
  // ERROR must not be a dead end.
  link.serial = fakeSerial(port);
  assert.equal(await link.connect(), true);
  await link.session.done;
});

test("a port left open by a previous timed-out cleanup is reopened", async () => {
  const port = new FakePort({ chunks: ["INFO,x\n"], openError: "InvalidStateError", openErrorOnce: true });
  const link = new SerialLink({ serial: fakeSerial(port) });
  assert.equal(await link.connect(), true);
  assert.equal(port.opened, true);
  await link.session.done;
});

test("an open failure closes the port and explains itself", async () => {
  const port = new FakePort({ openError: "NetworkError" });
  const link = new SerialLink({ serial: fakeSerial(port) });
  assert.equal(await link.connect(), false);
  assert.equal(link.state, LinkState.ERROR);
  assert.match(link.note, /Serial Monitor/);
});

test("setSignals hanging does not block the connection", async () => {
  const port = new FakePort({ chunks: ["INFO,x\n"], hangSignals: true });
  const link = new SerialLink({ serial: fakeSerial(port), cleanupTimeoutMs: 60 });
  const started = Date.now();
  await link.connect();
  assert.ok(Date.now() - started < 1500, "connect must not wait on a hung setSignals");
  assert.equal(link.signalsState, "FAILED");
  assert.match(link.lastError, /timed out/);
  assert.equal(link.state, LinkState.READING);
  await link.disconnect();
});

test("an unplugged device cannot wedge disconnect", async () => {
  const port = new FakePort({ chunks: ["INFO,x\n"], hangAfterChunks: true, hangCancel: true, hangClose: true });
  const link = new SerialLink({ serial: fakeSerial(port), cleanupTimeoutMs: 60 });
  await link.connect();
  assert.equal(link.state, LinkState.READING);

  const started = Date.now();
  await link.disconnect();
  const elapsed = Date.now() - started;
  // Three bounded steps of 60 ms, not three forever-awaits.
  assert.ok(elapsed < 1500, `disconnect took ${elapsed} ms`);
  assert.equal(link.state, LinkState.DISCONNECTED);
  assert.equal(link.session, null, "the session reference is dropped even so");
  assert.equal(link.cleanupCompleted, false, "and the user is told cleanup was dirty");
  assert.match(link.lastError, /close/);
});

test("repeated disconnect calls are safe", async () => {
  const port = new FakePort({ chunks: ["INFO,x\n"], hangAfterChunks: true });
  const link = new SerialLink({ serial: fakeSerial(port), cleanupTimeoutMs: 60 });
  await link.connect();
  const session = link.session;
  await Promise.all([link.disconnect(), link.disconnect(session), link.disconnect(session)]);
  assert.equal(link.state, LinkState.DISCONNECTED);
  assert.equal(port.closed, true);
});

test("a second connect while connected is ignored", async () => {
  const port = new FakePort({ chunks: ["INFO,x\n"], hangAfterChunks: true });
  const link = new SerialLink({ serial: fakeSerial(port), cleanupTimeoutMs: 60 });
  await link.connect();
  const sessionId = link.session.id;
  assert.equal(await link.connect(), false);
  assert.equal(link.session.id, sessionId);
  await link.disconnect();
});

test("a stale session cannot tear down a live one", async () => {
  const first = new FakePort({ chunks: ["INFO,a\n"], hangAfterChunks: true });
  const link = new SerialLink({ serial: fakeSerial(first), cleanupTimeoutMs: 60 });
  await link.connect();
  const stale = link.session;
  await link.disconnect();

  const second = new FakePort({ chunks: ["INFO,b\n"], hangAfterChunks: true });
  link.serial = fakeSerial(second);
  await link.connect();
  assert.equal(link.state, LinkState.READING);

  await link.disconnect("note", stale);
  assert.equal(link.state, LinkState.READING, "the live session survived");
  assert.equal(second.closed, false);
  await link.disconnect();
});

test("each connection gets a fresh session id", async () => {
  const link = new SerialLink({ serial: fakeSerial(new FakePort({ chunks: [] })), cleanupTimeoutMs: 60 });
  await link.connect();
  await link.session?.done;
  link.serial = fakeSerial(new FakePort({ chunks: [] }));
  await link.connect();
  assert.equal(link.sessionCounter, 2);
});
