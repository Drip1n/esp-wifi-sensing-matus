// Dataset recording: serialisation, schema version, parse recovery, and the
// memory behaviour of a long recording.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION, makeSessionHeader, serialiseCsiRecord, parseDatasetLine,
  readDataset, DatasetRecorder, MemoryRecordingSink, FileRecordingSink,
  DATASET_ERROR, MEMORY_RECORDING_LIMIT_BYTES, RECORDING_CHUNK_BYTES
} from "../dashboard/csi-core.js";
import { stableChannel, variableTimestamps } from "./fixtures.mjs";

function record(frames, header = makeSessionHeader({ label: "still" })) {
  const sink = new MemoryRecordingSink();
  const recorder = new DatasetRecorder(sink, header);
  for (const frame of frames) recorder.writeFrame(frame);
  return { sink, recorder, text: sink.text() };
}

test("a recorded frame round-trips byte for byte", () => {
  const frame = stableChannel(1).frames[0];
  const parsed = parseDatasetLine(serialiseCsiRecord(frame));
  assert.ok(parsed.ok);
  assert.equal(parsed.kind, "csi");
  assert.deepEqual(Array.from(parsed.frame.csi), Array.from(frame.csi));
  for (const key of ["seq", "tHostMs", "tEspUs", "rssi", "noise", "channel", "sigMode", "fwi", "len"]) {
    assert.equal(parsed.frame[key], frame[key], key);
  }
  assert.equal(parsed.frame.nodeId, "esp01");
  assert.equal(parsed.frame.linkId, "esp01-ap");
  assert.equal(parsed.frame.source, "wifi_csi");
});

test("the session header carries the schema version and no secrets", () => {
  const header = makeSessionHeader({
    label: "walk_direct", note: "2 m apart", bssid: "AA:BB:CC:DD:EE:FF",
    channel: 6, targetRateHz: 20, firmware: "csi-0.1.1"
  });
  assert.equal(header.schema_version, SCHEMA_VERSION);
  assert.equal(header.type, "session");
  assert.equal(header.source, "wifi_csi");
  assert.equal(header.node_id, "esp01");
  assert.equal(header.link_id, "esp01-ap");
  assert.equal(header.label, "walk_direct");
  assert.ok(header.started_at.endsWith("Z"));

  const serialised = JSON.stringify(header).toLowerCase();
  // "bssid" contains "ssid", so the network name is checked as a JSON key.
  assert.ok(!serialised.includes('"ssid"'), "header must not contain an SSID field");
  for (const key of ["password", "passphrase", "psk", "secret"]) {
    assert.ok(!serialised.includes(key), `header must not contain ${key}`);
  }
  // bssid is a hardware address, not a credential, and is intentionally kept.
  assert.ok(serialised.includes("bssid"));
});

test("a dataset with an unsupported schema version is rejected by name", () => {
  const bad = JSON.stringify({ ...makeSessionHeader(), schema_version: 99 });
  const parsed = parseDatasetLine(bad);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, DATASET_ERROR.SCHEMA);
  assert.equal(parsed.found, 99);
});

test("a whole dataset reads back with the frames intact", () => {
  const frames = stableChannel(50).frames;
  const { text } = record(frames);
  const dataset = readDataset(text);
  assert.equal(dataset.header.schema_version, SCHEMA_VERSION);
  assert.equal(dataset.header.label, "still");
  assert.equal(dataset.frames.length, 50);
  assert.equal(dataset.errors.length, 0);
  assert.equal(dataset.durationMs, frames[49].tHostMs - frames[0].tHostMs);
  assert.deepEqual(Array.from(dataset.frames[7].csi), Array.from(frames[7].csi));
});

test("corrupt dataset lines cost exactly one frame each", () => {
  const frames = stableChannel(20).frames;
  const lines = record(frames).text.trimEnd().split("\n");
  lines.splice(5, 0, "{not json");
  lines.splice(9, 0, JSON.stringify({ type: "csi", len: 4, csi: [1, 2, 3] }));
  lines.splice(13, 0, JSON.stringify({ type: "csi", len: 4, csi: [1, 2, 3, 900], seq: 1, t_host_ms: 0, rssi: -1, noise: -1, channel: 1, sig_mode: 1, first_word_invalid: 0 }));
  lines.splice(17, 0, "[1,2,3]");
  lines.splice(19, 0, JSON.stringify({ noType: true }));

  const dataset = readDataset(lines.join("\n") + "\n");
  assert.equal(dataset.frames.length, 20, "every good frame survives");
  assert.equal(dataset.errors.length, 5);
  assert.equal(dataset.errorsByReason[DATASET_ERROR.JSON], 1);
  assert.equal(dataset.errorsByReason[DATASET_ERROR.CSI_LENGTH], 1);
  assert.equal(dataset.errorsByReason[DATASET_ERROR.SAMPLE_RANGE], 1);
  assert.equal(dataset.errorsByReason[DATASET_ERROR.NO_TYPE], 2);
});

test("variable recorded timestamps survive the round trip exactly", () => {
  const frames = variableTimestamps(80).frames;
  const dataset = readDataset(record(frames).text);
  assert.deepEqual(dataset.frames.map((f) => f.tHostMs), frames.map((f) => f.tHostMs));
  // The 1.8 s stall is still a 1.8 s stall.
  const gaps = [];
  for (let i = 1; i < dataset.frames.length; i += 1) {
    gaps.push(dataset.frames[i].tHostMs - dataset.frames[i - 1].tHostMs);
  }
  assert.ok(Math.max(...gaps) > 1800);
});

test("stat and event records ride alongside the frames", () => {
  const sink = new MemoryRecordingSink();
  const recorder = new DatasetRecorder(sink, makeSessionHeader());
  recorder.writeFrame(stableChannel(1).frames[0]);
  recorder.writeStat({ rate: 20, emitted: 1, dropQueue: 0, dropMac: 0, dropSize: 0,
                       truncated: 0, dropUsbBusy: 0, rssi: -54, freeHeap: 210000 }, 50);
  recorder.writeEvent("baseline_ready", 60, { frames: 61 });
  const dataset = readDataset(sink.text());
  assert.equal(dataset.frames.length, 1);
  assert.equal(dataset.stats.length, 1);
  assert.equal(dataset.events.length, 1);
  assert.equal(dataset.events[0].event, "baseline_ready");
  assert.equal(dataset.stats[0].free_heap, 210000);
});

// -- memory behaviour -------------------------------------------------------

test("a 2-minute 20 Hz recording is comfortably safe", () => {
  // 120 s * 20 Hz = 2400 frames, the target in the brief.
  const base = stableChannel(1).frames[0];
  const sink = new MemoryRecordingSink();
  const recorder = new DatasetRecorder(sink, makeSessionHeader({ label: "still" }));
  for (let i = 0; i < 2400; i += 1) {
    recorder.writeFrame({ ...base, seq: i + 1, tHostMs: i * 50, tEspUs: i * 50000 });
  }
  assert.equal(recorder.frames, 2400);
  assert.equal(recorder.limitReached, false);
  assert.equal(recorder.refused, 0);

  const bytes = sink.bytesWritten;
  assert.ok(bytes < 4 * 1024 * 1024, `2 min recording is ${(bytes / 1048576).toFixed(1)} MB`);
  assert.ok(bytes / 2400 < 1400, "under 1.4 kB per frame");
  // Held as ~1 MB blocks, not one enormous string.
  assert.ok(sink.chunks.length <= Math.ceil(bytes / RECORDING_CHUNK_BYTES) + 1);
  assert.equal(recorder.durationMs(), 2399 * 50);

  const dataset = readDataset(sink.text());
  assert.equal(dataset.frames.length, 2400);
  assert.equal(dataset.errors.length, 0);
});

test("the in-memory sink stops at its limit instead of growing without bound", () => {
  const sink = new MemoryRecordingSink(200000);
  const recorder = new DatasetRecorder(sink, makeSessionHeader());
  const base = stableChannel(1).frames[0];
  for (let i = 0; i < 5000; i += 1) {
    recorder.writeFrame({ ...base, seq: i + 1, tHostMs: i * 50 });
  }
  assert.equal(recorder.limitReached, true);
  assert.ok(sink.bytesWritten <= 200000);
  assert.ok(recorder.frames > 0 && recorder.frames < 5000);
  assert.ok(recorder.refused > 0);
  // Whatever was captured before the limit is still a valid dataset.
  const dataset = readDataset(sink.text());
  assert.equal(dataset.frames.length, recorder.frames);
  assert.equal(dataset.errors.length, 0);
});

test("the per-frame size documented in docs/DATASET-FORMAT.md is the real one", () => {
  const base = stableChannel(1).frames[0];
  const worst = { ...base, csi: new Int8Array(base.len).fill(-128) };

  const measure = (frame) => {
    const sink = new MemoryRecordingSink(Number.MAX_SAFE_INTEGER);
    const recorder = new DatasetRecorder(sink, makeSessionHeader());
    for (let i = 0; i < 1000; i += 1) recorder.writeFrame({ ...frame, seq: i + 1, tHostMs: i * 50 });
    return sink.bytesWritten / 1000;
  };

  const typical = measure(base);
  const worstCase = measure(worst);
  assert.ok(typical > 900 && typical < 1000, `typical frame is ${typical.toFixed(0)} B, docs say ~953`);
  assert.ok(worstCase > 1400 && worstCase < 1500, `worst frame is ${worstCase.toFixed(0)} B, docs say ~1458`);

  // A 10-minute capture at 20 Hz must fit the in-tab fallback buffer even at
  // worst case, which is the claim the README makes.
  const tenMinutesWorst = worstCase * 10 * 60 * 20;
  assert.ok(tenMinutesWorst < MEMORY_RECORDING_LIMIT_BYTES,
            `10 min worst case needs ${(tenMinutesWorst / 1048576).toFixed(1)} MB, limit is ${MEMORY_RECORDING_LIMIT_BYTES / 1048576} MB`);
});

test("the file sink streams and never queues without bound", async () => {
  const written = [];
  let resolveWrite = null;
  const writable = {
    write: (text) => new Promise((resolve) => {
      written.push(text);
      resolveWrite = resolve;
      setTimeout(resolve, 0);
    }),
    close: async () => { written.push("__closed__"); }
  };
  const sink = new FileRecordingSink(writable, 4096);
  const recorder = new DatasetRecorder(sink, makeSessionHeader());
  const base = stableChannel(1).frames[0];
  for (let i = 0; i < 200; i += 1) recorder.writeFrame({ ...base, seq: i + 1, tHostMs: i * 50 });
  // A slow disk causes refusals, not unbounded memory.
  assert.ok(sink.queuedBytes <= 4096);
  await sink.close();
  assert.equal(written[written.length - 1], "__closed__");
  assert.ok(sink.bytesWritten > 0);
  assert.equal(resolveWrite === null, false);
});
