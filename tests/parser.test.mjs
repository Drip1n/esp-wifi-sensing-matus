// Parser robustness. The contract under test: ONE malformed frame costs
// exactly that frame, and the stream recovers on the very next good line.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LineAssembler, TransportReader, parseCsiLine, parseStatLine, parseInfoLine,
  classifyLine, strictInt, MALFORMED, MAX_CSI_BYTES
} from "../dashboard/csi-core.js";
import { messyTranscript, stableChannel, csiLine, framesToLines } from "./fixtures.mjs";

const encoder = new TextEncoder();

function collect(text, chunkSize = null) {
  const seen = { frames: [], malformed: [], stats: [], infos: [], unknown: [] };
  const reader = new TransportReader({
    onFrame: (f) => seen.frames.push(f),
    onMalformed: (reason, _ts, line) => seen.malformed.push({ reason, line }),
    onStat: (s) => seen.stats.push(s),
    onInfo: (i) => seen.infos.push(i),
    onUnknown: (l) => seen.unknown.push(l)
  });
  const bytes = encoder.encode(text);
  if (chunkSize === null) {
    reader.feed(bytes, 0);
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      reader.feed(bytes.subarray(i, i + chunkSize), i);
    }
  }
  return { seen, reader };
}

test("strictInt rejects what Number() silently accepts", () => {
  assert.equal(Number(""), 0);
  assert.ok(Number.isNaN(strictInt("")));
  assert.ok(Number.isNaN(strictInt(" ")));
  assert.ok(Number.isNaN(strictInt("1.5")));
  assert.ok(Number.isNaN(strictInt("0x10")));
  assert.ok(Number.isNaN(strictInt("1e3")));
  assert.equal(strictInt("-128"), -128);
  assert.equal(strictInt(" 42 "), 42);
});

test("every malformed shape is rejected with the right reason", () => {
  const cases = [
    ["CSI,7", MALFORMED.SHORT],
    ["CSI,1,-54,-92,6,1,100,0,4,1,2,3", MALFORMED.COUNT_MISMATCH],
    ["CSI,1,-54,-92,6,1,zz,0,4,1,2,3,4", MALFORMED.FIELD],
    ["CSI,1,-54,-92,6,1,100,0,5,1,2,3,4,5", MALFORMED.ODD_LENGTH],
    ["CSI,1,-54,-92,6,1,100,0,0", MALFORMED.SHORT],
    [`CSI,1,-54,-92,6,1,100,0,${MAX_CSI_BYTES + 2},` + new Array(MAX_CSI_BYTES + 2).fill(1).join(","), MALFORMED.OVERSIZED],
    ["CSI,1,-54,-92,6,1,100,0,4,1,2,3,900", MALFORMED.SAMPLE_RANGE],
    ["CSI,1,-54,-92,6,1,100,0,4,1,2,3,", MALFORMED.FIELD]
  ];
  for (const [line, reason] of cases) {
    const result = parseCsiLine(line);
    assert.equal(result.ok, false, line.slice(0, 40));
    assert.equal(result.reason, reason, line.slice(0, 40));
  }
});

test("a valid frame parses to exact int8 values", () => {
  const result = parseCsiLine("CSI,42,-54,-92,6,1,123456,1,4,-128,127,0,-1");
  assert.ok(result.ok);
  assert.deepEqual(Array.from(result.frame.csi), [-128, 127, 0, -1]);
  assert.equal(result.frame.seq, 42);
  assert.equal(result.frame.fwi, 1);
  assert.equal(result.frame.tEspUs, 123456);
});

test("a messy transcript yields every good frame and nothing else", () => {
  const { seen } = collect(messyTranscript().lines.join("\n") + "\n");
  assert.equal(seen.frames.length, messyTranscript().goodFrames);
  assert.equal(seen.stats.length, 1);
  assert.equal(seen.malformed.length, 6);
  assert.ok(seen.unknown.length >= 2, "boot garbage counted, not parsed");
  const reasons = new Set(seen.malformed.map((m) => m.reason));
  assert.ok(reasons.has(MALFORMED.COUNT_MISMATCH));
  assert.ok(reasons.has(MALFORMED.ODD_LENGTH));
  assert.ok(reasons.has(MALFORMED.OVERSIZED));
  assert.ok(reasons.has(MALFORMED.SAMPLE_RANGE));
  assert.ok(reasons.has(MALFORMED.SHORT));
});

test("result is identical however the bytes are fragmented", () => {
  const text = messyTranscript().lines.join("\n") + "\n";
  const whole = collect(text);
  const wholeBad = whole.seen.malformed.length + whole.reader.assembler.overflows;
  for (const size of [1, 3, 17, 64, 997, 4096]) {
    const split = collect(text, size);
    // The good frames are what must match exactly, byte for byte.
    assert.deepEqual(
      split.seen.frames.map((f) => Array.from(f.csi)),
      whole.seen.frames.map((f) => Array.from(f.csi)),
      `chunk size ${size}`
    );
    // Nothing is lost silently. A line longer than the assembler limit is
    // attributed to an assembler overflow rather than to the frame parser when
    // the chunking splits it, so the two counters are compared together.
    assert.equal(split.seen.malformed.length + split.reader.assembler.overflows, wholeBad,
                 `chunk size ${size}`);
  }
});

test("many whole frames in one read are all recovered", () => {
  const frames = stableChannel(40).frames;
  const { seen } = collect(framesToLines(frames).join("\n") + "\n");
  assert.equal(seen.frames.length, 40);
});

test("a partial trailing line is held, not parsed, then completed", () => {
  const frame = stableChannel(1).frames[0];
  const line = csiLine(frame);
  const cut = Math.floor(line.length / 2);
  const seen = { frames: [], malformed: [] };
  const reader = new TransportReader({
    onFrame: (f) => seen.frames.push(f),
    onMalformed: (r) => seen.malformed.push(r)
  });
  reader.feedText(line.slice(0, cut), 0);
  assert.equal(seen.frames.length, 0);
  assert.equal(seen.malformed.length, 0);
  reader.feedText(line.slice(cut) + "\n", 1);
  assert.equal(seen.frames.length, 1);
  assert.equal(seen.malformed.length, 0);
});

test("\\r\\n line endings are handled", () => {
  const assembler = new LineAssembler();
  assert.deepEqual(assembler.feedText("one\r\ntwo\nthree"), ["one", "two"]);
  assert.equal(assembler.pending, "three");
});

test("a newline-free flood is dropped whole, and the next real line survives", () => {
  const assembler = new LineAssembler(1000);
  assert.deepEqual(assembler.feedText("x".repeat(5000)), []);
  assert.equal(assembler.overflows, 1);
  assert.equal(assembler.pending, "");
  // Crucially the tail was NOT kept: it would have been spliced onto this line.
  assert.deepEqual(assembler.feedText("INFO,alive\n"), ["INFO,alive"]);
});

test("STAT parses in both the 10-field and 11-field firmware shapes", () => {
  const modern = parseStatLine("STAT,1000,20.0,400,1,2,3,4,5,-54,210000");
  assert.equal(modern.dropQueue, 1);
  assert.equal(modern.dropUsbBusy, 5);
  assert.equal(modern.rssi, -54);
  assert.equal(modern.freeHeap, 210000);
  const legacy = parseStatLine("STAT,1000,20.0,400,1,2,3,4,-54,210000");
  assert.equal(legacy.dropQueue, 1);
  assert.equal(legacy.dropUsbBusy, 0);
  assert.equal(legacy.rssi, -54);
  assert.equal(parseStatLine("STAT,1,2"), null);
  assert.equal(parseStatLine("STAT,1000,20.0,x,1,2,3,4,5,-54,210000"), null);
});

test("INFO lines expose node and link identity", () => {
  assert.deepEqual(parseInfoLine("INFO,node,esp07"), { kind: "node", nodeId: "esp07" });
  assert.deepEqual(parseInfoLine("INFO,link,aa:bb:cc:dd:ee:ff,11"),
                   { kind: "link", bssid: "AA:BB:CC:DD:EE:FF", channel: 11 });
  assert.equal(parseInfoLine("INFO,anything else").kind, "text");
});

test("classifyLine never throws on hostile input", () => {
  for (const line of ["", "   ", "\u0000\u0001", "CSI", "CSI,", ",,,,", "STATS,1"]) {
    assert.ok(classifyLine(line).kind);
  }
});
