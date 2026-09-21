// ---------------------------------------------------------------------------
// Deterministic synthetic CSI fixtures.
//
// READ THIS FIRST: these frames are made up. They exist to prove that the
// SOFTWARE behaves - that the parser recovers, that replay matches live, that
// normalisation cancels gain. Their numerical response says NOTHING about how
// well CSI senses a real person in a real room. No sensing performance claim
// may ever be based on a number produced from this file.
// ---------------------------------------------------------------------------
import { subcarrierIndex, isAnalysed } from "../dashboard/csi-core.js";

// Small, fast, fully deterministic PRNG so every test run sees identical data.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLOCK = 64;

// A fixed, smooth "room": one amplitude per sub-carrier, guard bands at zero.
export function baseAmplitudes(scale = 1) {
  const amplitudes = new Float64Array(BLOCK);
  for (let position = 0; position < BLOCK; position += 1) {
    if (!isAnalysed(position)) { amplitudes[position] = 0; continue; }
    const index = subcarrierIndex(position);
    amplitudes[position] = scale * (34 + 12 * Math.sin(index * 0.35) + 5 * Math.cos(index * 0.9));
  }
  return amplitudes;
}

function clampInt8(value) {
  const rounded = Math.round(value);
  if (rounded > 127) return 127;
  if (rounded < -128) return -128;
  return rounded;
}

// Amplitudes -> the 256-byte HT20 layout: an LLTF block of 64 sub-carriers
// followed by an HT-LTF block, each sub-carrier two signed bytes (imag, real).
export function bytesFromAmplitudes(amplitudes, phaseSeed = 0.7) {
  const bytes = new Int8Array(BLOCK * 2 * 2);
  for (let position = 0; position < BLOCK; position += 1) {
    const phase = phaseSeed + position * 0.61;
    const imag = clampInt8(amplitudes[position] * Math.sin(phase));
    const real = clampInt8(amplitudes[position] * Math.cos(phase));
    bytes[2 * position] = imag;
    bytes[2 * position + 1] = real;
    // Second block: a deterministic variant, never analysed by the pipeline but
    // present so frames have the real 256-byte shape.
    bytes[BLOCK * 2 + 2 * position] = clampInt8(imag * 0.9);
    bytes[BLOCK * 2 + 2 * position + 1] = clampInt8(real * 0.9);
  }
  return bytes;
}

export function csiLine(frame) {
  const head = ["CSI", frame.seq, frame.rssi ?? -54, frame.noise ?? -92, frame.channel ?? 6,
                frame.sigMode ?? 1, frame.tEspUs ?? frame.seq * 50000, frame.fwi ?? 0, frame.csi.length];
  return head.join(",") + "," + Array.from(frame.csi).join(",");
}

// --- scenarios -------------------------------------------------------------
//
// Every scenario returns { name, description, frames } where a frame is the
// canonical record shape the pipeline consumes (tHostMs included).

function buildFrames(count, { intervalMs = 50, amplitudesFor, seqFor, phaseFor, jitter = null }) {
  const frames = [];
  let tHostMs = 0;
  for (let i = 0; i < count; i += 1) {
    const amplitudes = amplitudesFor(i);
    const csi = bytesFromAmplitudes(amplitudes, phaseFor ? phaseFor(i) : 0.7);
    frames.push({
      source: "wifi_csi",
      nodeId: "esp01",
      linkId: "esp01-ap",
      seq: seqFor ? seqFor(i) : i + 1,
      tHostMs: Math.round(tHostMs * 10) / 10,
      tEspUs: Math.round(tHostMs * 1000),
      rssi: -54,
      noise: -92,
      channel: 6,
      sigMode: 1,
      fwi: 0,
      len: csi.length,
      csi
    });
    const step = jitter ? intervalMs * (0.6 + 0.8 * jitter(i)) : intervalMs;
    tHostMs += step;
  }
  return frames;
}

// A perfectly still channel: identical every frame.
export function stableChannel(count = 120) {
  const amplitudes = baseAmplitudes();
  return {
    name: "stable_channel",
    description: "identical frames, nothing moving",
    frames: buildFrames(count, { amplitudesFor: () => amplitudes })
  };
}

// A small wobble on every sub-carrier.
export function subtleChange(count = 120, depth = 0.02) {
  const base = baseAmplitudes();
  return {
    name: "subtle_change",
    description: "a few per cent of per-sub-carrier wobble",
    frames: buildFrames(count, {
      amplitudesFor: (i) => {
        const out = new Float64Array(base.length);
        for (let p = 0; p < base.length; p += 1) {
          out[p] = base[p] * (1 + depth * Math.sin(i * 0.4 + p * 0.7));
        }
        return out;
      }
    })
  };
}

// A big reshaping of the channel, as a large reflector moving would produce.
export function largeChange(count = 120) {
  const base = baseAmplitudes();
  return {
    name: "large_change",
    description: "strong per-sub-carrier reshaping",
    frames: buildFrames(count, {
      amplitudesFor: (i) => {
        const out = new Float64Array(base.length);
        for (let p = 0; p < base.length; p += 1) {
          out[p] = base[p] * (1 + 0.55 * Math.sin(i * 0.5 + p * 1.3));
        }
        return out;
      }
    })
  };
}

// The AGC case: the whole frame scaled by one common factor. Normalisation must
// make this indistinguishable from the stable channel.
export function commonGainScaling(count = 120) {
  const base = baseAmplitudes();
  return {
    name: "common_gain_scaling",
    description: "every sub-carrier multiplied by the same drifting factor",
    frames: buildFrames(count, {
      amplitudesFor: (i) => baseAmplitudes(1 + 0.4 * Math.sin(i * 0.3)),
      phaseFor: () => 0.7
    }),
    base
  };
}

// Exactly one sub-carrier moves.
export function singleSubcarrierChange(count = 120, position = 20, factor = 1.8) {
  const base = baseAmplitudes();
  return {
    name: "single_subcarrier_change",
    description: `sub-carrier at position ${position} changes, all others still`,
    position,
    frames: buildFrames(count, {
      amplitudesFor: (i) => {
        const out = Float64Array.from(base);
        if (i >= count / 2) out[position] = base[position] * factor;
        return out;
      }
    })
  };
}

// Many sub-carriers move together.
export function broadChange(count = 120, factor = 1.35) {
  const base = baseAmplitudes();
  return {
    name: "broad_change",
    description: "half the usable sub-carriers change at once",
    frames: buildFrames(count, {
      amplitudesFor: (i) => {
        const out = Float64Array.from(base);
        if (i >= count / 2) {
          for (let p = 2; p < 27; p += 1) out[p] = base[p] * factor;
        }
        return out;
      }
    })
  };
}

// Sequence numbers with holes in them.
export function sequenceGaps(count = 60) {
  const amplitudes = baseAmplitudes();
  const skips = new Set([10, 11, 12, 30, 45]);
  let seq = 0;
  const seqFor = () => { seq += 1; while (skips.has(seq)) seq += 1; return seq; };
  return {
    name: "sequence_gaps",
    description: "5 sequence numbers missing",
    expectedGaps: 5,
    frames: buildFrames(count, { amplitudesFor: () => amplitudes, seqFor })
  };
}

// Timestamps that are anything but a regular 50 ms grid.
export function variableTimestamps(count = 80) {
  const amplitudes = baseAmplitudes();
  const random = mulberry32(12345);
  const frames = buildFrames(count, { amplitudesFor: () => amplitudes, intervalMs: 50, jitter: () => random() });
  // One long stall in the middle, the sort a Wi-Fi retry storm produces.
  for (let i = 40; i < frames.length; i += 1) frames[i].tHostMs = Math.round((frames[i].tHostMs + 1800) * 10) / 10;
  return { name: "variable_timestamps", description: "jittered intervals plus one 1.8 s stall", frames };
}

export function rateJitter(count = 120) {
  const amplitudes = baseAmplitudes();
  const random = mulberry32(999);
  return {
    name: "rate_jitter",
    description: "interval varies 30-70 ms",
    frames: buildFrames(count, { amplitudesFor: () => amplitudes, intervalMs: 50, jitter: () => random() })
  };
}

// Samples pushed into the int8 rails.
export function clippedChannel(count = 60) {
  return {
    name: "clipping",
    description: "amplitudes driven past the int8 range",
    frames: buildFrames(count, { amplitudesFor: () => baseAmplitudes(6) })
  };
}

export function framesToLines(frames) {
  return frames.map(csiLine);
}

// A serial transcript with every kind of rubbish the link can produce mixed in.
export function messyTranscript() {
  const good = stableChannel(12).frames;
  const lines = [];
  lines.push("INFO,Wi-Fi CSI Explorer v0.1");
  lines.push("INFO,node,esp01");
  lines.push(csiLine(good[0]));
  lines.push("ets Jun  8 2016 00:22:57");                       // boot garbage
  lines.push(csiLine(good[1]));
  lines.push("CSI,3,-54,-92,6,1,150000,0,256,1,2,3");           // declared 256, sent 3
  lines.push("CSI,4,-54,-92,6,1,x,0,4,1,2,3,4");                // bad numeric field
  lines.push("CSI,5,-54,-92,6,1,250000,0,5,1,2,3,4,5");         // odd length
  lines.push("CSI,6,-54,-92,6,1,300000,0,4096," + new Array(4096).fill(1).join(",")); // oversized
  lines.push("CSI,7");                                          // far too short
  lines.push("STAT,1000,20.0,120,0,3,0,0,0,-54,210000");
  lines.push(csiLine(good[2]));
  lines.push("CSI,9,-54,-92,6,1,400000,0,4,1,2,3,900");         // sample outside int8
  lines.push("INFO,link,AA:BB:CC:DD:EE:FF,6");
  lines.push(csiLine(good[3]));
  lines.push("\u0000\u0001garbage\u0002");
  lines.push(csiLine(good[4]));
  return { lines, goodFrames: 5, description: "boot noise, truncation, bad fields, oversize, STAT and INFO interleaved" };
}

export const ALL_SCENARIOS = [
  stableChannel, subtleChange, largeChange, commonGainScaling,
  singleSubcarrierChange, broadChange, sequenceGaps, variableTimestamps,
  rateJitter, clippedChannel
];
