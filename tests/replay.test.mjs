// Replay transport controls. The rule under test: playback follows the
// RECORDED timestamps, never an assumed fixed interval.
import test from "node:test";
import assert from "node:assert/strict";
import { ReplayPlayer, PLAYBACK_RATES, CsiPipeline, BASELINE } from "../dashboard/csi-core.js";
import { stableChannel, variableTimestamps } from "./fixtures.mjs";

function player(frames, handlers = {}) {
  const seen = [];
  const events = [];
  const instance = new ReplayPlayer(frames, {
    onFrame: (frame) => { seen.push(frame); if (handlers.onFrame) handlers.onFrame(frame); },
    onEnd: () => events.push("end"),
    onRestart: () => events.push("restart")
  });
  return { instance, seen, events };
}

// advance() clamps one call to 1 s of real time on purpose, so real elapsed
// time is fed in small steps, exactly as the animation loop does.
function advanceBy(instance, totalMs, stepMs = 100) {
  let done = 0;
  while (done < totalMs) {
    const step = Math.min(stepMs, totalMs - done);
    instance.advance(step);
    done += step;
  }
}

test("nothing is emitted until play is pressed", () => {
  const { instance, seen } = player(stableChannel(20).frames);
  instance.advance(5000);
  assert.equal(seen.length, 0);
  instance.play();
  instance.advance(5000);
  assert.equal(seen.length, 20);
});

test("playback follows recorded timestamps, not a fixed interval", () => {
  const scenario = variableTimestamps(80);
  const { instance, seen } = player(scenario.frames);
  instance.play();

  // Advance in 100 ms steps of real time at 1x. After each step, exactly the
  // frames whose recorded offset has come due may have been emitted.
  let virtual = 0;
  for (let step = 0; step < 120; step += 1) {
    instance.advance(100);
    virtual += 100;
    const due = scenario.frames.filter((f) => f.tHostMs - scenario.frames[0].tHostMs <= virtual).length;
    assert.equal(seen.length, due, `after ${virtual} ms`);
  }
  assert.equal(seen.length, 80);

  // The 1.8 s hole in the dataset (between frame 39 and frame 40) is a 1.8 s
  // hole in the playback.
  const { instance: i2, seen: s2 } = player(scenario.frames);
  i2.play();
  advanceBy(i2, scenario.frames[39].tHostMs - scenario.frames[0].tHostMs + 10);
  const beforeStall = s2.length;
  assert.equal(beforeStall, 40, "everything up to the stall has played");
  advanceBy(i2, 1000);
  assert.equal(s2.length, beforeStall, "nothing is due while the stall runs");
  advanceBy(i2, 1000);
  assert.ok(s2.length > beforeStall, "playback resumes once the stall is over");
});

test("pause stops the clock and play resumes from where it stopped", () => {
  const frames = stableChannel(60).frames;   // 50 ms apart
  const { instance, seen } = player(frames);
  instance.play();
  instance.advance(500);
  const atPause = seen.length;
  assert.ok(atPause >= 10 && atPause <= 12, `expected ~11 frames, got ${atPause}`);

  instance.pause();
  instance.advance(5000);
  assert.equal(seen.length, atPause, "a paused player emits nothing");

  instance.play();
  instance.advance(500);
  assert.ok(seen.length > atPause);
  // Time did not run on while paused: about 10 more frames, not 100.
  assert.ok(seen.length - atPause <= 12);
});

test("restart rewinds to the first frame", () => {
  const frames = stableChannel(40).frames;
  const { instance, seen, events } = player(frames);
  instance.play();
  instance.advance(1000);
  assert.ok(seen.length > 0);
  const before = seen.length;

  instance.restart();
  assert.equal(instance.playing, false);
  assert.deepEqual(instance.progress(), {
    index: 0, count: 40, virtualMs: 0, durationMs: 39 * 50,
    playing: false, rate: 1, finished: false
  });
  assert.ok(events.includes("restart"));

  instance.play();
  // advance() clamps a single call to 1 s of real time on purpose, so this
  // mirrors the animation loop rather than asking for 100 s in one go.
  for (let i = 0; i < 5; i += 1) instance.advance(1000);
  assert.equal(seen.length, before + 40, "the whole dataset plays again");
});

test("step advances exactly one frame and pauses", () => {
  const frames = stableChannel(10).frames;
  const { instance, seen } = player(frames);
  instance.play();
  assert.equal(instance.step(), true);
  assert.equal(seen.length, 1);
  assert.equal(instance.playing, false, "stepping leaves the player paused");
  assert.equal(instance.step(), true);
  assert.equal(seen.length, 2);
  assert.deepEqual(Array.from(seen[1].csi), Array.from(frames[1].csi));

  for (let i = 0; i < 8; i += 1) instance.step();
  assert.equal(seen.length, 10);
  assert.equal(instance.step(), false, "stepping past the end does nothing");
  assert.equal(instance.finished, true);
});

test("playback speed scales real time against dataset time", () => {
  const frames = stableChannel(400).frames;  // 20 s of data
  for (const rate of PLAYBACK_RATES) {
    const { instance, seen } = player(frames);
    instance.setRate(rate);
    assert.equal(instance.rate, rate);
    instance.play();
    // 1 second of real time at `rate` should deliver about 20 * rate frames.
    for (let i = 0; i < 10; i += 1) instance.advance(100);
    const expected = 20 * rate;
    assert.ok(Math.abs(seen.length - expected) <= 2,
              `${rate}x delivered ${seen.length}, expected about ${expected}`);
  }
});

test("an unknown playback rate is ignored", () => {
  const { instance } = player(stableChannel(5).frames);
  instance.setRate(17);
  assert.equal(instance.rate, 1);
});

test("play after the end restarts rather than doing nothing", () => {
  const frames = stableChannel(10).frames;
  const { instance, seen, events } = player(frames);
  instance.play();
  instance.advance(10000);
  assert.equal(seen.length, 10);
  assert.ok(events.includes("end"));
  instance.play();
  instance.advance(10000);
  assert.equal(seen.length, 20);
});

test("a backgrounded tab cannot dump the dataset in one frame", () => {
  const frames = stableChannel(2000).frames;
  const { instance, seen } = player(frames);
  instance.play();
  instance.advance(600000);       // the tab was hidden for ten minutes
  assert.ok(seen.length <= 400, `emitted ${seen.length} in one tick`);
  assert.ok(seen.length > 0);
});

test("empty and single-frame datasets do not break the player", () => {
  const empty = player([]);
  empty.instance.play();
  assert.equal(empty.instance.advance(1000), 0);
  assert.equal(empty.instance.durationMs, 0);
  assert.equal(empty.instance.step(), false);

  const one = player(stableChannel(1).frames);
  one.instance.play();
  one.instance.advance(1000);
  assert.equal(one.seen.length, 1);
  assert.equal(one.instance.durationMs, 0);
});

test("pausing replay during a baseline capture fails the capture honestly", () => {
  const frames = stableChannel(400).frames;
  const pipeline = new CsiPipeline({ mode: "replay" });
  const { instance } = player(frames, { onFrame: (frame) => pipeline.ingestFrame(frame) });

  instance.play();
  instance.advance(500);
  pipeline.armBaseline();
  instance.advance(500);
  assert.equal(pipeline.baselineState, BASELINE.CAPTURING);

  instance.pause();
  pipeline.tickWatchdog(Date.now(), Date.now(), instance.playing);
  assert.equal(pipeline.baselineState, BASELINE.FAILED);
  assert.match(pipeline.baselineReason, /input stopped/);

  // And a fresh capture after resuming works.
  instance.play();
  pipeline.armBaseline();
  for (let i = 0; i < 5; i += 1) instance.advance(1000);
  assert.equal(pipeline.baselineState, BASELINE.READY);
});

test("progress reports dataset position, not wall-clock position", () => {
  const frames = variableTimestamps(80).frames;
  const { instance } = player(frames);
  instance.play();
  instance.advance(1000);
  const progress = instance.progress();
  assert.equal(progress.count, 80);
  assert.ok(progress.index > 0 && progress.index < 80);
  assert.ok(progress.virtualMs <= progress.durationMs);
  assert.equal(progress.durationMs, frames[79].tHostMs - frames[0].tHostMs);
});
