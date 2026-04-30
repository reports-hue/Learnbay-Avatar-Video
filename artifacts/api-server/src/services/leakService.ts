import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logger } from "../lib/logger.js";
import type { WordTiming } from "./speech.js";

const LEAK_DURATION_SEC = 0.5;
const LEAK_W = 1920;
const LEAK_H = 1080;

interface LeakSpec {
  filename: string;
  filterChain: string;
}

const LEAK_SPECS: LeakSpec[] = [
  {
    filename: "leak_warm_horizontal.mp4",
    filterChain:
      `gradients=s=1200x1200:type=radial:x0=600:y0=600:x1=1200:y1=600` +
      `:c0=0xFF9955:c1=0x000000:duration=${LEAK_DURATION_SEC}:rate=30,format=yuv420p[blob];` +
      `[0:v][blob]overlay=x='-1200+(W+2400)*t/${LEAK_DURATION_SEC}':y='(H-h)/2':eval=frame[out]`,
  },
  {
    filename: "leak_amber_radial.mp4",
    filterChain:
      `gradients=s=${LEAK_W}x${LEAK_H}:type=radial:x0=${Math.round(LEAK_W / 2)}:y0=${Math.round(LEAK_H / 2)}` +
      `:x1=1500:y1=${Math.round(LEAK_H / 2)}:c0=0xFFCC77:c1=0x000000:duration=${LEAK_DURATION_SEC}:rate=30,format=yuv420p[blob];` +
      `[0:v][blob]overlay=x='(W-w)/2':y='(H-h)/2'[out]`,
  },
  {
    filename: "leak_gold_vertical.mp4",
    filterChain:
      `gradients=s=1400x1400:type=radial:x0=700:y0=700:x1=1400:y1=700` +
      `:c0=0xFFAA77:c1=0x000000:duration=${LEAK_DURATION_SEC}:rate=30,format=yuv420p[blob];` +
      `[0:v][blob]overlay=x='(W-w)/2':y='H-(H+1400)*t/${LEAK_DURATION_SEC}':eval=frame[out]`,
  },
];

function generateLeak(spec: LeakSpec, outPath: string): void {
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-t", String(LEAK_DURATION_SEC),
    "-i", `color=c=black:s=${LEAK_W}x${LEAK_H}:r=30`,
    "-filter_complex", spec.filterChain,
    "-map", "[out]",
    "-t", String(LEAK_DURATION_SEC),
    "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
    outPath,
  ];
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `Leak generation failed for ${spec.filename}: status=${result.status} stderr=${(result.stderr ?? "").slice(0, 500)}`,
    );
  }
}

export async function ensureLeakAssets(cacheDir: string): Promise<string[]> {
  await mkdir(cacheDir, { recursive: true });
  const paths: string[] = [];
  let generated = 0;
  for (const spec of LEAK_SPECS) {
    const outPath = path.join(cacheDir, spec.filename);
    if (!existsSync(outPath)) {
      generateLeak(spec, outPath);
      generated++;
    }
    paths.push(outPath);
  }
  if (generated > 0) {
    logger.info({ generated, total: LEAK_SPECS.length, cacheDir }, "Leak assets generated");
  }
  return paths;
}

interface FindSentenceOpts {
  hookLockoutSec: number;
  outroLockoutSec: number;
  totalDuration: number;
  minGapSec: number;
  maxCount: number;
}

export function findSentenceBoundaries(
  wordTimings: WordTiming[],
  opts: FindSentenceOpts,
): number[] {
  if (wordTimings.length === 0) return [];

  const candidates: number[] = [];
  for (const wt of wordTimings) {
    if (/[.!?]['"`)\]\}]?$/.test(wt.word)) {
      const endSec = wt.startSec + wt.durationSec;
      candidates.push(endSec);
    }
  }

  const minStart = opts.hookLockoutSec;
  const maxStart = Math.max(0, opts.totalDuration - opts.outroLockoutSec);
  const filtered = candidates.filter((t) => t >= minStart && t <= maxStart);

  const spaced: number[] = [];
  let lastT = -Infinity;
  for (const t of filtered) {
    if (t - lastT >= opts.minGapSec) {
      spaced.push(t);
      lastT = t;
    }
  }

  if (spaced.length <= opts.maxCount) return spaced;
  const stride = (spaced.length - 1) / (opts.maxCount - 1);
  const out: number[] = [];
  for (let i = 0; i < opts.maxCount; i++) {
    out.push(spaced[Math.round(i * stride)]);
  }
  return out;
}

interface BuildLeakFiltersOpts {
  events: number[];
  leakInputIndices: number[];
  totalDuration: number;
  outW: number;
  outH: number;
  inputLabel: string;
  outputLabel: string;
  opacity?: number;
  preWindowSec?: number;
  postWindowSec?: number;
}

export function buildLightLeakFilters(opts: BuildLeakFiltersOpts): string[] {
  const op = opts.opacity ?? 0.30;
  const pre = opts.preWindowSec ?? 0.05;
  const post = opts.postWindowSec ?? 0.40;

  if (opts.events.length === 0) {
    return [`[${opts.inputLabel}]null[${opts.outputLabel}]`];
  }
  if (opts.events.length !== opts.leakInputIndices.length) {
    throw new Error(
      `buildLightLeakFilters: events (${opts.events.length}) and leakInputIndices (${opts.leakInputIndices.length}) length mismatch`,
    );
  }

  const fp: string[] = [];
  let prevLabel = opts.inputLabel;

  for (let i = 0; i < opts.events.length; i++) {
    const eventT = opts.events[i];
    const leakIdx = opts.leakInputIndices[i];
    const startBlend = Math.max(0, eventT - pre);
    const endBlend = Math.min(opts.totalDuration, eventT + post);
    const startPad = startBlend.toFixed(3);
    const stopPad = Math.max(0, opts.totalDuration - endBlend).toFixed(3);

    fp.push(
      `[${leakIdx}:v]scale=${opts.outW}:${opts.outH},setsar=1,` +
      `tpad=start_duration=${startPad}:stop_duration=${stopPad}:color=black,` +
      `format=gbrp[lk${i}]`,
    );

    const isLast = i === opts.events.length - 1;
    const bgRgbLabel = `bg_lk_rgb_${i}`;
    const bgOutLabel = isLast ? opts.outputLabel : `bg_lk_${i}`;
    fp.push(`[${prevLabel}]format=gbrp[${bgRgbLabel}]`);
    fp.push(
      `[${bgRgbLabel}][lk${i}]blend=all_mode=screen:all_opacity=${op.toFixed(2)}` +
      `:enable='between(t\\,${startBlend.toFixed(3)}\\,${endBlend.toFixed(3)})',` +
      `format=yuv420p[${bgOutLabel}]`,
    );
    prevLabel = bgOutLabel;
  }
  return fp;
}
