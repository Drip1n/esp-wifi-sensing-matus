// The shared processing core: magnitudes, normalisation, baseline, activity,
// clipping and data quality.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CsiPipeline, BASELINE, QUALITY, DEFAULT_NODE_ID, DEFAULT_LINK_ID,
  rawMagnitudes, normalise, isAnalysed, clippingOfFrame, meanAbsoluteDifference,
  CLIP_NEAR_LIMIT, assessQuality, MIN_QUALITY_FRAMES, subcarrierIndex, displayOrder
} from "../dashboard/csi-core.js";
import {
  stableChannel, subtleChange, largeChange, commonGainScaling,
  singleSubcarrierChange, broadChange, sequenceGaps, clippedChannel,
  rateJitter, baseAmplitudes, bytesFromAmplitudes
} from "./fixtures.mjs";

function run(frames, options = {}) {
  const pipeline = new CsiPipeline(options);
  for (const frame of frames) pipeline.ingestFrame(frame);
  return pipeline;
}

// Feed `settle` frames, arm the baseline, feed the rest.
function withBaseline(frames, settle = 0, options = {}) {
  const pipeline = new CsiPipeline(options);
  for (let i = 0; i < settle; i += 1) pipeline.ingestFrame(frames[i]);
  pipeline.armBaseline();
  for (let i = settle; i < frames.length; i += 1) pipeline.ingestFrame(frames[i]);
  return pipeline;
}

test("sub-carrier geometry matches the hardware layout", () => {
  assert.equal(subcarrierIndex(0), 0);
  assert.equal(subcarrierIndex(31), 31);
  assert.equal(subcarrierIndex(32), -32);
  assert.equal(subcarrierIndex(63), -1);
  assert.equal(displayOrder.length, 64);
  assert.equal(subcarrierIndex(displayOrder[0]), -32);
  assert.equal(subcarrierIndex(displayOrder[63]), 31);
  // DC null, guard bands and the two always-skipped leading positions are out.
  assert.equal(isAnalysed(0), false);
  assert.equal(isAnalysed(1), false);
  assert.equal(isAnalysed(2), true);
  assert.equal(isAnalysed(27), false);
  assert.equal(isAnalysed(displayOrder[0]), false);
  const analysed = displayOrder.filter(isAnalysed).length;
  assert.equal(analysed, 51); // 52 usable minus position 1 (sub-carrier +1)
});

test("raw magnitude is sqrt(I^2 + Q^2) with the first two positions zeroed", () => {
  const bytes = Int8Array.from([3, 4, 6, 8, 5, 12, -3, -4]);
  const magnitudes = rawMagnitudes(bytes);
  assert.equal(magnitudes[0], 0);
  assert.equal(magnitudes[1], 0);
  assert.equal(magnitudes[2], 13);
  assert.equal(magnitudes[3], 5);
});

test("normalisation cancels a common gain change, raw magnitude does not", () => {
  const scenario = commonGainScaling(120);
  const pipeline = withBaseline(scenario.frames, 0);
  assert.equal(pipeline.baselineState, BASELINE.READY);

  // Every frame differs from the baseline only by one scalar factor, so after
  // normalisation the activity must be essentially zero.
  const activities = [];
  const rawSpread = [];
  const p2 = new CsiPipeline();
  p2.armBaseline();
  for (const frame of scenario.frames) {
    p2.ingestFrame(frame);
    if (p2.baselineState === BASELINE.READY) {
      activities.push(p2.activity);
      rawSpread.push(meanAbsoluteDifference(p2.rawVector, p2.baseline.raw));
    }
  }
  const worstNormalised = Math.max(...activities);
  const worstRaw = Math.max(...rawSpread);
  assert.ok(worstNormalised < 0.02, `normalised residual ${worstNormalised}`);
  // The raw view keeps the gain change, which is the whole point of offering it.
  assert.ok(worstRaw > 3, `raw difference ${worstRaw}`);
});

test("a still channel produces near-zero activity, a changing one does not", () => {
  const still = withBaseline(stableChannel(160).frames, 0);
  assert.equal(still.baselineState, BASELINE.READY);
  assert.ok(still.activity < 1e-9, `still activity ${still.activity}`);

  const subtle = withBaseline(subtleChange(160).frames, 0);
  const large = withBaseline(largeChange(160).frames, 0);
  const single = withBaseline(singleSubcarrierChange(160).frames, 0);
  const broad = withBaseline(broadChange(160).frames, 0);

  // Ordering only. These are synthetic numbers; they say nothing about a room.
  assert.ok(subtle.activity > still.activity);
  assert.ok(large.activity > subtle.activity);
  assert.ok(broad.activity > single.activity,
            `broad ${broad.activity} should exceed single ${single.activity}`);
});

test("activity is the documented mean absolute difference", () => {
  const pipeline = withBaseline(largeChange(160).frames, 0);
  const expected = meanAbsoluteDifference(pipeline.normVector, pipeline.baseline.norm);
  assert.equal(pipeline.activity, expected);

  // And recompute it by hand from the definition in the comments.
  let total = 0, count = 0;
  for (let p = 0; p < pipeline.normVector.length; p += 1) {
    if (!isAnalysed(p)) continue;
    total += Math.abs(pipeline.normVector[p] - pipeline.baseline.norm[p]);
    count += 1;
  }
  assert.ok(Math.abs(pipeline.activity - total / count) < 1e-12);
});

test("baseline needs enough frames and reports failure otherwise", () => {
  const frames = stableChannel(200).frames;
  const good = withBaseline(frames, 0);
  assert.equal(good.baselineState, BASELINE.READY);
  assert.ok(good.baseline.frames >= 20);
  assert.ok(good.baseline.spanMs >= 3000);

  // Same 3 s window, but frames arriving at 2 Hz: not enough to average.
  const sparse = frames.slice(0, 40).map((f, i) => ({ ...f, tHostMs: i * 500, seq: i + 1 }));
  const thin = withBaseline(sparse, 0, { minBaselineFrames: 20 });
  assert.equal(thin.baselineState, BASELINE.FAILED);
  assert.match(thin.baselineReason, /frames arrived/);
  assert.equal(thin.baseline, null);
  assert.equal(thin.activity, null);
});

test("baseline capture is aborted, never silently finished, when input stops", () => {
  const frames = stableChannel(200).frames;
  const pipeline = new CsiPipeline();
  pipeline.armBaseline();
  for (let i = 0; i < 10; i += 1) pipeline.ingestFrame(frames[i]);
  assert.equal(pipeline.baselineState, BASELINE.CAPTURING);

  // Replay paused / USB unplugged mid-capture.
  pipeline.tickWatchdog(999999, 999000, false);
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
  assert.match(pipeline.baselineReason, /input stopped/);
  assert.equal(pipeline.baseline, null);
});

test("baseline capture is aborted when frames stop arriving on the wall clock", () => {
  const frames = stableChannel(200).frames;
  const pipeline = new CsiPipeline();
  pipeline.armBaseline();
  for (let i = 0; i < 10; i += 1) pipeline.ingestFrame(frames[i]);
  pipeline.tickWatchdog(100000, 90000, true);
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
  assert.match(pipeline.baselineReason, /stopped arriving/);
});

test("a changing CSI vector length invalidates the baseline", () => {
  const frames = stableChannel(200).frames;
  const pipeline = withBaseline(frames, 0);
  assert.equal(pipeline.baselineState, BASELINE.READY);

  const shortFrame = { ...frames[100], len: 128, csi: frames[100].csi.slice(0, 128), seq: 5000 };
  pipeline.ingestFrame(shortFrame);
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
  assert.match(pipeline.baselineReason, /CSI length changed/);
});

test("a link change invalidates the baseline and explains itself", () => {
  const pipeline = withBaseline(stableChannel(200).frames, 0);
  pipeline.noteLink({ bssid: "AA:BB:CC:DD:EE:FF", channel: 6 });
  assert.equal(pipeline.baselineState, BASELINE.READY, "same link, baseline survives");
  pipeline.noteLink({ bssid: "11:22:33:44:55:66", channel: 6 });
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
  assert.match(pipeline.baselineReason, /BSSID or channel/);
});

test("a channel change seen in frame metadata invalidates the baseline", () => {
  const frames = stableChannel(200).frames;
  const pipeline = withBaseline(frames, 0);
  pipeline.ingestFrame({ ...frames[100], channel: 11, seq: 9000 });
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
});

test("a sequence reset is treated as a new firmware session", () => {
  const frames = stableChannel(200).frames;
  const pipeline = withBaseline(frames, 0);
  assert.equal(pipeline.baselineState, BASELINE.READY);
  pipeline.ingestFrame({ ...frames[150], seq: 1 });
  assert.equal(pipeline.sequenceResets, 1);
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
  assert.match(pipeline.baselineReason, /sequence restarted/);
});

test("an ESP32 restart seen through STAT counters invalidates the baseline", () => {
  const pipeline = withBaseline(stableChannel(200).frames, 0);
  const stat = { rate: 20, emitted: 5000, dropQueue: 0, dropMac: 0, dropSize: 0, truncated: 0, dropUsbBusy: 0, rssi: -54, freeHeap: 1 };
  pipeline.ingestStat(stat);
  assert.equal(pipeline.baselineState, BASELINE.READY);
  pipeline.ingestStat({ ...stat, emitted: 3 });   // counters went backwards
  assert.equal(pipeline.espStatResets, 1);
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
  assert.match(pipeline.baselineReason, /ESP32 restarted/);
});

test("a mode change wipes every measurement", () => {
  const pipeline = withBaseline(stableChannel(200).frames, 0);
  assert.ok(pipeline.framesProcessed > 0);
  pipeline.setMode("replay");
  assert.equal(pipeline.framesProcessed, 0);
  assert.equal(pipeline.baseline, null);
  assert.equal(pipeline.baselineState, BASELINE.NONE);
  assert.equal(pipeline.normVector, null);
});

test("sequence gaps and duplicates are counted, not merged into the data", () => {
  const scenario = sequenceGaps(60);
  const pipeline = run(scenario.frames);
  assert.equal(pipeline.sequenceGaps, scenario.expectedGaps);
  assert.equal(pipeline.estimatedDropped(), scenario.expectedGaps);

  const frames = stableChannel(10).frames;
  const dup = new CsiPipeline();
  for (const frame of frames) dup.ingestFrame(frame);
  const before = dup.framesProcessed;
  const result = dup.ingestFrame(frames[frames.length - 1]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "duplicate");
  assert.equal(dup.duplicateFrames, 1);
  assert.equal(dup.framesProcessed, before);
});

test("a frame with no usable energy is malformed, and the next frame recovers", () => {
  const frames = stableChannel(30).frames;
  const pipeline = new CsiPipeline();
  pipeline.ingestFrame(frames[0]);
  const dead = { ...frames[1], csi: new Int8Array(256), seq: 500 };
  const result = pipeline.ingestFrame(dead);
  assert.equal(result.accepted, false);
  assert.equal(pipeline.malformedTotal, 1);
  assert.equal(pipeline.ingestFrame({ ...frames[2], seq: 501 }).accepted, true);
  assert.equal(pipeline.framesProcessed, 2);
});

test("clipping is measured over the analysed sub-carriers only", () => {
  const clean = clippingOfFrame(bytesFromAmplitudes(baseAmplitudes()));
  assert.equal(clean.near, 0);
  assert.ok(clean.total > 0);

  const clipped = run(clippedChannel(60).frames);
  assert.ok(clipped.clipping.fraction > 0.1, `fraction ${clipped.clipping.fraction}`);
  assert.equal(clipped.clipping.potential, true);

  const normal = run(stableChannel(60).frames);
  assert.equal(normal.clipping.fraction, 0);
  assert.equal(normal.clipping.potential, false);

  // The criterion itself: |v| >= CLIP_NEAR_LIMIT counts, one below does not.
  const atLimit = new Int8Array(256);
  atLimit[4] = CLIP_NEAR_LIMIT;
  atLimit[5] = -(CLIP_NEAR_LIMIT);
  atLimit[6] = CLIP_NEAR_LIMIT - 1;
  assert.equal(clippingOfFrame(atLimit).near, 2);
});

test("data quality is transport quality: a still room scores GOOD", () => {
  const pipeline = run(stableChannel(300).frames, { targetRateHz: 20 });
  const quality = pipeline.quality();
  assert.equal(quality.level, QUALITY.GOOD);
  // A wildly active channel with the same clean transport also scores GOOD.
  assert.equal(run(largeChange(300).frames, { targetRateHz: 20 }).quality().level, QUALITY.GOOD);
});

test("data quality degrades on gaps, malformed lines and rate error", () => {
  assert.equal(assessQuality({ frames: MIN_QUALITY_FRAMES - 1 }).level, QUALITY.UNKNOWN);

  const gappy = run(sequenceGaps(60).frames, { targetRateHz: 20 });
  assert.notEqual(gappy.quality().level, QUALITY.GOOD);
  assert.match(gappy.quality().reason, /sequence gaps/);

  const wrongRate = run(stableChannel(300).frames, { targetRateHz: 50 });
  assert.equal(wrongRate.quality().level, QUALITY.BAD);
  assert.match(wrongRate.quality().reason, /frame rate error/);

  const noisy = new CsiPipeline({ targetRateHz: 20 });
  const frames = stableChannel(100).frames;
  for (let i = 0; i < frames.length; i += 1) {
    noisy.ingestFrame(frames[i]);
    if (i % 3 === 0) noisy.noteMalformed("bad_numeric_field", frames[i].tHostMs);
  }
  assert.equal(noisy.quality().level, QUALITY.BAD);
  assert.match(noisy.quality().reason, /malformed/);
});

test("firmware drop counters feed the quality verdict", () => {
  const pipeline = new CsiPipeline({ targetRateHz: 20 });
  const frames = stableChannel(120).frames;
  let dropped = 0;
  for (let i = 0; i < frames.length; i += 1) {
    pipeline.ingestFrame(frames[i]);
    if (i % 10 === 0) {
      dropped += 3;
      pipeline.ingestStat({ rate: 20, emitted: i + 1, dropQueue: dropped, dropMac: 0,
                            dropSize: 0, truncated: 0, dropUsbBusy: 0, rssi: -54, freeHeap: 1 });
    }
  }
  assert.ok(pipeline.windowMeasures().espDrops > 0);
  assert.notEqual(pipeline.quality().level, QUALITY.GOOD);
});

test("rate and jitter come from the frames' own timestamps", () => {
  const steady = run(stableChannel(300).frames, { targetRateHz: 20 });
  assert.ok(Math.abs(steady.meanRate() - 20) < 0.01);
  assert.ok(steady.windowMeasures().jitter < 1e-9);

  const jittery = run(rateJitter(300).frames, { targetRateHz: 20 });
  assert.ok(jittery.windowMeasures().jitter > 0.1);
});

test("node and link identity default for a single-node V0.1 capture", () => {
  const pipeline = new CsiPipeline();
  assert.equal(pipeline.nodeId, DEFAULT_NODE_ID);
  assert.equal(pipeline.linkId, DEFAULT_LINK_ID);
  const snapshot = pipeline.snapshot();
  assert.equal(snapshot.source, "wifi_csi");
  assert.equal(snapshot.nodeId, "esp01");
  assert.equal(snapshot.linkId, "esp01-ap");

  // A frame carrying its own identity wins, which is what a second node needs.
  pipeline.ingestFrame({ ...stableChannel(1).frames[0], nodeId: "esp02", linkId: "esp02-ap" });
  assert.equal(pipeline.nodeId, "esp02");
  assert.equal(pipeline.linkId, "esp02-ap");
});

test("normalise refuses a frame with no energy instead of dividing by zero", () => {
  assert.equal(normalise(new Float64Array(64)), null);
});
