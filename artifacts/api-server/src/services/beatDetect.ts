/**
 * Beat Detection Service (T106) — extracts beat-like onsets from a music track
 * for synchronized background brightness pulses.
 *
 * Approach (rationale):
 *   - True onset detection (e.g. spectral flux, librosa) requires DSP libraries
 *     we don't have in this Node-only environment. Instead we use FFmpeg's
 *     built-in `astats` filter to report per-window RMS in dB, then run a
 *     simple peak-picker in JS: a window is a "beat" if its RMS exceeds an
 *     adaptive threshold (median + offset) AND it's a local maximum AND it's
 *     at least `minGapSec` after the previous beat.
 *   - This catches the dominant bass/kick energy of most music genres without
 *     needing per-track tuning. It will NOT distinguish a kick from a snare,
 *     but for a +5% background brightness pulse that's irrelevant — what we
 *     want is a stable rhythmic flicker on strong rhythmic accents.
 *
 * Spec compliance:
 *   - We only READ the music file via ffmpeg-static (-f null). We never log
 *     full file paths or upstream errors verbatim — only short summaries.
 *   - Output never exceeds `maxBeats` to keep the downstream `enable=`
 *     expression bounded in length.
 *
 * NOTE for downstream consumers: the returned timestamps are seconds from the
 * START OF THE MUSIC FILE. Because the production music input is added with
 * `-stream_loop -1` (infinite looping) and the music starts at video t=0, the
 * timestamps are equivalently seconds from VIDEO start — but only valid up to
 * the music's natural duration. After that the music loops and the same beats
 * repeat at offset N×musicDuration. detectBeats() handles this by tiling the
 * detected beat list across `videoDurationSec` so the brightness pulses
 * continue throughout the entire video, not just during the first loop.
 */

import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

export interface BeatDetectOptions {
  /** Minimum gap between adjacent beats. Default 0.35s ≈ 170 BPM ceiling. */
  minGapSec?: number;
  /**
   * Adaptive threshold offset above the median RMS (dB). A window is considered
   * for "beat" only when its RMS_level >= median + offset. Default 4.0 dB.
   */
  thresholdOffsetDb?: number;
  /**
   * Hard cap on returned beats. Caps the size of the FFmpeg `enable=`
   * expression downstream. Default 64.
   */
  maxBeats?: number;
  /**
   * `asetnsamples` window size — 2048 samples ≈ 43ms at 48kHz, giving fine
   * enough granularity for kicks while keeping CPU low. Default 2048.
   */
  windowSamples?: number;
  /**
   * If true, beats found in the music file are tiled across `videoDurationSec`
   * to handle music looping (`-stream_loop -1`). Default true.
   */
  tileToVideoDuration?: boolean;
  /** Total video duration. Required when `tileToVideoDuration=true`. */
  videoDurationSec?: number;
}

export interface BeatDetectResult {
  /** Beat timestamps in seconds, sorted ascending, after gap-filtering & cap. */
  beats: number[];
  /** Median RMS_level (dB) across analyzed windows — useful for diagnostics. */
  medianRmsDb: number;
  /** Adaptive threshold actually used (medianRmsDb + thresholdOffsetDb). */
  thresholdDbUsed: number;
  /** Number of windows analyzed (for diagnostics). */
  windowsAnalyzed: number;
  /** Approximate detected BPM based on average gap between unfiltered peaks; null if too few. */
  approxBpm: number | null;
  /** Music's natural duration in seconds (before any looping). */
  musicDurationSec: number;
}

/**
 * Empty result returned when input is invalid or detection should be skipped
 * (e.g. no music). Callers should branch on `beats.length === 0` to skip the
 * pulse filter entirely (don't emit an empty `enable=''` — FFmpeg rejects it).
 */
const EMPTY: BeatDetectResult = {
  beats: [],
  medianRmsDb: -Infinity,
  thresholdDbUsed: -Infinity,
  windowsAnalyzed: 0,
  approxBpm: null,
  musicDurationSec: 0,
};

/**
 * Detect beat-like onsets in an audio file.
 *
 * Returns EMPTY (beats = []) on any failure — never throws. The caller should
 * just skip wiring the pulse filter and proceed normally with the unpulsed bg.
 */
export async function detectBeats(
  audioPath: string,
  opts: BeatDetectOptions = {},
): Promise<BeatDetectResult> {
  if (!audioPath) return EMPTY;
  const {
    minGapSec = 0.35,
    thresholdOffsetDb = 4.0,
    maxBeats = 64,
    windowSamples = 2048,
    tileToVideoDuration = true,
    videoDurationSec,
  } = opts;

  const bin = ffmpegPath ?? "ffmpeg";

  // Step 1: extract per-window RMS via ffmpeg `astats` + `ametadata` print.
  let stdout = "";
  let stderr = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", audioPath,
        "-af",
        // asetnsamples gives us fixed-size frames for stable per-frame stats.
        // astats with metadata=1:reset=1 emits per-frame RMS_level; ametadata
        // mode=print writes those metadata KV pairs to the chosen file.
        // Restrict to first channel (mono mix-down) so we get one RMS value per frame.
        `aresample=48000:resampler=soxr,aformat=channel_layouts=mono:sample_fmts=fltp,asetnsamples=n=${windowSamples}:p=0,astats=metadata=1:reset=1:length=0,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`,
        "-f", "null",
        "-",
      ];
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg astats exit ${code}`)));
    });
  } catch (_err) {
    // Never log the full error or audio path — keep the silent-fail contract.
    return EMPTY;
  }

  // Step 2: parse stdout. ametadata mode=print emits records like:
  //   frame:N    pts:P       pts_time:T
  //   lavfi.astats.Overall.RMS_level=-26.512
  // for each window.
  const samples: { t: number; rmsDb: number }[] = [];
  const lines = stdout.split(/\r?\n/);
  let curT: number | null = null;
  for (const ln of lines) {
    if (ln.startsWith("frame:")) {
      const m = /pts_time:([0-9.]+)/.exec(ln);
      curT = m ? parseFloat(m[1]) : null;
      continue;
    }
    if (ln.startsWith("lavfi.astats.Overall.RMS_level=") && curT !== null) {
      const v = parseFloat(ln.slice("lavfi.astats.Overall.RMS_level=".length));
      if (Number.isFinite(v)) samples.push({ t: curT, rmsDb: v });
      curT = null;
    }
  }
  if (samples.length < 8) return { ...EMPTY, windowsAnalyzed: samples.length };

  // Step 3: adaptive threshold = median(RMS) + offset.
  const sorted = samples.map((s) => s.rmsDb).slice().sort((a, b) => a - b);
  const medianRmsDb = sorted[Math.floor(sorted.length / 2)];
  const thresholdDbUsed = medianRmsDb + thresholdOffsetDb;

  // Step 4: peak-pick — local maxima above threshold with minGapSec spacing.
  const rawPeaks: number[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const cur = samples[i];
    if (cur.rmsDb < thresholdDbUsed) continue;
    if (cur.rmsDb < samples[i - 1].rmsDb) continue;
    if (cur.rmsDb < samples[i + 1].rmsDb) continue;
    rawPeaks.push(cur.t);
  }

  // Apply min-gap filter: prefer the first peak in each window.
  const gapped: number[] = [];
  for (const t of rawPeaks) {
    if (gapped.length === 0 || t - gapped[gapped.length - 1] >= minGapSec) {
      gapped.push(t);
    }
  }

  // Approx BPM from average gap between gapped peaks.
  let approxBpm: number | null = null;
  if (gapped.length >= 4) {
    let sumGaps = 0;
    for (let i = 1; i < gapped.length; i++) sumGaps += gapped[i] - gapped[i - 1];
    const avgGap = sumGaps / (gapped.length - 1);
    if (avgGap > 0) approxBpm = Math.round(60 / avgGap);
  }

  // Music duration = last sample timestamp. (Approximate but adequate for
  // tiling logic; off by ~1 window which is < 50ms.)
  const musicDurationSec = samples[samples.length - 1].t + (windowSamples / 48000);

  // Step 5: tile across video duration if requested AND video > music.
  let beats = gapped;
  if (tileToVideoDuration && videoDurationSec && videoDurationSec > musicDurationSec && musicDurationSec > 0) {
    const tiled: number[] = [];
    for (let offset = 0; offset < videoDurationSec; offset += musicDurationSec) {
      for (const t of gapped) {
        const tt = t + offset;
        if (tt >= videoDurationSec) break;
        tiled.push(tt);
      }
    }
    beats = tiled;
  } else if (videoDurationSec) {
    // Trim any beats past the video end.
    beats = beats.filter((t) => t < videoDurationSec);
  }

  // Step 6: cap.
  if (beats.length > maxBeats) {
    // Evenly distribute when over cap so visual rhythm is preserved.
    const stride = beats.length / maxBeats;
    const picked: number[] = [];
    for (let i = 0; i < maxBeats; i++) picked.push(beats[Math.floor(i * stride)]);
    beats = picked;
  }

  return { beats, medianRmsDb, thresholdDbUsed, windowsAnalyzed: samples.length, approxBpm, musicDurationSec };
}

/**
 * Build the FFmpeg filter chain for the beat-synced background brightness
 * pulse. Returns a single-filter string array ready to push into the complex
 * filter graph.
 *
 * The pulse is a +`brightnessDelta` `eq=brightness=...` step gated by an
 * `enable=` expression that's true only inside short windows around each beat
 * (`[beat - preWindowSec, beat + postWindowSec]`). Outside those windows the
 * eq filter is bypassed (FFmpeg's standard `enable=` behavior), so the bg
 * passes through unchanged.
 *
 * **CRITICAL — comma escape**: FFmpeg parses commas as filter separators
 * inside complex filter graphs. Inside the `enable=` expression, every comma
 * passed to `between()` MUST be backslash-escaped (`\,`). This is the same
 * gotcha as T102 (light leaks) and T104 (swoosh).
 *
 * If `beats` is empty, returns a single null-filter pass-through so the graph
 * stays well-formed (callers can always push the result, no need to branch).
 */
export interface BeatPulseOptions {
  /** Brightness delta applied during pulse windows. Default +0.05 (5%). */
  brightnessDelta?: number;
  /** Pulse pre-window (seconds before beat). Default 0.02s. */
  preWindowSec?: number;
  /** Pulse post-window (seconds after beat). Default 0.10s. */
  postWindowSec?: number;
}

export function buildBeatPulseFilter(
  beats: number[],
  inputLabel: string,
  outputLabel: string,
  opts: BeatPulseOptions = {},
): string[] {
  const { brightnessDelta = 0.05, preWindowSec = 0.02, postWindowSec = 0.10 } = opts;
  if (!beats || beats.length === 0) {
    return [`[${inputLabel}]null[${outputLabel}]`];
  }
  // Build the enable= expression: between(t,a1,b1)+between(t,a2,b2)+...
  // Commas inside between() are escaped so FFmpeg's filter-graph parser
  // doesn't split the filter at them.
  const terms = beats.map((t) => {
    const a = Math.max(0, t - preWindowSec).toFixed(3);
    const b = (t + postWindowSec).toFixed(3);
    return `between(t\\,${a}\\,${b})`;
  });
  const enableExpr = terms.join("+");
  return [
    `[${inputLabel}]eq=brightness=${brightnessDelta.toFixed(3)}:enable='${enableExpr}'[${outputLabel}]`,
  ];
}
