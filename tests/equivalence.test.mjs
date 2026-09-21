// ---------------------------------------------------------------------------
// LIVE / REPLAY equivalence.
//
// This is the test the whole record-replay feature exists for. If a dataset
// does not reproduce the live numbers exactly, then "replay the same RF event
// through two algorithm versions and compare" is worthless, because the replay
// would be measuring something slightly different from the capture.
//
// The path under test:
//
//   serial bytes -> TransportReader -> CsiPipeline        (LIVE)
//                                   -> DatasetRecorder
//                                            |
//                                            v
//                     JSONL text -> readDataset -> CsiPipeline   (REPLAY)
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  CsiPipeline, TransportReader, DatasetRecorder, MemoryRecordingSink,
  makeSessionHeader, readDataset, BASELINE
} from "../dashboard/csi-core.js";
import {
  stableChannel, largeChange, subtleChange, singleSubcarrierChange,
  variableTimestamps, rateJitter, clippedChannel, sequenceGaps,
  commonGainScaling, broadChange, framesToLines, messyTranscript
} from "./fixtures.mjs";

const encoder = new TextEncoder();

// Live capture: bytes off the wire, recorded and analysed in one pass - exactly
// what the dashboard does.
function liveRun(text, { chunkSize = 137, armAfter = null, timeOf } = {}) {
  const pipeline = new CsiPipeline({ targetRateHz: 20 });
  const sink = new MemoryRecordingSink();
  const recorder = new DatasetRecorder(sink, makeSessionHeader({ label: "fixture" }));
  let frameCount = 0;

  const reader = new TransportReader({
    onFrame: (frame) => {
      frame.nodeId = pipeline.nodeId;
      frame.linkId = pipeline.linkId;
      // Record first, then analyse, from the SAME object: the dataset holds
      // precisely the numbers the live pipeline saw.
      recorder.writeFrame(frame);
      pipeline.ingestFrame(frame);
      frameCount += 1;
      if (armAfter !== null && frameCount === armAfter) pipeline.armBaseline();
    },
    onMalformed: (reason, tHostMs) => pipeline.noteMalformed(reason, tHostMs),
    onStat: (stat, tHostMs) => { pipeline.ingestStat(stat); recorder.writeStat(stat, tHostMs); },
    onInfo: (info) => { if (info.kind === "link") pipeline.noteLink(info); }
  });

  // The host timestamp is what the live dashboard stamps on each chunk.
  const bytes = encoder.encode(text);
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const tHostMs = timeOf ? timeOf(index) : Math.round(index * 13.7 * 10) / 10;
    reader.feed(bytes.subarray(offset, offset + chunkSize), tHostMs);
    index += 1;
  }
  return { pipeline, text: sink.text(), recorder };
}

function replayRun(datasetText, { armAfter = null } = {}) {
  const dataset = readDataset(datasetText);
  const pipeline = new CsiPipeline({ mode: "replay", targetRateHz: 20 });
  let count = 0;
  for (const frame of dataset.frames) {
    pipeline.ingestFrame(frame);
    count += 1;
    if (armAfter !== null && count === armAfter) pipeline.armBaseline();
  }
  return { pipeline, dataset };
}

function vectorsEqual(a, b, label) {
  assert.equal(a === null, b === null, `${label}: one side is null`);
  if (a === null) return;
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i += 1) {
    assert.ok(Math.abs(a[i] - b[i]) <= 1e-12, `${label}[${i}]: ${a[i]} vs ${b[i]}`);
  }
}

function assertEquivalent(live, replay, label) {
  vectorsEqual(live.rawVector, replay.rawVector, `${label} raw magnitude`);
  vectorsEqual(live.normVector, replay.normVector, `${label} normalised magnitude`);
  vectorsEqual(live.baseline ? live.baseline.norm : null,
               replay.baseline ? replay.baseline.norm : null, `${label} baseline (normalised)`);
  vectorsEqual(live.baseline ? live.baseline.raw : null,
               replay.baseline ? replay.baseline.raw : null, `${label} baseline (raw)`);
  assert.equal(live.baselineState, replay.baselineState, `${label} baseline state`);
  assert.equal(live.baseline ? live.baseline.frames : null,
               replay.baseline ? replay.baseline.frames : null, `${label} baseline frames`);

  if (live.activity === null || replay.activity === null) {
    assert.equal(live.activity, replay.activity, `${label} activity nullness`);
  } else {
    assert.ok(Math.abs(live.activity - replay.activity) <= 1e-12,
              `${label} activity: ${live.activity} vs ${replay.activity}`);
  }

  assert.equal(live.framesProcessed, replay.framesProcessed, `${label} frames processed`);
  assert.equal(live.sequenceGaps, replay.sequenceGaps, `${label} sequence gaps`);
  assert.equal(live.duplicateFrames, replay.duplicateFrames, `${label} duplicates`);
  assert.deepEqual(live.meta, replay.meta, `${label} metadata`);
  assert.ok(Math.abs(live.meanRate() - replay.meanRate()) <= 1e-9, `${label} mean rate`);
  assert.ok(Math.abs(live.clipping.fraction - replay.clipping.fraction) <= 1e-12, `${label} clipping`);
  assert.equal(live.quality().level, replay.quality().level, `${label} data quality`);
}

const SCENARIOS = [
  ["stable channel", stableChannel(160)],
  ["subtle change", subtleChange(160)],
  ["large change", largeChange(160)],
  ["common gain scaling", commonGainScaling(160)],
  ["single sub-carrier", singleSubcarrierChange(160)],
  ["broad change", broadChange(160)],
  ["sequence gaps", sequenceGaps(120)],
  ["variable timestamps", variableTimestamps(120)],
  ["rate jitter", rateJitter(160)],
  ["clipping", clippedChannel(120)]
];

for (const [name, scenario] of SCENARIOS) {
  test(`live and replay agree: ${name}`, () => {
    const text = framesToLines(scenario.frames).join("\n") + "\n";
    const live = liveRun(text);
    const replay = replayRun(live.text);
    assert.equal(replay.dataset.errors.length, 0);
    assert.equal(replay.dataset.frames.length, scenario.frames.length);
    assertEquivalent(live.pipeline, replay.pipeline, name);
  });

  test(`live and replay agree with a baseline: ${name}`, () => {
    const text = framesToLines(scenario.frames).join("\n") + "\n";
    const live = liveRun(text, { armAfter: 5 });
    const replay = replayRun(live.text, { armAfter: 5 });
    assertEquivalent(live.pipeline, replay.pipeline, `${name} + baseline`);
    assert.equal(live.pipeline.baselineState, BASELINE.READY, `${name}: baseline should be usable`);
  });
}

test("equivalence holds however the serial stream was fragmented", () => {
  const text = framesToLines(largeChange(160).frames).join("\n") + "\n";
  const reference = liveRun(text, { chunkSize: 4096, armAfter: 5 });
  for (const chunkSize of [1, 7, 61, 512, 65536]) {
    const live = liveRun(text, { chunkSize, armAfter: 5 });
    const replay = replayRun(live.text, { armAfter: 5 });
    assertEquivalent(live.pipeline, replay.pipeline, `chunk ${chunkSize}`);
    // And the analysis itself does not depend on chunking at all.
    vectorsEqual(live.pipeline.normVector, reference.pipeline.normVector, `chunk ${chunkSize} vs reference`);
  }
});

test("a malformed live stream replays to the same result", () => {
  const messy = messyTranscript();
  const live = liveRun(messy.lines.join("\n") + "\n");
  const replay = replayRun(live.text);
  assert.equal(live.pipeline.framesProcessed, messy.goodFrames);
  // Malformed LINES are a live-transport fact and are not recorded as frames,
  // so only the frames that survived are compared.
  vectorsEqual(live.pipeline.normVector, replay.pipeline.normVector, "messy normalised");
  assert.equal(replay.pipeline.framesProcessed, live.pipeline.framesProcessed);
  assert.equal(replay.dataset.errors.length, 0, "a recording of a messy stream is itself clean");
});

test("the dataset is the live data, not a re-derivation of it", () => {
  const scenario = largeChange(40);
  const text = framesToLines(scenario.frames).join("\n") + "\n";
  const live = liveRun(text);
  const dataset = readDataset(live.text);
  for (let i = 0; i < scenario.frames.length; i += 1) {
    assert.deepEqual(Array.from(dataset.frames[i].csi), Array.from(scenario.frames[i].csi), `frame ${i}`);
    assert.equal(dataset.frames[i].seq, scenario.frames[i].seq);
    assert.equal(dataset.frames[i].tEspUs, scenario.frames[i].tEspUs);
  }
});

test("replaying a recording of a replay changes nothing (idempotent)", () => {
  const text = framesToLines(subtleChange(120).frames).join("\n") + "\n";
  const first = liveRun(text, { armAfter: 5 });
  const second = replayRun(first.text, { armAfter: 5 });

  // Record the replay back out and run it a third time.
  const sink = new MemoryRecordingSink();
  const recorder = new DatasetRecorder(sink, makeSessionHeader());
  for (const frame of readDataset(first.text).frames) recorder.writeFrame(frame);
  const third = replayRun(sink.text(), { armAfter: 5 });

  assertEquivalent(second.pipeline, third.pipeline, "replay of a replay");
});
