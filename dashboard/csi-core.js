// ---------------------------------------------------------------------------
// csi-core.js - the shared CSI processing core.
//
// Everything in this file is pure logic: no DOM, no Web Serial, no timers.
// That is deliberate. The LIVE path (bytes from the ESP32) and the REPLAY path
// (lines from a recorded dataset) both funnel into the SAME functions here, so
// a replayed dataset produces exactly the numbers the live capture produced.
// It is also what lets the whole pipeline be tested under Node with no board
// and no browser.
//
// Timing rule that makes the equivalence work: every time-dependent decision
// in CsiPipeline is driven by the frame's OWN host timestamp (tHostMs), never
// by the wall clock. Live records that timestamp; replay feeds it straight
// back. Wall-clock time is used only for "is the input still alive" watchdogs,
// which are explicitly outside the measurement path.
// ---------------------------------------------------------------------------
"use strict";

// --- Dataset / data-model identity -----------------------------------------

export const SCHEMA_VERSION = 1;

// A frame conceptually belongs to (source type, node, link). Today there is one
// node and one link, but recording these now means a V0.2 dataset with two
// ESP32s is a superset of a V0.1 dataset rather than a different thing.
export const SOURCE_WIFI_CSI = "wifi_csi";
export const DEFAULT_NODE_ID = "esp01";
export const DEFAULT_LINK_ID = "esp01-ap";

// --- Radio layout -----------------------------------------------------------

// ESP32-S3 HT20: long-training-field blocks of 64 sub-carriers, each stored as
// two signed bytes (imaginary first, then real).
export const SUBCARRIERS_PER_BLOCK = 64;

// In a 20 MHz 802.11 channel only indices +/-1..26 carry anything. Index 0 is
// the DC null and |k| > 26 are guard bands.
export const USABLE_MIN = 1;
export const USABLE_MAX = 26;

// Array positions 0 and 1 are always dropped. The hardware can flag the first
// four bytes of a frame invalid, and those four bytes are exactly these two
// sub-carriers. Dropping them from EVERY frame (rather than only when the flag
// is set) costs one usable sub-carrier out of 52 and keeps all frames directly
// comparable - otherwise the flag toggling would look like channel activity.
export const SKIPPED_LEADING_POSITIONS = 2;

// Generous upper bound for a declared CSI length. The firmware caps at 384
// bytes; anything past this is corruption, not a longer frame.
export const MAX_CSI_BYTES = 1024;

// --- Clipping criterion -----------------------------------------------------
//
// Raw CSI samples are signed 8-bit, so they live in [-128, +127]. A sample
// sitting at the very edge of that range may mean the value was CLAMPED rather
// than measured. "Near the limit" is defined as |v| >= 125, i.e. the outermost
// three codes at each end (6 of 256 code points, 2.3% of the code space). If an
// unusually large share of samples land there, the ADC/AGC may be saturating.
// This is a HINT, never a proof.
export const CLIP_NEAR_LIMIT = 125;
export const CLIP_WARN_FRACTION = 0.01; // 1 % of analysed samples

// --- Sampling rates prepared in firmware -----------------------------------
// 50 Hz is PREPARATION ONLY. It has not been verified on hardware.
export const RATE_PRESETS = [
  { hz: 10, pingIntervalMs: 100, bytesPerSecond: 8930, note: "conservative" },
  { hz: 20, pingIntervalMs: 50, bytesPerSecond: 17860, note: "default" },
  { hz: 50, pingIntervalMs: 20, bytesPerSecond: 44650, note: "untested on hardware" }
];

export const DEFAULT_TARGET_RATE_HZ = 20;

// ---------------------------------------------------------------------------
// Sub-carrier geometry
// ---------------------------------------------------------------------------

// Array position -> real OFDM sub-carrier index. The hardware stores 0..31
// first and then -32..-1, so position 32 is sub-carrier -32.
export function subcarrierIndex(position) {
  return position < 32 ? position : position - 64;
}

export function isUsable(index) {
  const magnitude = Math.abs(index);
  return magnitude >= USABLE_MIN && magnitude <= USABLE_MAX;
}

// Which array positions actually go into the maths.
export function isAnalysed(position) {
  return position >= SKIPPED_LEADING_POSITIONS && isUsable(subcarrierIndex(position));
}

// Display order: sub-carrier -32 on the left, +31 on the right.
export const displayOrder = (() => {
  const order = [];
  for (let position = 32; position < 64; position += 1) order.push(position);
  for (let position = 0; position < 32; position += 1) order.push(position);
  return order;
})();

// ---------------------------------------------------------------------------
// CSI maths
// ---------------------------------------------------------------------------

// Each sub-carrier is a complex number; magnitude is its length.
export function magnitudeFromPair(imag, real) {
  return Math.sqrt(imag * imag + real * real);
}

// int8 bytes -> raw magnitude per sub-carrier. Positions 0 and 1 are zeroed
// (see SKIPPED_LEADING_POSITIONS); they are excluded from every calculation
// anyway, and zeroing keeps the drawn line from spiking at the left edge.
export function rawMagnitudes(bytes) {
  const pairs = Math.floor(bytes.length / 2);
  const out = new Float64Array(pairs);
  for (let k = 0; k < pairs; k += 1) {
    out[k] = magnitudeFromPair(bytes[2 * k], bytes[2 * k + 1]);
  }
  if (pairs > 0) out[0] = 0;
  if (pairs > 1) out[1] = 0;
  return out;
}

// Automatic gain control makes the absolute CSI scale drift between frames.
// Dividing by the frame's own mean over the analysed sub-carriers cancels that
// common scaling and leaves the SHAPE across sub-carriers - the part multipath
// actually changes. Returns null when the frame carries no usable energy.
export function normalise(values) {
  let total = 0;
  let count = 0;
  for (let position = 0; position < values.length; position += 1) {
    if (!isAnalysed(position)) continue;
    total += values[position];
    count += 1;
  }
  const mean = count > 0 ? total / count : 0;
  if (!(mean > 0) || !Number.isFinite(mean)) return null;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] / mean;
  return out;
}

// Mean absolute difference over the analysed sub-carriers.
export function meanAbsoluteDifference(current, reference) {
  if (!current || !reference || current.length !== reference.length) return null;
  let total = 0;
  let count = 0;
  for (let position = 0; position < current.length; position += 1) {
    if (!isAnalysed(position)) continue;
    total += Math.abs(current[position] - reference[position]);
    count += 1;
  }
  return count > 0 ? total / count : null;
}

// Fraction of raw int8 samples sitting at the edge of the int8 range, counted
// only over the bytes belonging to analysed sub-carriers (guard bands are near
// zero and would dilute the number into meaninglessness).
export function clippingOfFrame(bytes) {
  let near = 0;
  let total = 0;
  const pairs = Math.floor(bytes.length / 2);
  for (let position = 0; position < pairs; position += 1) {
    if (!isAnalysed(position)) continue;
    const imag = bytes[2 * position];
    const real = bytes[2 * position + 1];
    total += 2;
    if (imag >= CLIP_NEAR_LIMIT || imag <= -CLIP_NEAR_LIMIT) near += 1;
    if (real >= CLIP_NEAR_LIMIT || real <= -CLIP_NEAR_LIMIT) near += 1;
  }
  return { near, total, fraction: total > 0 ? near / total : 0 };
}

// ---------------------------------------------------------------------------
// Strict number parsing
//
// Number("") and Number(" ") are both 0 in JavaScript, which would silently
// turn a truncated line into a plausible-looking frame. Every numeric field
// from the wire goes through these instead.
// ---------------------------------------------------------------------------

const INTEGER_PATTERN = /^[+-]?\d+$/;

export function strictInt(text) {
  if (typeof text !== "string") return NaN;
  const trimmed = text.trim();
  if (!INTEGER_PATTERN.test(trimmed)) return NaN;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : NaN;
}

function strictInt8(text) {
  const value = strictInt(text);
  if (!Number.isFinite(value) || value < -128 || value > 127) return NaN;
  return value;
}

// ---------------------------------------------------------------------------
// Serial line classification and parsing
//
// Reasons are returned rather than thrown so that one malformed frame is a
// counter increment, never an exception that kills the read loop.
// ---------------------------------------------------------------------------

export const MALFORMED = {
  SHORT: "too_few_fields",
  FIELD: "bad_numeric_field",
  LENGTH: "bad_declared_length",
  ODD_LENGTH: "odd_iq_length",
  OVERSIZED: "oversized_frame",
  COUNT_MISMATCH: "value_count_mismatch",
  SAMPLE_RANGE: "sample_out_of_int8_range",
  NO_ENERGY: "no_usable_energy"
};

// CSI,seq,rssi,noise,channel,sig_mode,timestamp_us,first_word_invalid,len,v0,v1,...
export function parseCsiLine(line) {
  const fields = line.split(",");
  if (fields.length < 10) return { ok: false, reason: MALFORMED.SHORT };

  const seq = strictInt(fields[1]);
  const rssi = strictInt(fields[2]);
  const noise = strictInt(fields[3]);
  const channel = strictInt(fields[4]);
  const sigMode = strictInt(fields[5]);
  const tEspUs = strictInt(fields[6]);
  const fwi = strictInt(fields[7]);
  const len = strictInt(fields[8]);

  if (![seq, rssi, noise, channel, sigMode, tEspUs, fwi, len].every(Number.isFinite)) {
    return { ok: false, reason: MALFORMED.FIELD };
  }
  if (len < 2) return { ok: false, reason: MALFORMED.LENGTH };
  if (len % 2 !== 0) return { ok: false, reason: MALFORMED.ODD_LENGTH };
  if (len > MAX_CSI_BYTES) return { ok: false, reason: MALFORMED.OVERSIZED };

  const values = fields.slice(9);
  // A declared length that does not match the values present means the line was
  // truncated by USB back-pressure or two lines were glued together.
  if (values.length !== len) return { ok: false, reason: MALFORMED.COUNT_MISMATCH };

  const csi = new Int8Array(len);
  for (let i = 0; i < len; i += 1) {
    const value = strictInt8(values[i]);
    if (!Number.isFinite(value)) {
      return { ok: false, reason: Number.isFinite(strictInt(values[i]))
        ? MALFORMED.SAMPLE_RANGE : MALFORMED.FIELD };
    }
    csi[i] = value;
  }

  return {
    ok: true,
    frame: {
      source: SOURCE_WIFI_CSI,
      seq, rssi, noise, channel, sigMode, fwi, len,
      tEspUs,
      csi
    }
  };
}

// STAT,uptime_ms,rate,emitted,drop_queue,drop_mac,drop_size,truncated,usb_busy,rssi,free_heap
//
// Firmware V0.1.0 sent one field fewer (no usb_busy). Both are accepted: an
// older board must not make the dashboard look broken.
export function parseStatLine(line) {
  const f = line.split(",");
  if (f.length < 10) return null;
  const rate = Number(f[2]);
  const numbers = f.slice(3).map(strictInt);
  const extended = f.length >= 11;
  const stat = {
    uptimeMs: strictInt(f[1]),
    rate: Number.isFinite(rate) ? rate : 0,
    emitted: numbers[0],
    dropQueue: numbers[1],
    dropMac: numbers[2],
    dropSize: numbers[3],
    truncated: numbers[4],
    dropUsbBusy: extended ? numbers[5] : 0,
    rssi: extended ? numbers[6] : numbers[5],
    freeHeap: extended ? numbers[7] : numbers[6]
  };
  for (const key of ["emitted", "dropQueue", "dropMac", "dropSize", "truncated"]) {
    if (!Number.isFinite(stat[key])) return null;
  }
  if (!Number.isFinite(stat.dropUsbBusy)) stat.dropUsbBusy = 0;
  return stat;
}

// INFO lines are firmware chatter. Two of them carry structure we care about:
//   INFO,node,<node_id>
//   INFO,link,<bssid>,<channel>
export function parseInfoLine(line) {
  const f = line.split(",");
  if (f.length >= 3 && f[1] === "node") return { kind: "node", nodeId: f[2].trim() };
  if (f.length >= 4 && f[1] === "link") {
    const channel = strictInt(f[3]);
    return { kind: "link", bssid: f[2].trim().toUpperCase(), channel: Number.isFinite(channel) ? channel : null };
  }
  if (f.length >= 3 && f[1] === "firmware") return { kind: "firmware", version: f[2].trim() };
  return { kind: "text", text: line };
}

export function classifyLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return { kind: "empty" };
  if (line.startsWith("CSI,")) return { kind: "csi", line };
  if (line.startsWith("STAT,")) return { kind: "stat", line };
  if (line.startsWith("INFO,")) return { kind: "info", line };
  return { kind: "unknown", line };
}

// ---------------------------------------------------------------------------
// LineAssembler
//
// USB chunks split wherever the OS feels like it: one read() can contain half a
// CSI line, three whole ones, or a line plus the start of the next. Only
// complete lines are emitted; the remainder waits for the next chunk.
//
// The overflow rule matters. A stream with no newlines at all (pure garbage, or
// a firmware wedged mid-line) must not grow memory without bound, so once the
// pending fragment passes the limit it is DROPPED ENTIRELY and counted. Keeping
// the tail instead would splice unrelated bytes onto the next real line and
// manufacture a malformed frame out of two good ones.
// ---------------------------------------------------------------------------
export class LineAssembler {
  constructor(limitBytes = 8192) {
    this.limitBytes = limitBytes;
    this.pending = "";
    this.decoder = new TextDecoder();
    this.overflows = 0;
  }

  feedText(text) {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() || "";
    if (this.pending.length > this.limitBytes) {
      this.pending = "";
      this.overflows += 1;
    }
    // \r\n and bare \n both end a line.
    return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  }

  feed(chunk) {
    return this.feedText(this.decoder.decode(chunk, { stream: true }));
  }

  reset() {
    this.pending = "";
    this.decoder = new TextDecoder();
  }
}

// ---------------------------------------------------------------------------
// Dataset format - JSONL (one JSON object per line)
//
// Why JSONL and not CSV:
//   * Line-oriented, so recording is append-only streaming and replay parses
//     one line at a time. Neither side ever needs the whole file in memory.
//   * Self-describing. A CSV of 256 CSI columns plus 12 metadata columns needs
//     an external header to mean anything; every JSONL line carries its names.
//   * Mixed record types (session header, csi, stat, event) live in one file
//     without a second schema.
//   * json.loads() per line in Python, JSON.parse() per line in JS. No parser
//     to write, no quoting rules to get wrong.
//   * Truncating the file (crash, unplug) loses at most the last line.
//
// The cost is size: 0.95-1.5 kB per frame versus ~0.8-1.3 kB for CSV. At 20 Hz
// that is about 19-29 kB/s of disk, which is not the constraint here.
//
// First line is ALWAYS the session header. schema_version lives there.
// ---------------------------------------------------------------------------

export const DATASET_FILE_EXTENSION = ".jsonl";

export function makeSessionHeader(options = {}) {
  return {
    type: "session",
    schema_version: SCHEMA_VERSION,
    source: SOURCE_WIFI_CSI,
    node_id: options.nodeId || DEFAULT_NODE_ID,
    link_id: options.linkId || DEFAULT_LINK_ID,
    started_at: options.startedAt || new Date().toISOString(),
    target_rate_hz: options.targetRateHz || DEFAULT_TARGET_RATE_HZ,
    app_version: options.appVersion || null,
    firmware: options.firmware || null,
    // Link identity, so a dataset can be matched to the radio path it came
    // from. BSSID is a hardware address, not a credential. SSID and password
    // are NEVER written to a dataset.
    bssid: options.bssid || null,
    channel: options.channel === undefined ? null : options.channel,
    label: options.label || null,
    note: options.note || null
  };
}

export function serialiseCsiRecord(frame) {
  // Array.from on an Int8Array gives plain numbers, which JSON.stringify emits
  // as a compact integer list. The raw bytes are stored verbatim - the dataset
  // is lossless with respect to what the radio reported.
  return JSON.stringify({
    type: "csi",
    node_id: frame.nodeId || DEFAULT_NODE_ID,
    link_id: frame.linkId || DEFAULT_LINK_ID,
    seq: frame.seq,
    t_host_ms: frame.tHostMs,
    t_esp_us: frame.tEspUs,
    rssi: frame.rssi,
    noise: frame.noise,
    channel: frame.channel,
    sig_mode: frame.sigMode,
    first_word_invalid: frame.fwi,
    len: frame.len,
    csi: Array.from(frame.csi)
  });
}

export function serialiseStatRecord(stat, tHostMs) {
  return JSON.stringify({
    type: "stat",
    t_host_ms: tHostMs,
    rate: stat.rate,
    emitted: stat.emitted,
    drop_queue: stat.dropQueue,
    drop_mac: stat.dropMac,
    drop_size: stat.dropSize,
    truncated: stat.truncated,
    drop_usb_busy: stat.dropUsbBusy,
    rssi: stat.rssi,
    free_heap: stat.freeHeap
  });
}

export function serialiseEventRecord(event, tHostMs, detail = null) {
  return JSON.stringify({ type: "event", t_host_ms: tHostMs, event, detail });
}

export const DATASET_ERROR = {
  JSON: "not_json",
  NO_TYPE: "missing_type",
  SCHEMA: "unsupported_schema_version",
  FIELD: "bad_field",
  CSI_LENGTH: "csi_length_mismatch",
  SAMPLE_RANGE: "sample_out_of_int8_range"
};

// One bad line in a dataset must cost exactly that line.
export function parseDatasetLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return { ok: false, reason: "empty", skip: true };

  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    return { ok: false, reason: DATASET_ERROR.JSON };
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: DATASET_ERROR.NO_TYPE };
  }
  if (typeof record.type !== "string") return { ok: false, reason: DATASET_ERROR.NO_TYPE };

  if (record.type === "session") {
    if (record.schema_version !== SCHEMA_VERSION) {
      return { ok: false, reason: DATASET_ERROR.SCHEMA, found: record.schema_version };
    }
    return { ok: true, kind: "session", header: record };
  }

  if (record.type === "csi") {
    if (!Array.isArray(record.csi)) return { ok: false, reason: DATASET_ERROR.FIELD };
    const len = record.len;
    if (!Number.isInteger(len) || len < 2 || len % 2 !== 0 || len > MAX_CSI_BYTES) {
      return { ok: false, reason: DATASET_ERROR.FIELD };
    }
    if (record.csi.length !== len) return { ok: false, reason: DATASET_ERROR.CSI_LENGTH };

    const numeric = [record.seq, record.t_host_ms, record.rssi, record.noise,
                     record.channel, record.sig_mode, record.first_word_invalid];
    if (!numeric.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { ok: false, reason: DATASET_ERROR.FIELD };
    }

    const csi = new Int8Array(len);
    for (let i = 0; i < len; i += 1) {
      const value = record.csi[i];
      if (!Number.isInteger(value) || value < -128 || value > 127) {
        return { ok: false, reason: DATASET_ERROR.SAMPLE_RANGE };
      }
      csi[i] = value;
    }

    return {
      ok: true,
      kind: "csi",
      frame: {
        source: SOURCE_WIFI_CSI,
        nodeId: typeof record.node_id === "string" ? record.node_id : DEFAULT_NODE_ID,
        linkId: typeof record.link_id === "string" ? record.link_id : DEFAULT_LINK_ID,
        seq: record.seq,
        tHostMs: record.t_host_ms,
        tEspUs: Number.isFinite(record.t_esp_us) ? record.t_esp_us : 0,
        rssi: record.rssi,
        noise: record.noise,
        channel: record.channel,
        sigMode: record.sig_mode,
        fwi: record.first_word_invalid,
        len,
        csi
      }
    };
  }

  if (record.type === "stat") return { ok: true, kind: "stat", record };
  if (record.type === "event") return { ok: true, kind: "event", record };
  return { ok: true, kind: "other", record };
}

// Parse a whole dataset text into something replayable. Errors are collected,
// never thrown: a dataset with three corrupt lines out of 2400 is still a
// perfectly good dataset.
export function readDataset(text) {
  const result = {
    header: null,
    frames: [],
    stats: [],
    events: [],
    errors: [],
    errorsByReason: {},
    lineCount: 0
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    result.lineCount += 1;
    const parsed = parseDatasetLine(raw);
    if (!parsed.ok) {
      result.errors.push({ line: i + 1, reason: parsed.reason });
      result.errorsByReason[parsed.reason] = (result.errorsByReason[parsed.reason] || 0) + 1;
      continue;
    }
    if (parsed.kind === "session") result.header = parsed.header;
    else if (parsed.kind === "csi") result.frames.push(parsed.frame);
    else if (parsed.kind === "stat") result.stats.push(parsed.record);
    else if (parsed.kind === "event") result.events.push(parsed.record);
  }
  // Recorded timestamps are the replay clock, so they must be non-decreasing.
  result.frames.sort((a, b) => a.tHostMs - b.tHostMs);
  result.durationMs = result.frames.length > 1
    ? result.frames[result.frames.length - 1].tHostMs - result.frames[0].tHostMs
    : 0;
  return result;
}

// ---------------------------------------------------------------------------
// Data quality
//
// This is TRANSPORT quality only: did the measurements arrive intact and on
// time. It says nothing whatsoever about whether anything moved. An empty,
// perfectly still room scores GOOD; a room full of people scores BAD if the
// USB cable is bad.
//
// Measured over a rolling window of recent frames:
//
//   gapRatio       = sequence gaps / (gaps + frames)
//   malformedRatio = malformed lines / (malformed + frames)
//   espDropRatio   = (queue drops + usb-busy drops + truncated writes)
//                    / (that + frames)
//   rateError      = |measured rate - target rate| / target rate
//   jitter         = stdev(frame interval) / mean(frame interval)
//
//   GOOD      every ratio < 0.5 %, rateError < 20 %, jitter < 0.35
//   BAD       any ratio > 5 %,    or rateError > 50 %, or jitter > 1.0
//   DEGRADED  anything in between
//   UNKNOWN   fewer than MIN_QUALITY_FRAMES frames in the window
// ---------------------------------------------------------------------------

export const QUALITY = {
  UNKNOWN: "UNKNOWN",
  GOOD: "GOOD",
  DEGRADED: "DEGRADED",
  BAD: "BAD"
};

export const QUALITY_WINDOW_MS = 10000;
export const MIN_QUALITY_FRAMES = 20;

const GOOD_LIMITS = { ratio: 0.005, rateError: 0.20, jitter: 0.35 };
const BAD_LIMITS = { ratio: 0.05, rateError: 0.50, jitter: 1.0 };

export function assessQuality(measures) {
  const { frames, gapRatio, malformedRatio, espDropRatio, rateError, jitter } = measures;
  if (frames < MIN_QUALITY_FRAMES) {
    return { level: QUALITY.UNKNOWN, reason: `only ${frames} frames in window` };
  }

  const checks = [
    { name: "sequence gaps", value: gapRatio, good: GOOD_LIMITS.ratio, bad: BAD_LIMITS.ratio, percent: true },
    { name: "malformed lines", value: malformedRatio, good: GOOD_LIMITS.ratio, bad: BAD_LIMITS.ratio, percent: true },
    { name: "firmware drops", value: espDropRatio, good: GOOD_LIMITS.ratio, bad: BAD_LIMITS.ratio, percent: true },
    { name: "frame rate error", value: rateError, good: GOOD_LIMITS.rateError, bad: BAD_LIMITS.rateError, percent: true },
    { name: "rate jitter", value: jitter, good: GOOD_LIMITS.jitter, bad: BAD_LIMITS.jitter, percent: false }
  ];

  let level = QUALITY.GOOD;
  let worst = null;
  let worstScore = 0;
  for (const check of checks) {
    if (!Number.isFinite(check.value)) continue;
    const score = check.value / check.bad;
    if (check.value > check.bad) {
      level = QUALITY.BAD;
    } else if (check.value > check.good && level !== QUALITY.BAD) {
      level = QUALITY.DEGRADED;
    }
    if (score > worstScore) { worstScore = score; worst = check; }
  }

  if (level === QUALITY.GOOD) return { level, reason: "transport clean" };
  const shown = worst.percent ? `${(worst.value * 100).toFixed(1)}%` : worst.value.toFixed(2);
  return { level, reason: `${worst.name} ${shown}` };
}

// ---------------------------------------------------------------------------
// CsiPipeline - the one place CSI frames are turned into numbers.
//
// LIVE and REPLAY both call ingestFrame() with the same canonical record, so
// there is exactly one implementation of the analysis and no chance of the two
// paths drifting apart.
// ---------------------------------------------------------------------------

export const BASELINE = {
  NONE: "none",
  CAPTURING: "capturing",
  READY: "ready",
  FAILED: "failed"
};

export const DEFAULT_BASELINE_MS = 3000;
export const DEFAULT_MIN_BASELINE_FRAMES = 20;

export class CsiPipeline {
  constructor(options = {}) {
    this.baselineMs = options.baselineMs || DEFAULT_BASELINE_MS;
    this.minBaselineFrames = options.minBaselineFrames || DEFAULT_MIN_BASELINE_FRAMES;
    this.targetRateHz = options.targetRateHz || DEFAULT_TARGET_RATE_HZ;
    this.windowMs = options.windowMs || QUALITY_WINDOW_MS;
    this.mode = options.mode || "live";
    this.reset("init");
  }

  // Full reset. Called on connect, on disconnect, on mode change and when a
  // new dataset is loaded, so no measurement can ever survive into a session
  // it does not belong to.
  reset(reason = "reset") {
    this.nodeId = DEFAULT_NODE_ID;
    this.linkId = DEFAULT_LINK_ID;

    this.rawVector = null;
    this.normVector = null;

    this.baseline = null;            // { raw, norm, frames, capturedAtMs, length }
    this.baselineState = BASELINE.NONE;
    this.baselineReason = "";
    this.capture = null;             // in-progress capture

    this.activity = null;

    this.meta = { rssi: null, noise: null, channel: null, sigMode: null, len: null, fwi: null, seq: null, tEspUs: null };
    this.link = { bssid: null, channel: null, csiLength: null };

    this.framesReceived = 0;
    this.framesProcessed = 0;
    this.malformedTotal = 0;
    this.malformedByReason = {};
    this.sequenceGaps = 0;
    this.duplicateFrames = 0;
    this.sequenceResets = 0;
    this.lastSeq = null;
    this.lastFrameTs = null;
    this.firstFrameTs = null;

    this.espStat = null;
    this.espStatPrevious = null;
    this.espStatResets = 0;

    this.clipping = { fraction: 0, near: 0, total: 0, potential: false };

    this.window = [];
    this.lastResetReason = reason;
    this.events = [];
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset(`mode changed to ${mode}`);
  }

  setTargetRate(hz) {
    this.targetRateHz = hz;
  }

  setIdentity(nodeId, linkId) {
    if (nodeId) this.nodeId = nodeId;
    if (linkId) this.linkId = linkId;
  }

  note(event, detail = null) {
    this.events.push({ event, detail, at: this.lastFrameTs });
    if (this.events.length > 50) this.events.shift();
  }

  // ---- window bookkeeping -------------------------------------------------

  pushWindow(entry) {
    this.window.push(entry);
    const cutoff = entry.ts - this.windowMs;
    while (this.window.length > 0 && this.window[0].ts < cutoff) this.window.shift();
    // Hard cap so a dataset with nonsense timestamps cannot grow this forever.
    while (this.window.length > 4000) this.window.shift();
  }

  // ---- input --------------------------------------------------------------

  noteMalformed(reason, tHostMs) {
    this.malformedTotal += 1;
    this.malformedByReason[reason] = (this.malformedByReason[reason] || 0) + 1;
    const ts = Number.isFinite(tHostMs) ? tHostMs : (this.lastFrameTs || 0);
    this.pushWindow({ ts, frames: 0, gaps: 0, malformed: 1, espDrops: 0 });
  }

  // A link whose BSSID, channel or CSI vector length changed is a different
  // radio path. A baseline measured on the old one describes a room that no
  // longer exists, so it is thrown away and the user is told why.
  invalidateBaseline(reason) {
    if (this.baselineState === BASELINE.NONE) return;
    this.baseline = null;
    this.capture = null;
    this.activity = null;
    this.baselineState = BASELINE.FAILED;
    this.baselineReason = reason;
    this.note("baseline_invalidated", reason);
  }

  noteLink(info) {
    const bssid = info.bssid === undefined ? this.link.bssid : info.bssid;
    const channel = info.channel === undefined ? this.link.channel : info.channel;
    const changed = (this.link.bssid !== null && bssid !== this.link.bssid) ||
                    (this.link.channel !== null && channel !== this.link.channel);
    this.link.bssid = bssid;
    this.link.channel = channel;
    if (changed) {
      this.invalidateBaseline("the radio link changed (BSSID or channel)");
      this.lastSeq = null;
      this.note("link_change", { bssid, channel });
    }
  }

  ingestStat(stat) {
    if (this.espStat) {
      // Counters only ever climb. Going backwards means the board rebooted,
      // which is a new physical session: the old baseline no longer describes
      // the same receiver state.
      if (stat.emitted < this.espStat.emitted) {
        this.espStatResets += 1;
        this.invalidateBaseline("the ESP32 restarted");
        this.lastSeq = null;
        this.note("firmware_restart");
        this.espStatPrevious = null;
      } else {
        this.espStatPrevious = this.espStat;
      }
    }
    if (this.espStatPrevious) {
      const drops =
        Math.max(0, stat.dropQueue - this.espStatPrevious.dropQueue) +
        Math.max(0, stat.truncated - this.espStatPrevious.truncated) +
        Math.max(0, stat.dropUsbBusy - this.espStatPrevious.dropUsbBusy);
      if (drops > 0) {
        this.pushWindow({ ts: this.lastFrameTs || 0, frames: 0, gaps: 0, malformed: 0, espDrops: drops });
      }
    }
    this.espStat = stat;
  }

  // The single entry point for a CSI frame, whatever its origin.
  ingestFrame(frame) {
    this.framesReceived += 1;

    const raw = rawMagnitudes(frame.csi);
    // Analyse the LLTF block: it is present in every packet type, so the vector
    // keeps the same meaning whether the AP replied with 11g or 11n.
    const block = raw.length >= SUBCARRIERS_PER_BLOCK ? raw.slice(0, SUBCARRIERS_PER_BLOCK) : raw;
    const norm = normalise(block);
    if (norm === null) {
      this.noteMalformed(MALFORMED.NO_ENERGY, frame.tHostMs);
      return { accepted: false, reason: MALFORMED.NO_ENERGY };
    }

    let gaps = 0;
    if (this.lastSeq !== null) {
      if (frame.seq === this.lastSeq) {
        this.duplicateFrames += 1;
        return { accepted: false, reason: "duplicate" };
      }
      if (frame.seq < this.lastSeq) {
        // The firmware's sequence counter restarts at 1 on boot.
        this.sequenceResets += 1;
        this.invalidateBaseline("the CSI sequence restarted (new firmware session)");
        this.note("sequence_reset", { from: this.lastSeq, to: frame.seq });
      } else {
        gaps = frame.seq - this.lastSeq - 1;
        this.sequenceGaps += gaps;
      }
    }
    this.lastSeq = frame.seq;

    // A different CSI vector length is a different measurement shape.
    if (this.link.csiLength !== null && this.link.csiLength !== frame.len) {
      this.invalidateBaseline(`the CSI length changed (${this.link.csiLength} to ${frame.len} bytes)`);
    }
    this.link.csiLength = frame.len;
    if (this.link.channel !== null && frame.channel !== this.link.channel) {
      this.noteLink({ channel: frame.channel });
    } else if (this.link.channel === null) {
      this.link.channel = frame.channel;
    }

    this.rawVector = block;
    this.normVector = norm;
    this.meta = {
      rssi: frame.rssi, noise: frame.noise, channel: frame.channel,
      sigMode: frame.sigMode, len: frame.len, fwi: frame.fwi,
      seq: frame.seq, tEspUs: frame.tEspUs
    };
    if (frame.nodeId) this.nodeId = frame.nodeId;
    if (frame.linkId) this.linkId = frame.linkId;

    this.framesProcessed += 1;
    if (this.firstFrameTs === null) this.firstFrameTs = frame.tHostMs;
    this.lastFrameTs = frame.tHostMs;
    this.pushWindow({ ts: frame.tHostMs, frames: 1, gaps, malformed: 0, espDrops: 0, clip: clippingOfFrame(frame.csi) });

    this.updateClipping();
    this.updateBaseline(frame, norm, block);
    this.updateActivity();

    return { accepted: true };
  }

  // ---- baseline -----------------------------------------------------------

  // Arming rather than starting: the capture window begins at the timestamp of
  // the NEXT frame, so it is anchored to the data and not to the wall clock.
  // That is what makes a replayed capture reproduce a live one exactly.
  armBaseline() {
    this.baseline = null;
    this.activity = null;
    this.baselineState = BASELINE.CAPTURING;
    this.baselineReason = "";
    this.capture = { startTs: null, frames: 0, accRaw: null, accNorm: null, length: null };
    this.note("baseline_armed");
  }

  clearBaseline() {
    this.baseline = null;
    this.capture = null;
    this.activity = null;
    this.baselineState = BASELINE.NONE;
    this.baselineReason = "";
  }

  abortBaseline(reason) {
    if (this.baselineState !== BASELINE.CAPTURING) return;
    this.capture = null;
    this.baseline = null;
    this.baselineState = BASELINE.FAILED;
    this.baselineReason = reason;
    this.note("baseline_failed", reason);
  }

  updateBaseline(frame, norm, raw) {
    const capture = this.capture;
    if (this.baselineState !== BASELINE.CAPTURING || capture === null) return;

    if (capture.startTs === null) {
      capture.startTs = frame.tHostMs;
      capture.length = norm.length;
      capture.accNorm = new Float64Array(norm.length);
      capture.accRaw = new Float64Array(raw.length);
    }

    // A vector that changed shape mid-capture cannot be averaged with what came
    // before. Fail loudly rather than average two different measurements.
    if (capture.length !== norm.length) {
      this.abortBaseline("the CSI vector length changed during capture");
      return;
    }

    for (let i = 0; i < norm.length; i += 1) {
      capture.accNorm[i] += norm[i];
      capture.accRaw[i] += raw[i];
    }
    capture.frames += 1;

    if (frame.tHostMs - capture.startTs >= this.baselineMs) this.finishBaseline();
  }

  // Calibration NEVER finishes silently on bad data: either there were enough
  // frames and the baseline is usable, or it is reported as failed.
  finishBaseline() {
    const capture = this.capture;
    if (capture === null) return;
    if (capture.frames < this.minBaselineFrames) {
      this.abortBaseline(`only ${capture.frames} frames arrived, ${this.minBaselineFrames} needed`);
      return;
    }
    const norm = new Float64Array(capture.length);
    const raw = new Float64Array(capture.length);
    for (let i = 0; i < capture.length; i += 1) {
      norm[i] = capture.accNorm[i] / capture.frames;
      raw[i] = capture.accRaw[i] / capture.frames;
    }
    this.baseline = {
      norm, raw,
      frames: capture.frames,
      length: capture.length,
      capturedAtMs: this.lastFrameTs,
      spanMs: this.lastFrameTs - capture.startTs
    };
    this.capture = null;
    this.baselineState = BASELINE.READY;
    this.baselineReason = "";
    this.note("baseline_ready", { frames: this.baseline.frames });
  }

  // Watchdog on WALL time, not frame time. This is the one place wall time is
  // allowed, because "the input stopped" cannot be detected from data that
  // never arrived. inputActive is false when replay is paused or the serial
  // link is down - a paused capture is aborted rather than left hanging.
  tickWatchdog(wallNowMs, lastInputWallMs, inputActive) {
    if (this.baselineState !== BASELINE.CAPTURING) return;
    if (!inputActive) {
      this.abortBaseline("the input stopped during capture");
      return;
    }
    if (lastInputWallMs && wallNowMs - lastInputWallMs > this.baselineMs + 2000) {
      this.abortBaseline("frames stopped arriving during capture");
    }
  }

  // ---- derived numbers ----------------------------------------------------

  // EXPERIMENTAL "CSI Activity / Channel Change".
  //
  //   activity = (1 / |A|) * SUM over p in A of | n(p) - b(p) |
  //
  // where A is the analysed sub-carrier set (positions >= 2 with |index| in
  // 1..26), n is the current frame's normalised magnitude vector and b is the
  // baseline's. Always computed in the NORMALISED domain so the number stays
  // comparable regardless of which magnitude view is on screen.
  //
  // It is a descriptive statistic for comparing datasets. It is NOT a detector,
  // not a presence signal and not a person.
  updateActivity() {
    if (this.baseline === null || this.normVector === null) { this.activity = null; return; }
    this.activity = meanAbsoluteDifference(this.normVector, this.baseline.norm);
  }

  updateClipping() {
    let near = 0;
    let total = 0;
    for (const entry of this.window) {
      if (!entry.clip) continue;
      near += entry.clip.near;
      total += entry.clip.total;
    }
    const fraction = total > 0 ? near / total : 0;
    this.clipping = { near, total, fraction, potential: fraction > CLIP_WARN_FRACTION };
  }

  windowMeasures() {
    let frames = 0, gaps = 0, malformed = 0, espDrops = 0;
    const timestamps = [];
    for (const entry of this.window) {
      frames += entry.frames;
      gaps += entry.gaps;
      malformed += entry.malformed;
      espDrops += entry.espDrops;
      if (entry.frames > 0) timestamps.push(entry.ts);
    }

    let rate = 0;
    let jitter = 0;
    if (timestamps.length >= 2) {
      const span = timestamps[timestamps.length - 1] - timestamps[0];
      rate = span > 0 ? ((timestamps.length - 1) * 1000) / span : 0;
      const intervals = [];
      for (let i = 1; i < timestamps.length; i += 1) intervals.push(timestamps[i] - timestamps[i - 1]);
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (mean > 0) {
        const variance = intervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / intervals.length;
        jitter = Math.sqrt(variance) / mean;
      }
    }

    const denominatorGaps = gaps + frames;
    const denominatorBad = malformed + frames;
    const denominatorDrops = espDrops + frames;
    return {
      frames, gaps, malformed, espDrops, rate, jitter,
      gapRatio: denominatorGaps > 0 ? gaps / denominatorGaps : 0,
      malformedRatio: denominatorBad > 0 ? malformed / denominatorBad : 0,
      espDropRatio: denominatorDrops > 0 ? espDrops / denominatorDrops : 0,
      rateError: this.targetRateHz > 0 ? Math.abs(rate - this.targetRateHz) / this.targetRateHz : 0
    };
  }

  quality() {
    return assessQuality(this.windowMeasures());
  }

  // Mean rate across the whole session, from the frames' own timestamps.
  meanRate() {
    if (this.framesProcessed < 2 || this.firstFrameTs === null) return 0;
    const span = this.lastFrameTs - this.firstFrameTs;
    return span > 0 ? ((this.framesProcessed - 1) * 1000) / span : 0;
  }

  // Frames the firmware numbered but the host never processed.
  estimatedDropped() {
    return this.sequenceGaps;
  }

  snapshot() {
    const measures = this.windowMeasures();
    return {
      mode: this.mode,
      nodeId: this.nodeId,
      linkId: this.linkId,
      source: SOURCE_WIFI_CSI,
      raw: this.rawVector,
      normalised: this.normVector,
      baselineRaw: this.baseline ? this.baseline.raw : null,
      baselineNorm: this.baseline ? this.baseline.norm : null,
      baselineState: this.baselineState,
      baselineReason: this.baselineReason,
      baselineFrames: this.baseline ? this.baseline.frames : (this.capture ? this.capture.frames : 0),
      captureStartTs: this.capture ? this.capture.startTs : null,
      activity: this.activity,
      meta: this.meta,
      link: this.link,
      clipping: this.clipping,
      espStat: this.espStat,
      espStatResets: this.espStatResets,
      counters: {
        framesReceived: this.framesReceived,
        framesProcessed: this.framesProcessed,
        malformed: this.malformedTotal,
        malformedByReason: this.malformedByReason,
        sequenceGaps: this.sequenceGaps,
        duplicates: this.duplicateFrames,
        sequenceResets: this.sequenceResets,
        estimatedDropped: this.estimatedDropped()
      },
      rate: measures.rate,
      meanRate: this.meanRate(),
      measures,
      quality: assessQuality(measures),
      lastFrameTs: this.lastFrameTs
    };
  }
}

// ---------------------------------------------------------------------------
// TransportReader - serial bytes in, classified records out.
//
// Used by the LIVE path. Replay skips it (a dataset is already parsed), but
// both end up calling the same CsiPipeline.ingestFrame().
// ---------------------------------------------------------------------------
export class TransportReader {
  constructor(handlers = {}, options = {}) {
    this.assembler = new LineAssembler(options.lineLimitBytes || 8192);
    this.handlers = handlers;
    this.bytes = 0;
    this.lines = 0;
    this.unknownLines = 0;
    this.infoLines = 0;
    this.lastLine = "";
  }

  // tHostMs is supplied by the caller so that the recorded timestamp and the
  // timestamp the pipeline sees are the same number, to the digit.
  feedLines(lines, tHostMs) {
    for (const line of lines) {
      this.lines += 1;
      const trimmed = line.trim();
      if (trimmed) this.lastLine = trimmed;
      const classified = classifyLine(line);

      if (classified.kind === "csi") {
        const parsed = parseCsiLine(classified.line);
        if (!parsed.ok) {
          if (this.handlers.onMalformed) this.handlers.onMalformed(parsed.reason, tHostMs, classified.line);
          continue;
        }
        parsed.frame.tHostMs = tHostMs;
        if (this.handlers.onFrame) this.handlers.onFrame(parsed.frame);
        continue;
      }

      if (classified.kind === "stat") {
        const stat = parseStatLine(classified.line);
        if (stat === null) {
          if (this.handlers.onMalformed) this.handlers.onMalformed("bad_stat_line", tHostMs, classified.line);
          continue;
        }
        if (this.handlers.onStat) this.handlers.onStat(stat, tHostMs);
        continue;
      }

      if (classified.kind === "info") {
        this.infoLines += 1;
        if (this.handlers.onInfo) this.handlers.onInfo(parseInfoLine(classified.line), tHostMs);
        continue;
      }

      if (classified.kind === "unknown") {
        // Boot messages, ESP-IDF log spam, line noise. Counted, then ignored:
        // garbage in the stream must never stop the next good frame.
        this.unknownLines += 1;
        if (this.handlers.onUnknown) this.handlers.onUnknown(classified.line);
      }
    }
  }

  feedText(text, tHostMs) {
    this.feedLines(this.assembler.feedText(text), tHostMs);
  }

  feed(chunk, tHostMs) {
    this.bytes += chunk.byteLength;
    this.feedLines(this.assembler.feed(chunk), tHostMs);
  }

  reset() {
    this.assembler.reset();
  }
}

// ---------------------------------------------------------------------------
// Recording
//
// Two sinks, one interface.
//
//   FileRecordingSink   streams straight to a file the user picked, through the
//                       File System Access API. Nothing accumulates in the tab,
//                       so length is limited by disk, not by RAM. Chrome and
//                       Edge have this - which are exactly the browsers Web
//                       Serial needs, so the live path always has it available.
//
//   MemoryRecordingSink fallback. Holds the dataset in ~1 MB string chunks and
//                       STOPS at a hard limit rather than growing until the tab
//                       dies. The limit is reported, and the partial dataset is
//                       still downloadable.
//
// Chunking matters: appending to one big string would copy the whole dataset on
// every frame (quadratic). Joining ~1 MB blocks keeps it linear and keeps each
// allocation small enough for the GC to handle comfortably.
// ---------------------------------------------------------------------------

export const MEMORY_RECORDING_LIMIT_BYTES = 24 * 1024 * 1024; // 14-21 min at 20 Hz
export const RECORDING_CHUNK_BYTES = 1024 * 1024;

export class MemoryRecordingSink {
  constructor(limitBytes = MEMORY_RECORDING_LIMIT_BYTES) {
    this.limitBytes = limitBytes;
    this.chunks = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.bytesWritten = 0;
    this.full = false;
  }

  get kind() { return "memory"; }

  write(text) {
    if (this.full) return false;
    if (this.bytesWritten + text.length > this.limitBytes) {
      this.full = true;
      return false;
    }
    this.pending.push(text);
    this.pendingBytes += text.length;
    this.bytesWritten += text.length;
    if (this.pendingBytes >= RECORDING_CHUNK_BYTES) this.flushPending();
    return true;
  }

  flushPending() {
    if (this.pending.length === 0) return;
    this.chunks.push(this.pending.join(""));
    this.pending.length = 0;
    this.pendingBytes = 0;
  }

  async close() {
    this.flushPending();
    return { bytes: this.bytesWritten, chunks: this.chunks.length };
  }

  text() {
    this.flushPending();
    return this.chunks.join("");
  }
}

// Serialises writes onto the file handle and refuses to let an unresponsive
// disk turn into unbounded queued memory.
export class FileRecordingSink {
  constructor(writable, maxQueuedBytes = 4 * 1024 * 1024) {
    this.writable = writable;
    this.maxQueuedBytes = maxQueuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
    this.bytesWritten = 0;
    this.droppedBytes = 0;
    this.draining = false;
    this.drainPromise = null;
    this.full = false;
    this.error = null;
  }

  get kind() { return "file"; }

  write(text) {
    if (this.error) return false;
    if (this.queuedBytes + text.length > this.maxQueuedBytes) {
      this.droppedBytes += text.length;
      this.full = true;
      return false;
    }
    this.full = false;
    this.queue.push(text);
    this.queuedBytes += text.length;
    this.drain();
    return true;
  }

  // Returns the IN-FLIGHT drain when one is already running. Returning early
  // instead would make close() spin on a microtask loop that never lets the
  // pending write() settle, which hangs the tab rather than finishing the file.
  drain() {
    if (this.draining) return this.drainPromise;
    this.draining = true;
    this.drainPromise = this.pump().finally(() => { this.draining = false; });
    return this.drainPromise;
  }

  async pump() {
    try {
      while (this.queue.length > 0) {
        const block = this.queue.join("");
        this.queue.length = 0;
        const bytes = this.queuedBytes;
        this.queuedBytes = 0;
        await this.writable.write(block);
        this.bytesWritten += bytes;
      }
    } catch (error) {
      this.error = error;
    }
  }

  async close() {
    while (this.draining || this.queue.length > 0) {
      await this.drain();
    }
    try { await this.writable.close(); } catch (error) { this.error = this.error || error; }
    return { bytes: this.bytesWritten, dropped: this.droppedBytes, error: this.error };
  }
}

export class DatasetRecorder {
  constructor(sink, header) {
    this.sink = sink;
    this.header = header;
    this.frames = 0;
    this.stats = 0;
    this.events = 0;
    this.refused = 0;
    this.startedAtMs = null;
    this.lastFrameMs = null;
    this.sink.write(JSON.stringify(header) + "\n");
  }

  get bytesWritten() { return this.sink.bytesWritten; }
  get limitReached() { return Boolean(this.sink.full); }

  writeFrame(frame) {
    if (!this.sink.write(serialiseCsiRecord(frame) + "\n")) { this.refused += 1; return false; }
    this.frames += 1;
    if (this.startedAtMs === null) this.startedAtMs = frame.tHostMs;
    this.lastFrameMs = frame.tHostMs;
    return true;
  }

  writeStat(stat, tHostMs) {
    if (!this.sink.write(serialiseStatRecord(stat, tHostMs) + "\n")) { this.refused += 1; return false; }
    this.stats += 1;
    return true;
  }

  writeEvent(event, tHostMs, detail) {
    if (!this.sink.write(serialiseEventRecord(event, tHostMs, detail) + "\n")) { this.refused += 1; return false; }
    this.events += 1;
    return true;
  }

  durationMs() {
    if (this.startedAtMs === null || this.lastFrameMs === null) return 0;
    return this.lastFrameMs - this.startedAtMs;
  }

  close() { return this.sink.close(); }
}

// ---------------------------------------------------------------------------
// ReplayPlayer
//
// Advances a virtual dataset clock and emits every frame whose RECORDED
// timestamp has come due. Nothing assumes a fixed 50 ms spacing: a dataset with
// a 4-second hole replays with a 4-second hole, and rate jitter is reproduced
// exactly as captured. That is the point - the replay has to be the same
// experiment, not a tidied-up version of it.
// ---------------------------------------------------------------------------

export const PLAYBACK_RATES = [0.25, 0.5, 1, 2, 4];
const MAX_FRAMES_PER_TICK = 400;

export class ReplayPlayer {
  constructor(frames, handlers = {}) {
    this.frames = frames || [];
    this.handlers = handlers;
    this.rate = 1;
    this.playing = false;
    this.index = 0;
    this.virtualMs = 0;
    this.originMs = this.frames.length > 0 ? this.frames[0].tHostMs : 0;
  }

  get count() { return this.frames.length; }
  get finished() { return this.index >= this.frames.length; }
  get durationMs() {
    if (this.frames.length < 2) return 0;
    return this.frames[this.frames.length - 1].tHostMs - this.originMs;
  }

  setRate(rate) {
    if (PLAYBACK_RATES.includes(rate)) this.rate = rate;
  }

  play() {
    if (this.finished) this.restart();
    this.playing = true;
  }

  pause() { this.playing = false; }

  restart() {
    this.playing = false;
    this.index = 0;
    this.virtualMs = 0;
    if (this.handlers.onRestart) this.handlers.onRestart();
  }

  // One frame, ignoring the clock. Useful for looking at a single event.
  step() {
    this.playing = false;
    if (this.finished) return false;
    const frame = this.frames[this.index];
    this.index += 1;
    this.virtualMs = frame.tHostMs - this.originMs;
    if (this.handlers.onFrame) this.handlers.onFrame(frame);
    if (this.finished && this.handlers.onEnd) this.handlers.onEnd();
    return true;
  }

  // wallDeltaMs is real elapsed time; the virtual clock moves rate x faster.
  advance(wallDeltaMs) {
    if (!this.playing || this.finished) return 0;
    // A tab that was backgrounded can hand us a huge delta. Clamping keeps the
    // replay from dumping a thousand frames into one animation frame.
    const delta = Math.max(0, Math.min(wallDeltaMs, 1000));
    this.virtualMs += delta * this.rate;

    let emitted = 0;
    while (this.index < this.frames.length && emitted < MAX_FRAMES_PER_TICK) {
      const frame = this.frames[this.index];
      if (frame.tHostMs - this.originMs > this.virtualMs) break;
      this.index += 1;
      emitted += 1;
      if (this.handlers.onFrame) this.handlers.onFrame(frame);
    }
    if (this.finished) {
      this.playing = false;
      if (this.handlers.onEnd) this.handlers.onEnd();
    }
    return emitted;
  }

  progress() {
    return {
      index: this.index,
      count: this.frames.length,
      virtualMs: Math.min(this.virtualMs, this.durationMs),
      durationMs: this.durationMs,
      playing: this.playing,
      rate: this.rate,
      finished: this.finished
    };
  }
}


export const APP_VERSION = "csi-0.1.1-record-replay";
