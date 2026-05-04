import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import { spawn, spawnSync } from "child_process";
import { logger } from "../lib/logger.js";
import type { WordTiming } from "./speech.js";
import {
  ensureLeakAssets,
  findSentenceBoundaries,
  buildLightLeakFilters,
} from "./leakService.js";
import { computeOutroState, generateOutroCardAss } from "./outroCardService.js";
import { detectBeats, buildBeatPulseFilter } from "./beatDetect.js";
import {
  computeIntroState,
  buildLargeLogoFilters,
  buildBlackoutFilter,
  buildCornerLogoFadeIn,
  brandColorToFfmpeg,
} from "./introStingService.js";
import {
  buildBrollPipFilter,
  buildBrollFullscreenFilter,
  type BrollResource,
} from "./brollEngine.js";
import {
  buildStatPopinLockoutWindows,
  generateStatPopinAss,
} from "./statPopinService.js";
import type { Segment } from "./scriptSegmenter.js";
import { prepareLogoFromUrl, probeImageDims } from "./logoService.js";

/**
 * Select an ffmpeg binary that supports the full filter set we need.
 *
 * The bundled `ffmpeg-static` package on Node 5.3.0 ships johnvansickle's
 * static 7.0.2 build, which omits `drawtext` (and a handful of other
 * libfreetype-backed filters). Our pipeline depends on `drawtext` for
 * ambient particles (T101), the swoosh sting (T104), and elsewhere — so
 * if we silently use `ffmpeg-static` everywhere, those filters fail with
 * `No such filter: 'drawtext'` and the entire post-process render dies.
 *
 * Strategy: probe each candidate binary's `-filters` output for a
 * `drawtext` line. Pick the first that has it. Fall back to `ffmpeg-static`
 * (so non-drawtext renders keep working) if no candidate qualifies, but
 * log a loud warning so the deployment surfaces the issue.
 *
 * Probe order:
 *  1. `FFMPEG_PATH` env override (operator escape hatch)
 *  2. Build-time resolved Nix path (`.ffmpeg_path` written during prod build)
 *  3. `ffmpeg` from PATH (typically the system / Nix-provided full build)
 *  4. `ffmpeg-static` (last resort)
 */
function binaryHasDrawtext(bin: string): boolean {
  try {
    const r = spawnSync(bin, ["-hide_banner", "-filters"], {
      encoding: "utf-8",
      timeout: 4000,
    });
    if (r.status !== 0 || !r.stdout) return false;
    return /^\s*[A-Z.]{3,5}\s+drawtext\s/m.test(r.stdout);
  } catch {
    return false;
  }
}

// These constants are replaced at build time by esbuild `define`.
// They hold the absolute Nix store paths resolved during `build.mjs`.
declare const __FFMPEG_BUILD_PATH__: string;
declare const __FFPROBE_BUILD_PATH__: string;

const ffmpegCandidates: string[] = [
  process.env.FFMPEG_PATH ?? "",
  typeof __FFMPEG_BUILD_PATH__ !== "undefined" ? __FFMPEG_BUILD_PATH__ : "",
  "ffmpeg",
  ffmpegPath ?? "",
].filter(Boolean);

let selectedFfmpeg: string | null = null;
for (const c of ffmpegCandidates) {
  if (binaryHasDrawtext(c)) {
    selectedFfmpeg = c;
    break;
  }
}

if (selectedFfmpeg) {
  ffmpeg.setFfmpegPath(selectedFfmpeg);
  logger.info(
    { binary: selectedFfmpeg },
    "[ffmpeg] selected binary with drawtext support"
  );
} else if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  logger.warn(
    { binary: ffmpegPath },
    "[ffmpeg] no binary with drawtext support found — particles, swoosh, and other text-based overlays will fail. Set FFMPEG_PATH to a full FFmpeg build to fix."
  );
}

const ffprobeBuildTime = typeof __FFPROBE_BUILD_PATH__ !== "undefined" ? __FFPROBE_BUILD_PATH__ : "";
const ffprobeResolved = ffprobeBuildTime || ffprobeStatic?.path || "ffprobe";
ffmpeg.setFfprobePath(ffprobeResolved);

export const resolvedFfprobeBin: string = ffprobeResolved;

/**
 * Resolved ffmpeg binary path used by all out-of-band `spawn(...)` calls
 * in this module (loudness measurement, leak asset prep, beat detection,
 * Pexels caching, etc.). Falls back to plain `ffmpeg` (PATH lookup) if
 * neither probe nor the static package returned a path.
 */
const resolvedFfmpegBin: string = selectedFfmpeg ?? ffmpegPath ?? "ffmpeg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, "../assets");
const outputsDir = path.resolve(__dirname, "../outputs");

const VERTICAL_PLATFORMS = new Set(["YouTube Shorts", "Instagram Reels", "Facebook Reels"]);

export type CaptionStyle = "none" | "animated" | "static";

// ─────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────

async function getDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
  });
}

interface LoudnessTarget {
  I: number;   // integrated loudness (LUFS)
  TP: number;  // true peak (dBTP)
  LRA: number; // loudness range (LU)
}

interface LoudnessMeasurement {
  measured_I: string;
  measured_TP: string;
  measured_LRA: string;
  measured_thresh: string;
  offset: string;
}

/**
 * Two-pass loudnorm measurement. Runs ffmpeg with print_format=json against
 * the audio of `audioPath` (video container or bare audio file), parses the
 * trailing JSON block from stderr, and returns measured params suitable for
 * feeding into a second loudnorm pass with `linear=true`.
 *
 * Returns null on any failure — caller should fall back to single-pass.
 *
 * Why two-pass: single-pass loudnorm uses a dynamic algorithm that lands
 * approximately ±2 LU off target on short content. Two-pass uses linear
 * gain based on the measured integrated loudness and lands within ±0.5 LU,
 * which matters for matching broadcast spec (Azure-TTS: −16 LUFS / −1.5 dBTP,
 * ElevenLabs: −14 LUFS / −1.0 dBTP).
 */
async function measureLoudness(
  audioPath: string,
  target: LoudnessTarget
): Promise<LoudnessMeasurement | null> {
  return new Promise((resolve) => {
    const bin = resolvedFfmpegBin;
    const args = [
      "-hide_banner",
      "-nostats",
      "-i", audioPath,
      "-vn",
      "-af", `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:print_format=json`,
      "-f", "null",
      "-",
    ];
    const proc = spawn(bin, args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        logger.warn({ code, audioPath }, "loudnorm pass-1 measurement failed");
        return resolve(null);
      }
      // ffmpeg prints the JSON block at the end of stderr — find the last
      // brace block that contains "input_i".
      const matches = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/g);
      if (!matches || matches.length === 0) {
        logger.warn({ audioPath }, "loudnorm pass-1: no JSON block in stderr");
        return resolve(null);
      }
      try {
        const j = JSON.parse(matches[matches.length - 1]);
        resolve({
          measured_I: String(j.input_i),
          measured_TP: String(j.input_tp),
          measured_LRA: String(j.input_lra),
          measured_thresh: String(j.input_thresh),
          offset: String(j.target_offset),
        });
      } catch (err) {
        logger.warn({ err, audioPath }, "loudnorm pass-1 JSON parse failed");
        resolve(null);
      }
    });
  });
}

async function downloadUrl(url: string, dest: string): Promise<void> {
  const res = await axios.get<NodeJS.ReadableStream>(url, { responseType: "stream" });
  const writer = createWriteStream(dest);
  return new Promise((resolve, reject) => {
    (res.data as NodeJS.ReadableStream).pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function toFFmpegHex(hex: string): string {
  const clean = hex.replace(/^#/, "").slice(0, 6);
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return `0x${clean}`;
  return "0x7C3AED";
}

function toAssColor(hex: string): string {
  const clean = hex.replace(/^#/, "").slice(0, 6).padEnd(6, "0");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function formatAssTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const cs = Math.floor((totalSec % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Build an ambient drifting-bokeh particle layer that screen-blends with the
// background BEFORE the avatar is overlaid (so particles never cover the face).
// Pure FFmpeg, no external assets — uses drawtext bullets + gaussian blur, with
// per-particle sin/cos drift driven by the `t` (time) variable.
//
// Why drawtext (not drawbox)? FFmpeg 6.1.x drawbox lacks `eval=frame`; drawtext
// evaluates x/y per-frame natively. Why gbrp blend? Screen-blend in YUV
// contaminates chroma (causes a purple cast on dark navy bgs); forcing both
// inputs through `gbrp` keeps colors pure.
//
// Particle positions are placed in safe zones to avoid the avatar face area:
//  • Landscape: top/bottom edges + left/right columns (face occupies center).
//  • Vertical: top band + thin side columns (avatar fills bottom 88%).
type ParticleSpec = {
  nx: number; ny: number;        // normalized position 0-1
  size: number;                  // font size in px (10-16)
  opacity: number;               // 0-1
  freqX: number; freqY: number;  // drift frequencies in rad/s
  ampX: number; ampY: number;    // drift amplitudes in px
};

const LANDSCAPE_PARTICLES: ParticleSpec[] = [
  { nx: 0.06, ny: 0.13, size: 14, opacity: 0.9,  freqX: 0.50, freqY: 0.30, ampX: 30, ampY: 20 },
  { nx: 0.43, ny: 0.16, size: 16, opacity: 0.85, freqX: 0.60, freqY: 0.45, ampX: 28, ampY: 22 },
  { nx: 0.85, ny: 0.16, size: 13, opacity: 0.80, freqX: 0.55, freqY: 0.50, ampX: 28, ampY: 20 },
  { nx: 0.06, ny: 0.62, size: 13, opacity: 0.70, freqX: 0.50, freqY: 0.40, ampX: 26, ampY: 22 },
  { nx: 0.91, ny: 0.38, size: 12, opacity: 0.70, freqX: 0.50, freqY: 0.55, ampX: 28, ampY: 24 },
  { nx: 0.10, ny: 0.86, size: 15, opacity: 0.80, freqX: 0.60, freqY: 0.40, ampX: 25, ampY: 18 },
  { nx: 0.71, ny: 0.93, size: 12, opacity: 0.85, freqX: 0.45, freqY: 0.55, ampX: 30, ampY: 24 },
];

const VERTICAL_PARTICLES: ParticleSpec[] = [
  { nx: 0.08, ny: 0.06, size: 13, opacity: 0.85, freqX: 0.50, freqY: 0.35, ampX: 28, ampY: 20 },
  { nx: 0.46, ny: 0.05, size: 16, opacity: 0.85, freqX: 0.60, freqY: 0.40, ampX: 30, ampY: 24 },
  { nx: 0.85, ny: 0.07, size: 10, opacity: 0.65, freqX: 0.45, freqY: 0.40, ampX: 24, ampY: 20 },
  { nx: 0.06, ny: 0.34, size: 12, opacity: 0.70, freqX: 0.45, freqY: 0.50, ampX: 22, ampY: 24 },
  { nx: 0.05, ny: 0.78, size: 13, opacity: 0.75, freqX: 0.55, freqY: 0.45, ampX: 22, ampY: 20 },
  { nx: 0.93, ny: 0.55, size: 13, opacity: 0.75, freqX: 0.45, freqY: 0.40, ampX: 26, ampY: 24 },
];

function buildAmbientParticlesFilter(
  durationSec: number,
  outW: number,
  outH: number,
  isVertical: boolean,
  inputLabel: string,
  outputLabel: string,
): string[] {
  const specs = isVertical ? VERTICAL_PARTICLES : LANDSCAPE_PARTICLES;
  // Deterministic per-particle phase offsets (so motion isn't synchronized).
  // Hand-picked to spread phases evenly across [0, 2π).
  const phases = [0.00, 0.83, 1.66, 2.49, 3.32, 4.15, 4.98, 0.41, 1.24, 2.07, 2.90, 3.73, 4.56, 5.39];

  // Build a chained drawtext expression on top of a transparent-equivalent
  // black source. We blur the result and screen-blend over the bg.
  const drawtexts = specs.map((p, i) => {
    const baseX = Math.round(p.nx * outW);
    const baseY = Math.round(p.ny * outH);
    const phX = phases[i % phases.length];
    const phY = phases[(i + 7) % phases.length]; // offset Y phase from X phase
    // FFmpeg expr inside a -filter_complex_script: escape commas with \, and colons inside [] not needed here
    const xExpr = `${baseX}+${p.ampX}*sin(${p.freqX.toFixed(2)}*t+${phX.toFixed(2)})`;
    const yExpr = `${baseY}+${p.ampY}*cos(${p.freqY.toFixed(2)}*t+${phY.toFixed(2)})`;
    return `drawtext=text='\u25CF':fontcolor=white@${p.opacity.toFixed(2)}:fontsize=${p.size}:x='${xExpr}':y='${yExpr}'`;
  });

  // sigma=2 (5×5 kernel) vs original sigma=11 (23×23): ~20x cheaper per frame.
  return [
    // Particle layer: black canvas + N drifting bullet glyphs + light blur,
    // forced into RGB so screen-blend doesn't shift chroma.
    `color=c=black:s=${outW}x${outH}:r=15:d=${durationSec.toFixed(2)},${drawtexts.join(",")},gblur=sigma=2,format=gbrp[parts]`,
    // Force bg into RGB, screen-blend particles, convert back to YUV for downstream filters.
    `[${inputLabel}]format=gbrp[bg_rgb]`,
    `[bg_rgb][parts]blend=all_mode=screen:all_opacity=0.65,format=yuv420p[${outputLabel}]`,
  ];
}

// Extract first sentence from script for hook text
function extractHookSentence(script: string): string {
  const match = script.match(/^[^.!?]+[.!?]/);
  const raw = match ? match[0] : script.slice(0, 80);
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

// ─────────────────────────────────────────────
// ASS subtitle generators
// ─────────────────────────────────────────────

async function generateHookAssFile(
  script: string,
  outputPath: string,
  w: number,
  h: number,
  accentColor: string
): Promise<void> {
  const hookText = extractHookSentence(script);
  if (!hookText) return;
  const isVertical = h > w;
  const fontSize = isVertical ? 68 : 52;
  const accentAss = toAssColor(accentColor);
  const marginV = isVertical ? 120 : 80;

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Arial,${fontSize},&H00FFFFFF,${accentAss},&H00000000,&H00000000,-1,0,0,0,100,100,0.5,0,1,3,2,8,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Hook,,0,0,0,,{\\fad(0,300)}${hookText}
`;
  await fs.writeFile(outputPath, content, "utf8");
}

async function generateCtaAssFile(
  cta: string,
  outputPath: string,
  durationSec: number,
  w: number,
  h: number,
  accentColor: string,
  lowerH: number
): Promise<void> {
  const endTime = formatAssTime(durationSec);
  const fontSize = h >= 1080 ? 48 : 36;
  const marginV = Math.round(lowerH * 0.35);
  const accentAss = toAssColor(accentColor);
  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CTA,Arial,${fontSize},&H00FFFFFF,${accentAss},&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,1,2,28,28,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,${endTime},CTA,,0,0,0,,${cta}
`;
  await fs.writeFile(outputPath, content, "utf8");
}

// HeyGen-style animated captions: 3-word window, pill background, active word accent-colored
// Dual-style: CapAvatar (large bottom) for avatar time, CapBroll (small top) for b-roll time.
async function generateAnimatedCaptionsAss(
  wordTimings: WordTiming[],
  outputPath: string,
  w: number,
  h: number,
  accentColor: string,
  lowerH: number,
  brollRanges?: Array<{ start: number; end: number }>
): Promise<void> {
  const isVertical = h > w;
  const baseFontSize = isVertical ? 52 : 42;
  const activeFontSize = isVertical ? 58 : 46;
  const brollFontSize = isVertical ? 26 : 22;
  const accentAss = toAssColor(accentColor);
  // Alignment=2 → bottom-center. MarginV is the distance from the BOTTOM edge.
  // 1.5-inch equivalent: ~144 px of clear space above the lower-third strip.
  const bottomMargin = lowerH + (isVertical ? 144 : 144);

  /** Returns true if midSec falls inside any b-roll cutaway window. */
  const isBroll = (midSec: number) =>
    (brollRanges ?? []).some((r) => midSec >= r.start && midSec <= r.end);

  // Stable-chunk karaoke: group words into CHUNK-word blocks that stay
  // on screen for the entire group duration. Only the ACTIVE word changes
  // colour. Previous approach used a sliding window (each word appeared
  // up to 3× as context), which users experienced as repetitive scrolling.
  const CHUNK = 3;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CapAvatar,Arial,${baseFontSize},&H00FFFFFF,${accentAss},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2.5,3,2,40,40,${bottomMargin},1
Style: CapBroll,Arial,${brollFontSize},&H00DDDDDD,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,2,8,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  const GAP_SEC = 0.05;

  for (let chunkStart = 0; chunkStart < wordTimings.length; chunkStart += CHUNK) {
    const chunk = wordTimings.slice(chunkStart, chunkStart + CHUNK);
    if (chunk.length === 0) continue;

    // Determine end of the entire chunk block.
    const nextChunkFirstWord = wordTimings[chunkStart + CHUNK];
    const chunkEndSec = nextChunkFirstWord
      ? nextChunkFirstWord.startSec - GAP_SEC
      : chunk[chunk.length - 1].startSec + chunk[chunk.length - 1].durationSec + 0.25;

    // Route to CapBroll (small top) during b-roll cutaways, CapAvatar (large
    // bottom karaoke) during avatar-on-screen time.
    const chunkMidSec = (chunk[0].startSec + chunkEndSec) / 2;
    if (isBroll(chunkMidSec)) {
      // B-roll time: simple running transcript at top — no karaoke effects.
      const text = chunk.map((cw) => cw.word).join(" ");
      events.push(
        `Dialogue: 0,${formatAssTime(chunk[0].startSec)},${formatAssTime(chunkEndSec)},CapBroll,,0,0,0,,${text}`
      );
    } else {
      // Avatar time: word-by-word accent highlight karaoke at bottom.
      for (let j = 0; j < chunk.length; j++) {
        const wordStart = Math.max(0, chunk[j].startSec);
        const wordEndRaw = j + 1 < chunk.length
          ? chunk[j + 1].startSec - GAP_SEC
          : chunkEndSec;
        const wordEnd = Math.max(wordStart + 0.04, wordEndRaw);

        const line = chunk.map((cw, idx) => {
          if (idx === j) {
            return `{\\c${accentAss}&\\b1\\fs${activeFontSize}\\shad1}${cw.word}{\\c&H00FFFFFF&\\b0\\fs${baseFontSize}\\shad0}`;
          }
          return `{\\c&H00FFFFFF&\\b0\\fs${baseFontSize}}${cw.word}`;
        }).join(" ");

        events.push(`Dialogue: 0,${formatAssTime(wordStart)},${formatAssTime(wordEnd)},CapAvatar,,0,0,0,,${line}`);
      }
    }
  }

  await fs.writeFile(outputPath, header + events.join("\n") + "\n", "utf8");
}

// Static captions: 3-word chunks with pill background
// Dual-style: CapAvatar (large bottom) for avatar time, CapBroll (small top) for b-roll time.
async function generateStaticCaptionsAss(
  wordTimings: WordTiming[],
  outputPath: string,
  w: number,
  h: number,
  lowerH: number,
  brollRanges?: Array<{ start: number; end: number }>
): Promise<void> {
  const isVertical = h > w;
  const fontSize = isVertical ? 54 : 42;
  const brollFontSize = isVertical ? 26 : 22;
  // Alignment=2 → bottom-center. MarginV is the distance from the BOTTOM edge.
  const bottomMargin = lowerH + (isVertical ? 144 : 144);
  const CHUNK = 3;

  const isBroll = (midSec: number) =>
    (brollRanges ?? []).some((r) => midSec >= r.start && midSec <= r.end);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CapAvatar,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,3,2,40,40,${bottomMargin},1
Style: CapBroll,Arial,${brollFontSize},&H00DDDDDD,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,2,8,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const GAP_SEC = 0.05;
  const events: string[] = [];
  for (let i = 0; i < wordTimings.length; i += CHUNK) {
    const chunk = wordTimings.slice(i, i + CHUNK);
    const startSec = chunk[0].startSec;
    const lastWord = chunk[chunk.length - 1];
    const rawEndSec = i + CHUNK < wordTimings.length
      ? wordTimings[i + CHUNK].startSec - GAP_SEC
      : lastWord.startSec + lastWord.durationSec + 0.2;
    const endSec = Math.max(startSec + 0.04, rawEndSec);
    const start = formatAssTime(startSec);
    const end = formatAssTime(endSec);
    const text = chunk.map((w) => w.word).join(" ");
    const midSec = (startSec + endSec) / 2;
    const style = isBroll(midSec) ? "CapBroll" : "CapAvatar";
    events.push(`Dialogue: 0,${start},${end},${style},,0,0,0,,${text}`);
  }

  await fs.writeFile(outputPath, header + events.join("\n") + "\n", "utf8");
}

// ─────────────────────────────────────────────
// Numeric callouts — pop-in animated stat emphasis
// ─────────────────────────────────────────────

interface NumericCallout {
  text: string;
  startSec: number;
  endSec: number;
}

// Detect spoken stats in word timings (percent / dollar / large number / multiplier
// / number-with-suffix-word) so we can pop-in an animated emphasis at the exact
// moment they're spoken. Curated to high-signal stat patterns only — generic
// counts like "5 reasons" do NOT trigger.
function findNumericCallouts(wordTimings: WordTiming[]): NumericCallout[] {
  const out: NumericCallout[] = [];
  if (wordTimings.length === 0) return out;

  // Skip the first 2.5 s so callouts don't collide with the opening hook
  // overlay; require ≥ 2.0 s gap between callouts to avoid visual noise.
  const HOOK_LOCKOUT_SEC = 2.5;
  const COOLDOWN_SEC = 2.0;
  let lastEndSec = -Infinity;

  // Strip surrounding sentence punctuation (quotes, parens, commas, periods,
  // semicolons, etc.) at WORD BOUNDARIES only — internal `.` and `,` are kept
  // so "2.5" and "50,000" survive intact.
  const clean = (w: string) =>
    w.replace(/^[\s"'`(\[\{]+|[\s"'`)\]\}.,;:!?]+$/g, "");

  for (let i = 0; i < wordTimings.length; i++) {
    const wt = wordTimings[i];
    const startSec = wt.startSec;
    if (startSec < HOOK_LOCKOUT_SEC) continue;
    if (startSec - lastEndSec < COOLDOWN_SEC) continue;

    const word = clean(wt.word);
    if (!word) continue;

    let matchedText: string | null = null;
    let endIdx = i;

    // Pattern A: percent — "15%" / "9.5%"
    if (/^\d{1,3}(?:\.\d+)?%$/.test(word)) {
      matchedText = word;
    }
    // Pattern B: dollar prefix — "$5" / "$2.5M" / "$1.2B"
    else if (/^\$\d+(?:[.,]\d+)?[KMB]?$/i.test(word)) {
      matchedText = word;
    }
    // Pattern C: comma-separated big number — "50,000" / "1,500,000"
    else if (/^\d{1,3}(?:,\d{3})+$/.test(word)) {
      matchedText = word;
    }
    // Pattern D: x-multiplier — "10x" / "3X"
    else if (/^\d+(?:\.\d+)?x$/i.test(word)) {
      matchedText = word;
    }
    // Pattern E: bare number followed by scale word — "5 million" / "2.5 billion"
    else if (/^\d+(?:[.,]\d+)?$/.test(word) && i + 1 < wordTimings.length) {
      const nextRaw = clean(wordTimings[i + 1].word).toLowerCase();
      if (/^(thousand|million|billion|trillion|hundred)$/.test(nextRaw)) {
        matchedText = `${word} ${wordTimings[i + 1].word}`;
        endIdx = i + 1;
      }
    }

    if (matchedText) {
      const endWt = wordTimings[endIdx];
      const endSec = endWt.startSec + endWt.durationSec;
      out.push({ text: matchedText, startSec, endSec });
      lastEndSec = endSec;
      // skip the consumed second word for multi-word matches
      if (endIdx > i) i = endIdx;
    }
  }

  return out;
}

// ASS callout overlay. Pop-in scale animation (60% → 115% overshoot → 100%)
// with fade-in/out, brand-accent fill, thick black outline + drop shadow for
// readability against ANY background. Spec: BorderStyle=1 (outline+shadow only).
async function generateNumericCalloutsAss(
  callouts: NumericCallout[],
  outputPath: string,
  w: number,
  h: number,
  accentColor: string
): Promise<void> {
  const isVertical = h > w;
  // Big & bold but not silly. ~10% of frame height is a reliable readable size.
  const fontSize = isVertical ? 150 : 120;
  const accentAss = toAssColor(accentColor);

  // Anchor (an5 = centered-on-pos). Safe zones derived from avatar layout:
  //   landscape — left-third, slightly above mid (avatar face is centered, so
  //               left side is empty even when figure is full-frame)
  //   vertical  — top area above the avatar head (avatar fills 88% from bottom,
  //               leaving y < ~200px clear; we sit at 15% with extra hook lockout)
  const posX = isVertical ? Math.round(w * 0.5) : Math.round(w * 0.21);
  const posY = isVertical ? Math.round(h * 0.15) : Math.round(h * 0.40);

  // Style line — BorderStyle=1, accent fill, thick black outline (5px), shadow 3px
  const styleLine = `Style: Stat,Arial,${fontSize},${accentAss},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,5,3,5,0,0,0,1`;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  for (const c of callouts) {
    // Hold for ≥ 1.4 s after the word ends so viewer can read it
    const dispStart = c.startSec;
    const dispEnd = Math.max(c.endSec + 1.4, dispStart + 1.4);
    const startTs = formatAssTime(dispStart);
    const endTs = formatAssTime(dispEnd);

    // Override tags:
    //   \an5\pos — anchored center
    //   \fad     — 200ms in / 350ms out
    //   \fscx\fscy 60 → \t(0,250,1.5,...115) overshoot → \t(250,400,0.7,...100) settle
    const overrides =
      `{\\an5\\pos(${posX},${posY})\\fad(200,350)` +
      `\\fscx60\\fscy60` +
      `\\t(0,250,1.5,\\fscx115\\fscy115)` +
      `\\t(250,400,0.7,\\fscx100\\fscy100)}`;
    events.push(`Dialogue: 0,${startTs},${endTs},Stat,,0,0,0,,${overrides}${c.text}`);
  }

  await fs.writeFile(outputPath, header + events.join("\n") + (events.length ? "\n" : ""), "utf8");
}

// ─────────────────────────────────────────────
// Thumbnail extraction
// ─────────────────────────────────────────────

export async function extractThumbnail(
  videoPath: string,
  thumbnailPath: string
): Promise<string | null> {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .seekInput(2)
      .frames(1)
      .outputOptions(["-q:v 2"])
      .output(thumbnailPath)
      .on("end", () => { logger.info({ thumbnailPath }, "Thumbnail extracted"); resolve(thumbnailPath); })
      .on("error", (err) => { logger.warn({ err }, "Thumbnail extraction failed"); resolve(null); })
      .run();
  });
}

// ─────────────────────────────────────────────
// Main post-processing options
// ─────────────────────────────────────────────

export interface PostProcessOptions {
  platform?: string;
  logoUrl?: string;
  primaryColor?: string;
  backgroundColor?: string;
  gradientColor2?: string;
  backgroundStyle?: "cinematic_dark" | "tech_gradient" | "warm_studio" | "creative_pop" | "corporate_sleek";
  bgImagePath?: string;     // local path to AI-generated or user-supplied background image
  cta?: string;
  musicPath?: string;
  wordTimings?: WordTiming[];
  captionStyle?: CaptionStyle;
  outputFilename?: string;
  useGreenScreen?: boolean;
  // When true: avatar source is a transparent WebM (VP9) with a real alpha
  // channel. Skip chromakey/despill entirely and overlay directly — no green
  // fringe, no halo, perfect edges. Mutually exclusive with useGreenScreen.
  useTransparentAvatar?: boolean;
  realism?: boolean;        // default true — enables grain, Ken Burns, enhanced audio
  script?: string;          // used for opening hook text
  elAudioPath?: string;     // local path to ElevenLabs MP3 — when set, replaces the avatar's Azure TTS audio
  /**
   * B-roll insertions (T203). Each resource pairs an LLM-segmented time
   * window (broll-pip or broll-fullscreen) with a Pexels stock-video asset.
   * Resources with `asset === null` are silently skipped (lookup failed).
   * Stat-popin segments are ignored here — the T103 numeric-callout
   * renderer handles those. Audio from b-roll is always muted (consumed
   * via `[N:v]` only).
   */
  brollResources?: BrollResource[];
  /**
   * Premium animated stat-popin segments (T204). Each segment carries a
   * window + the exact emphasis text (e.g., "70%", "$2.5M", "10x"). The
   * statPopinService renders a multi-layer ASS composition (animated pill +
   * count-up number + suffix + icon + underline + particle burst) for each.
   * Stat windows automatically lock out T103 numeric callouts in the same
   * window so the same stat is never rendered twice.
   * On any failure, this is silently dropped and the legacy T103 callouts
   * still fire — render is never blocked.
   */
  statPopinSegments?: Segment[];
  /**
   * Minimal-overlays mode (user-requested clean look).
   *
   * When `true`, the renderer skips every "decorative" stat / hook / intro
   * overlay that competes with the avatar + caption focus, specifically:
   *   - T103 numeric callouts (auto-pop "70%" / "$2.5M" / "10x" stats)
   *   - T204 stat-popin animation is implicitly off too because the route
   *     stops passing `statPopinSegments` when this flag is true (defence
   *     in depth — even if a future caller passes them, the route is the
   *     authoritative gate).
   *   - Opening hook text overlay (first sentence floating at top 0–2s)
   *   - Intro sting (blackout/flash + audio mute window + corner-logo
   *     fade-in animation). The corner logo still appears at full alpha
   *     from t=0 because we only flip the sting state, not the logo path.
   *
   * Untouched even when `true`: AI background, corner logo chip, ambient
   * floating particles, outro/CTA card, captions (with brand-color word
   * highlight), full audio chain, hard rules. This flag is a clean, single
   * switch — flip it false to restore every legacy overlay.
   */
  minimalOverlays?: boolean;
  /**
   * Per-job identifier used to scope all intermediate ASS file names
   * (`outro_card_<videoId>.ass`, `captions_<videoId>.ass`, etc) so two
   * concurrent renders never trash each other's caption / CTA / hook /
   * statpopin / callout overlays mid-render. Required.
   */
  videoId: string;
}

export async function postProcessAvatarVideo(
  avatarVideoPath: string,
  options: PostProcessOptions
): Promise<string> {
  if (!options.videoId) {
    throw new Error("postProcessAvatarVideo: options.videoId is required (per-job ASS file scoping)");
  }
  const outputPath = path.join(outputsDir, options.outputFilename ?? `video_${options.videoId}.mp4`);
  const avatarDuration = await getDuration(avatarVideoPath);

  // If ElevenLabs audio is supplied, retime the avatar video so its overall
  // duration matches the ElevenLabs audio. This keeps the avatar's mouth
  // movements roughly aligned with the swapped-in audio (best-effort lip-sync,
  // since Azure no longer supports lip-sync to external audio).
  let elDuration = 0;
  if (options.elAudioPath && existsSync(options.elAudioPath)) {
    try {
      elDuration = await getDuration(options.elAudioPath);
    } catch {
      elDuration = 0;
    }
  }
  // Clamp the time-stretch ratio to a sensible range so we never produce
  // grotesquely fast/slow avatar mouth movements if the two TTS engines
  // diverge wildly. ratio = elDuration / avatarDuration → applied via setpts.
  const wantsRetime = elDuration > 0 && avatarDuration > 0;
  const rawRatio = wantsRetime ? elDuration / avatarDuration : 1;
  const retimeRatio = Math.max(0.7, Math.min(1.4, rawRatio));
  const useRetime = wantsRetime && Math.abs(retimeRatio - 1) > 0.005;
  // Effective duration drives output length, fade timings, ken burns pan, etc.
  const duration = useRetime ? avatarDuration * retimeRatio : avatarDuration;

  const isVertical = VERTICAL_PLATFORMS.has(options.platform ?? "");
  const realism = options.realism !== false; // default true
  const useTransparentAvatar = options.useTransparentAvatar === true;
  // Transparent path takes precedence — never run chromakey on an alpha source.
  const useGreenScreen = !useTransparentAvatar && options.useGreenScreen === true;

  const outW = isVertical ? 1080 : 1920;
  const outH = isVertical ? 1920 : 1080;
  const lowerH = Math.round(outH * 0.22);

  // Oversized dimensions for Ken Burns (3% larger)
  const outW103 = Math.round(outW * 1.03);
  const outH103 = Math.round(outH * 1.03);
  const bgDur = Math.ceil(duration) + 2;

  const bgHex = toFFmpegHex((options.backgroundColor ?? "#000000FF").slice(0, 7));
  const bg2Hex = options.gradientColor2 ? toFFmpegHex(options.gradientColor2) : null;
  const accentHex = toFFmpegHex(options.primaryColor ?? "#4A9FFF");
  const accentColor = options.primaryColor ?? "#4A9FFF";
  const useGradient = bg2Hex !== null;
  const backgroundStyle = options.backgroundStyle ?? "cinematic_dark";

  // ── Resolve logo ──
  // logoService.prepareLogoFromUrl handles: timeout, redirects, real
  // browser User-Agent (CDNs reject default axios UA), content-type
  // validation, 5MB cap, and SVG → PNG rasterization via ImageMagick.
  // The previous inline downloader had none of these and silently fell
  // through to the bundled logo on every CDN that returns SVG or rejects
  // the default axios UA. We also probe dimensions here so the corner
  // pill chain can choose aspect-aware padding (square icon vs wordmark).
  let logoPath: string | null = null;
  let logoDims: { width: number; height: number } | null = null;
  if (options.logoUrl) {
    try {
      // Local upload-served URLs (/api/video/logo_xxx.png) come back to us
      // with a relative path — short-circuit those to the filesystem path.
      const localMatch = /^\/api\/video\/(.+)$/.exec(options.logoUrl);
      if (localMatch) {
        const candidate = path.join(outputsDir, localMatch[1] ?? "");
        if (existsSync(candidate)) {
          logoPath = candidate;
          logoDims = await probeImageDims(candidate);
        }
      }
      if (!logoPath) {
        const asset = await prepareLogoFromUrl(options.logoUrl, outputsDir);
        logoPath = asset.path;
        logoDims = { width: asset.width, height: asset.height };
        logger.info(
          { fmt: asset.sourceFormat, w: asset.width, h: asset.height },
          "Brand logo prepared from URL",
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Logo URL preparation failed, falling back to built-in logo",
      );
    }
  }
  if (!logoPath) {
    const builtinLogo = path.join(assetsDir, "logo.png");
    if (existsSync(builtinLogo)) {
      logoPath = builtinLogo;
      logoDims = await probeImageDims(builtinLogo);
    }
  }
  // Aspect ratio guides the pill padding ratio downstream. Default to 1.0
  // (square) if we couldn't probe, so we get safe symmetric padding.
  const logoAspect = logoDims && logoDims.height > 0 ? logoDims.width / logoDims.height : 1.0;

  // ── Resolve music ──
  // Single built-in track per user-locked spec: every video uses music_1.mp3
  // for predictable, consistent output. music_2.mp3 was retired here (file
  // stays on disk for reversibility) because:
  //   - music_1 noise floor: -111 dB (broadcast clean)
  //   - music_2 noise floor:  -33 dB (78 dB worse — audible broadband hiss)
  // The caller may still override via options.musicPath. If music_1.mp3 is
  // missing the video is generated without background music (graceful degrade).
  const PRIMARY_MUSIC = "music_1.mp3";
  const primaryPath = path.join(assetsDir, PRIMARY_MUSIC);
  const builtinMusic = existsSync(primaryPath) ? primaryPath : null;
  const musicPath = options.musicPath ?? builtinMusic;

  // ── Outro card state (T105) ──
  // When CTA is set AND duration is long enough (≥6s), the lower-third CTA is
  // replaced by a full-screen branded outro card in the last ~2.5s with the
  // avatar dimming to 30% opacity. For short videos or no CTA, fall back to the
  // original lower-third CTA strip.
  const outroState = computeOutroState(duration, options.cta);

  // ── Intro sting state (T104) ──
  // When a logo is present AND the video is long enough (≥4s), the first
  // ~1.6s opens with a black blackout, a centered large logo (1.6× scale),
  // a corner-logo fade-in at 1.3-1.6s, and a brand-accent vertical strip
  // that "swooshes" left→right across the frame. Below 4s or without a logo
  // the intro is skipped entirely (graph behavior unchanged).
  //
  // When `minimalOverlays` is on we force-inactivate the sting. This is the
  // SAME branch the renderer already takes for short / logo-less videos:
  // every downstream conditional gates on `introState.active`, so flipping
  // this one flag cleanly disables the blackout, the centered large logo,
  // the swoosh strip, the corner-logo fade-in animation, the audio mute
  // window, and shifts the beat-detection start back to t=0. The corner
  // logo CHIP itself still overlays from t=0 (logoPath is untouched) — only
  // its fade-in animation is skipped.
  const computedIntroState = computeIntroState(duration, !!logoPath);
  const introState = options.minimalOverlays
    ? { ...computedIntroState, active: false }
    : computedIntroState;

  // ── ASS files ──
  let ctaAssPath: string | null = null;
  let outroCardAssPath: string | null = null;
  if (outroState.active) {
    outroCardAssPath = path.join(outputsDir, `outro_card_${options.videoId}.ass`);
    await generateOutroCardAss({
      startSec: outroState.startSec,
      durationSec: duration,
      outW,
      outH,
      accentColor,
      headline: outroState.headline,
      url: outroState.url,
      outputPath: outroCardAssPath,
    });
  } else if (options.cta) {
    ctaAssPath = path.join(outputsDir, `cta_${options.videoId}.ass`);
    await generateCtaAssFile(options.cta, ctaAssPath, duration, outW, outH, accentColor, lowerH);
  }

  let captionAssPath: string | null = null;
  const captionStyle = options.captionStyle ?? "animated";
  const wordTimings = options.wordTimings ?? [];
  if (captionStyle !== "none" && wordTimings.length > 0) {
    captionAssPath = path.join(outputsDir, `captions_${options.videoId}.ass`);
    // Compute b-roll time ranges so dual caption styles (CapAvatar bottom vs
    // CapBroll top) can be assigned per-chunk based on what's on screen.
    const brollRanges = (options.brollResources ?? [])
      .filter((r) => {
        const hasLocal = !!(r.localClipPath && existsSync(r.localClipPath));
        const hasPexels = r.asset !== null && existsSync(r.asset.filePath);
        const isVideoMode =
          r.segment.mode === "broll-pip" ||
          r.segment.mode === "broll-fullscreen" ||
          r.segment.mode === "broll-text";
        return isVideoMode && (hasLocal || hasPexels);
      })
      .map((r) => ({ start: r.segment.startSec, end: r.segment.endSec }));
    if (captionStyle === "animated") {
      await generateAnimatedCaptionsAss(wordTimings, captionAssPath, outW, outH, accentColor, lowerH, brollRanges);
    } else {
      await generateStaticCaptionsAss(wordTimings, captionAssPath, outW, outH, lowerH, brollRanges);
    }
    logger.info({ captionStyle, wordCount: wordTimings.length, brollWindows: brollRanges.length }, "Caption ASS generated");
  }

  // ── Opening hook text ASS ──
  // Skipped when minimalOverlays is on — the user prefers a clean look with
  // captions doing all the on-screen text work. The generator function and
  // its consumer (subtitles filter ~line 1601) both stay intact for easy
  // re-enable; we just leave hookAssPath null so the consumer no-ops.
  let hookAssPath: string | null = null;
  if (options.script && realism && !options.minimalOverlays) {
    hookAssPath = path.join(outputsDir, `hook_${options.videoId}.ass`);
    await generateHookAssFile(options.script, hookAssPath, outW, outH, accentColor);
  }

  // ── Premium stat-popin ASS (T204): multi-layer animated stat callouts ──
  // Generated FIRST so we can derive lockout windows for the legacy T103
  // numeric callouts below — same stat must never be rendered twice. Any
  // failure here drops back to T103 only. ASS file is multi-layer: pill +
  // count-up number + suffix + icon + underline + particle burst.
  let statPopinAssPath: string | null = null;
  let statPopinLockouts: Array<[number, number]> = [];
  const statPopinSegments = options.statPopinSegments ?? [];
  if (statPopinSegments.length > 0) {
    try {
      const candidatePath = path.join(outputsDir, `statpopin_${options.videoId}.ass`);
      const wrote = await generateStatPopinAss({
        segments: statPopinSegments,
        outputPath: candidatePath,
        w: outW,
        h: outH,
        accentColor,
      });
      if (wrote) {
        statPopinAssPath = candidatePath;
        statPopinLockouts = buildStatPopinLockoutWindows(statPopinSegments);
        logger.info(
          {
            count: statPopinSegments.filter((s) => s.mode === "stat-popin").length,
            sample: statPopinSegments
              .filter((s) => s.mode === "stat-popin")
              .slice(0, 3)
              .map((s) => ({ start: s.startSec, text: s.emphasisText })),
          },
          "Stat-popin ASS generated (T204)"
        );
      }
    } catch (err) {
      const m = (err as { message?: string })?.message ?? String(err);
      logger.warn({ err: m.slice(0, 200) }, "Stat-popin ASS generation failed; continuing");
      statPopinAssPath = null;
      statPopinLockouts = [];
    }
  }

  // ── Numeric callouts ASS (pop-in stat emphasis) ──
  // Always-on whenever we have word timings (unless minimalOverlays is set —
  // then skipped entirely, so scripts mentioning "70%" or "$2.5M" don't get
  // the bare-stat pop-in overlay either). Detection is highly curated, so
  // scripts without stats simply produce zero callouts and the file is empty.
  // Windows already covered by T204 stat-popin are filtered out so the same
  // stat is never double-rendered (T204 takes priority — it's strictly better).
  let calloutsAssPath: string | null = null;
  if (wordTimings.length > 0 && !options.minimalOverlays) {
    const allCallouts = findNumericCallouts(wordTimings);
    const callouts = allCallouts.filter((c) => {
      // Drop callout if its midpoint falls inside any stat-popin lockout window.
      const mid = (c.startSec + c.endSec) / 2;
      return !statPopinLockouts.some(([a, b]) => mid >= a && mid <= b);
    });
    if (callouts.length > 0) {
      calloutsAssPath = path.join(outputsDir, `callouts_${options.videoId}.ass`);
      await generateNumericCalloutsAss(callouts, calloutsAssPath, outW, outH, accentColor);
      logger.info(
        {
          count: callouts.length,
          suppressedByStatPopin: allCallouts.length - callouts.length,
          sample: callouts.slice(0, 3).map((c) => c.text),
        },
        "Numeric callouts ASS generated"
      );
    } else {
      logger.info(
        { suppressedByStatPopin: allCallouts.length },
        "No numeric callouts to render (or all suppressed by T204 stat-popin)"
      );
    }
  }

  // ── Light-leak transitions at sentence boundaries (T102) ──
  // Identify sentence ends from word timings, lazily generate procedural leak
  // assets (cached forever in outputs/cache/leaks/), and stash event times +
  // leak file paths for input wiring + filter graph below.
  let leakEvents: number[] = [];
  let leakAssetPaths: string[] = [];
  if (wordTimings.length > 0) {
    leakEvents = findSentenceBoundaries(wordTimings, {
      hookLockoutSec: 1.8,    // avoid the opening hook intro
      outroLockoutSec: 2.5,   // avoid the CTA outro card
      totalDuration: duration,
      minGapSec: 1.2,         // never fire two leaks within 1.2s
      maxCount: 3,            // cap filter graph complexity
    });
    if (leakEvents.length > 0) {
      const leakCacheDir = path.join(outputsDir, "cache", "leaks");
      try {
        leakAssetPaths = await ensureLeakAssets(leakCacheDir);
        logger.info(
          { leakCount: leakEvents.length, sample: leakEvents.slice(0, 4).map((t) => t.toFixed(2)) },
          "Light-leak events scheduled"
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Leak asset generation failed; skipping leaks");
        leakEvents = [];
        leakAssetPaths = [];
      }
    } else {
      logger.info("No sentence-boundary leak events detected");
    }
  }

  // ── Beat detection (T106) ──
  // When a music track is present, detect rhythmic accents in it so the
  // background can pulse subtly in sync with the beat. Detection runs the
  // music through a one-pass FFmpeg `astats` analysis; the result is a list
  // of timestamps (already tiled across `duration` to handle music looping).
  // On any failure (missing file, decode error, no clear beats), `beats` is
  // empty and the downstream filter becomes a null pass-through — so this
  // never breaks rendering.
  let beatPulseTimestamps: number[] = [];
  if (musicPath) {
    try {
      const beatResult = await detectBeats(musicPath, {
        videoDurationSec: duration,
        tileToVideoDuration: true,
        maxBeats: 8,
      });
      // Filter beats out of the T104 intro sting window (0 - 1.6s) where the
      // blackout would mask any pulse anyway, and out of the T105 outro card
      // window (last 2.5s when active) where the bg is dimmed under the card.
      const introEnd = introState.active ? 1.6 : 0;
      const outroStart = outroState.active ? outroState.startSec : duration;
      beatPulseTimestamps = beatResult.beats.filter((t) => t >= introEnd && t < outroStart);
      logger.info(
        {
          beatCount: beatPulseTimestamps.length,
          rawBeatCount: beatResult.beats.length,
          approxBpm: beatResult.approxBpm,
          medianRmsDb: beatResult.medianRmsDb.toFixed(1),
          sample: beatPulseTimestamps.slice(0, 5).map((t) => t.toFixed(2)),
        },
        "Beat-sync pulses scheduled"
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Beat detection failed; skipping pulses");
      beatPulseTimestamps = [];
    }
  }

  const bgImagePath = options.bgImagePath && existsSync(options.bgImagePath) ? options.bgImagePath : null;
  const elAudioPath = options.elAudioPath && existsSync(options.elAudioPath) ? options.elAudioPath : null;

  // ── B-roll pre-pass (T203) ──
  // Keep only resources whose Pexels lookup succeeded AND whose mode renders
  // a video overlay (broll-pip or broll-fullscreen). Stat-popin segments are
  // handed off to T103's numeric-callout renderer, not this engine.
  // Each kept resource earns one ffmpeg input slot (inputIdx wired below).
  const renderableBroll = (options.brollResources ?? []).filter((r) => {
    const hasLocal = !!(r.localClipPath && existsSync(r.localClipPath));
    const hasPexels = r.asset !== null && existsSync(r.asset.filePath);
    const isVideoMode =
      r.segment.mode === "broll-pip" ||
      r.segment.mode === "broll-fullscreen" ||
      r.segment.mode === "broll-text";
    return isVideoMode && (hasLocal || hasPexels);
  });
  if (renderableBroll.length > 0) {
    logger.info(
      {
        count: renderableBroll.length,
        sample: renderableBroll.slice(0, 4).map((r) => ({
          mode: r.segment.mode,
          startSec: r.segment.startSec,
          endSec: r.segment.endSec,
          conceptHead: (r.segment.concept ?? r.segment.keyPhrase ?? "").slice(0, 40),
          pexelsId: r.asset?.pexelsId ?? null,
          localClip: r.localClipPath ? path.basename(r.localClipPath) : null,
        })),
      },
      "B-roll segments scheduled for render"
    );
  }

  logger.info(
    {
      platform: options.platform,
      isVertical,
      outW,
      outH,
      avatarMode: useTransparentAvatar ? "transparent-webm" : useGreenScreen ? "green-screen-chroma" : "opaque-overlay",
      useGradient,
      hasBgImage: !!bgImagePath,
      hasElAudio: !!elAudioPath,
      realism,
      captionStyle,
      avatarDuration,
      elDuration,
      retimeRatio: useRetime ? retimeRatio : 1,
      duration,
    },
    "Post-processing avatar video"
  );

  // ── Two-pass loudnorm: pass-1 measurement (BEFORE building filter graph) ──
  // Run loudness analysis on the speech-only source. We pick the source the
  // listener will actually hear: ElevenLabs mp3 if supplied, else the avatar
  // mp4 (which carries the Azure TTS track). Music is mixed in later at very
  // low level (≤ 0.07) and sits below the −30 LUFS gate, so its contribution
  // to integrated loudness is negligible — measuring speech-only is correct.
  const isElSpeechAudio = !!elAudioPath;
  const _loudnessTarget: LoudnessTarget = isElSpeechAudio
    ? { I: -14, TP: -1.0, LRA: 9 }
    : { I: -16, TP: -1.5, LRA: 11 };
  const _speechAudioPath = isElSpeechAudio ? elAudioPath! : avatarVideoPath;
  const measuredLoudness = await measureLoudness(_speechAudioPath, _loudnessTarget);
  if (measuredLoudness) {
    logger.info(
      { target: _loudnessTarget, measured: measuredLoudness, isElSpeechAudio },
      "Loudnorm pass-1 complete (two-pass enabled)"
    );
  } else {
    logger.warn(
      { isElSpeechAudio },
      "Loudnorm pass-1 unavailable — falling back to single-pass"
    );
  }

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();
    let inputIndex = 0;

    cmd = cmd.input(avatarVideoPath);
    const avatarIdx = inputIndex++;

    let bgImgIdx = -1;
    if (bgImagePath) {
      cmd = cmd.input(bgImagePath);
      bgImgIdx = inputIndex++;
    }

    let logoIdx = -1;
    if (logoPath) {
      cmd = cmd.input(logoPath);
      logoIdx = inputIndex++;
    }

    let musicIdx = -1;
    if (musicPath) {
      cmd = cmd.input(musicPath).inputOptions(["-stream_loop -1"]);
      musicIdx = inputIndex++;
    }

    let elAudioIdx = -1;
    if (elAudioPath) {
      cmd = cmd.input(elAudioPath);
      elAudioIdx = inputIndex++;
    }

    // Light-leak inputs (T102): one input per scheduled leak event,
    // round-robin selection from the cached leak variants.
    const leakInputIndices: number[] = [];
    if (leakEvents.length > 0 && leakAssetPaths.length > 0) {
      for (let i = 0; i < leakEvents.length; i++) {
        const assetPath = leakAssetPaths[i % leakAssetPaths.length];
        cmd = cmd.input(assetPath);
        leakInputIndices.push(inputIndex++);
      }
    }

    // B-roll inputs (T203): one input per renderable resource. We use
    // `-an` on each input so ffmpeg never demuxes the stock-clip's audio
    // track (Pexels videos often have ambient/music audio that would
    // otherwise need to be filtered out — `-an` is the cleanest enforcement
    // of the "audio always muted" invariant).
    const brollInputIndices: number[] = [];
    for (const r of renderableBroll) {
      // Use the locally-generated animated text clip if available (broll-text);
      // otherwise fall back to the Pexels asset.
      const clipPath = r.localClipPath ?? r.asset!.filePath;
      cmd = cmd.input(clipPath).inputOptions(["-an"]);
      brollInputIndices.push(inputIndex++);
    }

    // Intro sting inputs (T104): when active, add one `color` input —
    //   blackoutIdx: full-frame white plate that fades out over the transition
    //                window (0→blackoutFadeStart fully opaque, then dissolves).
    // Swoosh (accent strip) removed: user testing showed the sweeping bar was
    // confusing and looked like a render artefact. The logo + blackout fade is
    // sufficient visual interest for the intro sting.
    let blackoutIdx = -1;
    if (introState.active) {
      const stingDur = introState.blackoutFadeEnd + 0.1;
      cmd = cmd.input(`color=c=white:s=${outW}x${outH}:r=30:d=${stingDur.toFixed(3)}`).inputOptions(["-f lavfi"]);
      blackoutIdx = inputIndex++;
    }

    // Speech audio source: prefer ElevenLabs MP3 when supplied, else use Azure TTS from the avatar video
    const speechSrcIdx = elAudioIdx >= 0 ? elAudioIdx : avatarIdx;

    const fp: string[] = [];

    // ── 1. Background source ──
    if (bgImgIdx >= 0) {
      // AI-generated or user-supplied background image: scale to oversized, loop for duration
      fp.push(`[${bgImgIdx}:v]scale=${outW103}:${outH103}:force_original_aspect_ratio=increase,crop=${outW103}:${outH103},loop=loop=-1:size=1:start=0,setpts=PTS-STARTPTS,fps=30,trim=duration=${bgDur}[bg_raw]`);
    } else if (useGradient) {
      // rate=1: this gradient is static (no time-varying params) — one frame held/repeated
      // saves ~9 GB of redundant frame data vs rate=30 for a 45s video.
      fp.push(`gradients=s=${outW103}x${outH103}:type=linear:x0=0:y0=0:x1=${outW103}:y1=${outH103}:c0=${bgHex}:c1=${bg2Hex}:duration=${bgDur}:rate=1[bg_raw]`);
    } else {
      fp.push(`color=c=${bgHex}:s=${outW103}x${outH103}:r=1:d=${bgDur}[bg_raw]`);
    }

    // ── 2. Cinematic radial glow overlay — accent-colored "key light" behind avatar ──
    // Uses FFmpeg's native radial gradients source (efficient, no per-pixel math).
    // Centered at 50% width / 30% height (behind avatar's head area).
    const glowW = outW103;
    const glowH = outH103;
    const gcx = Math.round(glowW * 0.5);   // horizontal center
    const gcy = Math.round(glowH * 0.30);   // upper-third (head area)
    const gradRadius = Math.round(glowW * 0.75); // glow radius — wide, soft bloom
    // Glow blend intensity varies by mood
    const glowIntensity = backgroundStyle === "tech_gradient" ? 0.24
      : backgroundStyle === "creative_pop" ? 0.32
      : backgroundStyle === "warm_studio" ? 0.20
      : backgroundStyle === "corporate_sleek" ? 0.13
      : 0.18; // cinematic_dark
    fp.push(
      // Radial gradient: accent color at center fading to black at gradRadius
      `gradients=s=${glowW}x${glowH}:type=radial:x0=${gcx}:y0=${gcy}:x1=${gcx + gradRadius}:y1=${gcy}:c0=${accentHex}:c1=0x000000:duration=${bgDur}:rate=1[glow_src]`,
      // Screen-blend glow on top of background — adds light without clipping
      `[bg_raw][glow_src]blend=all_mode=screen:all_opacity=${glowIntensity}[bg_lit]`
    );

    // ── 3. Ken Burns effect on background (subtle 3% zoom + slow pan) ──
    if (realism) {
      fp.push(`[bg_lit]crop=${outW}:${outH}:x='min(iw-ow\\,(iw-ow)*t/${duration})':y='(ih-oh)/2'[bg_pre]`);
    } else {
      fp.push(`[bg_lit]crop=${outW}:${outH}:x='(iw-ow)/2':y='(ih-oh)/2'[bg_pre]`);
    }

    // ── 3b. Always-on ambient particles (T101) ──
    // Soft drifting bokeh in safe zones (avoids avatar face area). Adds energy
    // without distracting; runs on background BEFORE the avatar overlays so
    // the avatar always sits ON TOP of the particles.
    fp.push(...buildAmbientParticlesFilter(bgDur, outW, outH, isVertical, "bg_pre", "bg_par"));

    // ── 3c. Light-leak transitions at sentence boundaries (T102) ──
    // Soft warm radial bloom flashes at sentence ends. Blended via screen on
    // the BACKGROUND ONLY (before avatar overlay) so the avatar face is never
    // washed out. When no events, this is a single null-filter pass-through.
    const bgAfterLeaksLabel = beatPulseTimestamps.length > 0 ? "bg_leaked" : "bg";
    fp.push(...buildLightLeakFilters({
      events: leakEvents,
      leakInputIndices,
      totalDuration: duration,
      outW,
      outH,
      inputLabel: "bg_par",
      outputLabel: bgAfterLeaksLabel,
      opacity: 0.30,
      preWindowSec: 0.05,
      postWindowSec: 0.40,
    }));

    // ── 3d. Beat-synced background brightness pulses (T106) ──
    // Subtle +5% brightness flashes on detected music beats — applied to the
    // BACKGROUND LAYER ONLY (before avatar overlay) so the avatar face never
    // pulses. Skipped entirely when there are no beats (no music, detection
    // failed, or all beats fell inside intro/outro windows): in that case
    // step 3c already emits `[bg]` directly and we don't push another filter.
    if (beatPulseTimestamps.length > 0) {
      fp.push(...buildBeatPulseFilter(beatPulseTimestamps, "bg_leaked", "bg", {
        brightnessDelta: 0.05,
        preWindowSec: 0.02,
        postWindowSec: 0.10,
      }));
    }

    // ── 4. Avatar compositing ──
    let lastV = "av_framed";

    // Normalize avatar to 30fps CFR immediately — Azure delivers 25fps (sometimes VFR)
    // H.264 which causes timestamp mismatches when composited against 30fps backgrounds.
    // Without this, the avatar visual stutters ("robot dancing") while audio plays fine.
    // settb=AVTB resets the timebase so downstream setpts math stays accurate.
    fp.push(`[${avatarIdx}:v]fps=30,settb=AVTB[av_cfr]`);

    // If we need to retime the avatar to match ElevenLabs audio duration,
    // apply setpts BEFORE chromakey/scale so all downstream stages see the
    // retimed video. Otherwise reference the raw avatar input directly.
    let avSrc = "av_cfr";
    if (useRetime) {
      fp.push(`[av_cfr]setpts=PTS*${retimeRatio.toFixed(4)}[av_retimed]`);
      avSrc = "av_retimed";
      logger.info({ avatarDuration, elDuration, retimeRatio }, "Retiming avatar video to match ElevenLabs audio");
    }

    // Outro dimming (T105): when the outro card is active, the avatar fades
    // smoothly from 100% to 30% opacity over `fadeDur` starting at `startSec`.
    // Implementation: split `av_s` into two streams; full-opacity stream fades
    // OUT (1→0) while a 30%-alpha copy fades IN (0→0.3). Both overlay onto bg
    // in sequence — the sum yields a smooth 100%→30% ramp without any
    // per-pixel `geq` cost. Outside the fade window, only one of the two is
    // visible (av_a before, av_b after).
    const buildOverlay = (overlayExpr: string, withFormatAuto: boolean): void => {
      const fmt = withFormatAuto ? ":format=auto" : "";
      if (outroState.active) {
        const start = outroState.startSec.toFixed(3);
        const dur = outroState.fadeDur.toFixed(3);
        fp.push(`[av_s]split=2[av_a_src][av_b_src]`);
        fp.push(`[av_a_src]format=yuva420p,fade=t=out:st=${start}:d=${dur}:alpha=1[av_a_out]`);
        fp.push(`[av_b_src]format=yuva420p,colorchannelmixer=aa=0.3,fade=t=in:st=${start}:d=${dur}:alpha=1[av_b_in]`);
        fp.push(`[bg][av_a_out]overlay=${overlayExpr}${fmt}[av_step1]`);
        fp.push(`[av_step1][av_b_in]overlay=${overlayExpr}${fmt}[av_framed]`);
      } else {
        fp.push(`[bg][av_s]overlay=${overlayExpr}${fmt}[av_framed]`);
      }
    };

    if (useTransparentAvatar) {
      // Transparent WebM (VP9) — avatar already has a real alpha channel.
      // Skip chromakey/despill entirely; just scale and overlay. The overlay
      // filter respects source alpha by default, so edges are pixel-perfect
      // with no green halo. `format=yuva420p` keeps alpha through the scale.
      if (isVertical) {
        fp.push(`[${avSrc}]format=yuva420p,scale=-2:${outH}[av_tall]`);
        fp.push(`[av_tall]crop=${outW}:${outH}:(iw-${outW})/2:0[av_s]`);
        buildOverlay("0:0", true);
      } else {
        const avatarH = Math.round(outH * 0.88);
        const avatarY = outH - avatarH - 30;
        fp.push(`[${avSrc}]format=yuva420p,scale=-2:${avatarH}[av_s]`);
        buildOverlay(`(W-w)/2:${avatarY}`, true);
      }
    } else if (useGreenScreen) {
      // Green-screen + chroma key path (active in production).
      // Tuned for Azure's JPEG-compressed yuvj420p output: chroma subsampling
      // creates "almost green" pixels inside light clothing/fabric. We keep
      // similarity tight (0.20) to avoid punching holes, widen blend (0.12)
      // for softer silhouette edges, then blur ONLY the alpha plane
      // (planes=8 in yuva420p) so any remaining stair-stepping is smoothed
      // without softening the avatar's actual pixels. Lower despill mix
      // (0.4) preserves more natural skin/hair tone near the silhouette.
      fp.push(`[${avSrc}]format=yuva420p,chromakey=color=0x00ff00:similarity=0.20:blend=0.12[ck_pre]`);
      fp.push(`[ck_pre]despill=type=green:mix=0.4:expand=0[ck_dsp]`);
      fp.push(`[ck_dsp]gblur=sigma=1.5:steps=1:planes=8[ck_out]`);
      if (isVertical) {
        // Portrait output: Azure returns landscape (1920×1080). Scale to full output
        // height so the avatar fills the frame top-to-bottom, then center-crop to
        // output width. This prevents the "tiny box" regression where the avatar
        // only occupied the bottom 30% of the portrait frame.
        fp.push(`[ck_out]scale=-2:${outH}[av_tall]`);
        fp.push(`[av_tall]crop=${outW}:${outH}:(iw-${outW})/2:0[av_s]`);
        // format=auto so overlay honors the alpha channel produced by chromakey
        buildOverlay("0:0", true);
      } else {
        // Landscape output: scale avatar to 88% of output height and anchor to bottom
        const avatarH = Math.round(outH * 0.88);
        const avatarY = outH - avatarH - 30;
        fp.push(`[ck_out]scale=-2:${avatarH}[av_s]`);
        buildOverlay(`(W-w)/2:${avatarY}`, true);
      }
    } else {
      // Non-green-screen: scale avatar and overlay on background
      if (isVertical) {
        // Same cover approach: scale to full height, center-crop width
        fp.push(`[${avSrc}]scale=-2:${outH}[av_tall]`);
        fp.push(`[av_tall]crop=${outW}:${outH}:(iw-${outW})/2:0[av_s]`);
        buildOverlay("0:0", false);
      } else {
        fp.push(`[${avSrc}]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[av_s]`);
        buildOverlay("(W-w)/2:(H-h)/2", false);
      }
    }

    // ── 4. Color grade ──
    if (realism) {
      fp.push(`[${lastV}]eq=brightness=0.02:saturation=1.1:contrast=1.05[graded]`);
      lastV = "graded";
    }

    // ── 5. Subtle lower-third gradient (single very-soft layer) ──
    // Removed the second darker layer + the brand accent bar — both showed
    // as visible horizontal seams in the frame. Captions use BorderStyle=1
    // (outline+shadow, per spec) so they read against the avatar without
    // needing a heavy backing strip beneath them.
    const lt = lowerH;
    fp.push(`[${lastV}]drawbox=x=0:y=ih-${lt}:w=iw:h=${lt}:c=black@0.28:t=fill[with_lt]`);
    lastV = "with_lt";

    // ── 6. B-roll insertions (T203) ──
    // Each renderable resource produces a 3-filter chain that overlays
    // the cached Pexels clip onto the current scene during the segment
    // window. The base label is whatever lastV is right now (post lower-
    // third strip), and each chain feeds its output back into lastV so
    // multiple b-roll segments cascade naturally.
    //
    // Layering choice: B-roll sits ABOVE the lower-third drawbox + grade
    // (so PiP + fullscreen content reads cleanly without our color grade
    // re-shifting Pexels' already-graded footage), but BELOW the logo,
    // hook, captions, callouts, CTA, and outro card (so all branding /
    // text overlays remain visible during cutaways).
    //
    // Position: PiP always upper-left so it never collides with the top-
    // right logo pill or the bottom captions / outro card.
    //
    // Empty resource list → this block emits nothing → graph behavior
    // unchanged.
    for (let i = 0; i < renderableBroll.length; i++) {
      const r = renderableBroll[i];
      const inputIdx = brollInputIndices[i];
      const seg = r.segment;
      // Defensive clamp: never let the segment exceed the actual video
      // duration. enforceBudget already does this, but a second guard
      // here protects against any future caller skipping that step.
      const startSec = Math.max(0, Math.min(seg.startSec, duration));
      const endSec = Math.max(startSec + 0.1, Math.min(seg.endSec, duration));
      const outLabel = `with_broll_${i}`;
      // All b-roll modes render fullscreen: broll-fullscreen (Pexels),
      // broll-text (animated text MP4 from animatedTextService), and
      // legacy broll-pip (treated as fullscreen — PIP is disabled).
      fp.push(
        ...buildBrollFullscreenFilter({
          brollInputIdx: inputIdx,
          startSec,
          endSec,
          outW,
          outH,
          inputLabel: lastV,
          outputLabel: outLabel,
          uniqueTag: String(i),
        })
      );
      lastV = outLabel;
    }

    // ── 7. Logo — top-right with dark glass pill background ──
    // Captured here so the T104 large-logo overlay (end-of-chain) can size
    // the centered logo as `cornerMaxH × largeLogoScale`.
    let cornerMaxH = 0;
    // Label that downstream filters (corner pill chain + T104 large logo) will
    // consume for the logo source. When the intro sting is INACTIVE, the
    // corner logo overlays a still PNG with no fade — overlay handles single-
    // frame inputs natively, so we use [N:v] directly. When the intro sting
    // is ACTIVE, BOTH the corner logo (fade-in 1.3-1.6s) AND the large logo
    // (fade-in 0-0.4s, fade-out 1.0-1.4s) need to apply `fade=alpha=1` to the
    // logo stream. `fade` evaluates per source-frame PTS — a still PNG has
    // ONE frame at PTS=0, so `fade=t=in:st=0:d=0.4:alpha=1` resolves to
    // alpha=0 (start of fade) FOREVER, producing a fully-transparent logo.
    // Fix: loop the still frame into a 30fps multi-frame stream with proper
    // PTS, then split=2 so both fade chains can consume it independently.
    let logoLabelCorner = `${logoIdx}:v`;
    let logoLabelLarge = `${logoIdx}:v`;
    if (logoIdx >= 0 && introState.active) {
      fp.push(
        `[${logoIdx}:v]loop=loop=-1:size=1:start=0,settb=AVTB,setpts=N/30/TB,fps=30,format=rgba,split=2[logo_v_a][logo_v_b]`
      );
      logoLabelCorner = "logo_v_a";
      logoLabelLarge = "logo_v_b";
    }
    if (logoIdx >= 0) {
      // Constrain by BOTH width and height with aspect preservation. Brand
      // wordmarks are often very wide low-res strips (e.g. 204×41); the
      // previous "scale to 15% of width" rule made them render at ~33px
      // tall on a 1920px frame — invisible. With max-w + max-h +
      // force_original_aspect_ratio=decrease, a 4.98:1 wordmark on vertical
      // becomes 270×54, while a square logo becomes 154×154 — both legible.
      const maxW = isVertical ? Math.round(outW * 0.25) : Math.round(outW * 0.16);
      const maxH = isVertical ? Math.round(outH * 0.08) : Math.round(outH * 0.13);
      cornerMaxH = maxH; // captured for the T104 large-logo overlay
      const margin = isVertical ? Math.round(outW * 0.025) : Math.round(outW * 0.02);
      // ── Premium corner-chip chain (v2) ──
      //
      // Three problems fixed vs the previous chain:
      //
      //   (a) Halos around wordmark text — caused by `unsharp` at amount=0.5
      //       on already-upscaled lanczos output. lanczos is sharp enough on
      //       its own for the 1.3–1.6x typical upscale; the second sharpen
      //       was over-cooking edges. The pass is removed.
      //
      //   (b) Bright accent-color border clashed with brand-color pixels
      //       INSIDE the logo (e.g. cyan border around a cyan-on-black
      //       wordmark made the chip look like it was vibrating). Replaced
      //       with a subtle 1px hairline at 0x2A3340 — slightly lighter than
      //       the chip background — which reads as a clean glass edge on
      //       any backdrop without color competition.
      //
      //   (c) Sharp-cornered rectangle looked old. The padded rect now gets
      //       rounded corners via a `geq` alpha mask. Corner radius is ~14%
      //       of the chip height (clamped to a sane min/max) — matches the
      //       rounded-rect language used by the rest of the app UI.
      //
      // Padding is aspect-aware:
      //   - logoAspect ≤ 1.3 → square icon → symmetric breathing room
      //   - 1.3 < aspect ≤ 2.5 → balanced logo+text combos
      //   - aspect > 2.5 → wide wordmarks get tighter horizontal padding so
      //     the chip doesn't span half the frame
      let padX: number; let padY: number; let xOff: number; let yOff: number;
      if (logoAspect <= 1.3) {
        padX = 1.40; padY = 1.40; xOff = 0.20; yOff = 0.20;
      } else if (logoAspect <= 2.5) {
        padX = 1.22; padY = 1.55; xOff = 0.11; yOff = 0.275;
      } else {
        padX = 1.14; padY = 1.62; xOff = 0.07; yOff = 0.31;
      }
      fp.push(
        // Pure lanczos scale — no second-stage sharpen. format=rgba so the
        // pad stage can lay down the chip background underneath the alpha.
        `[${logoLabelCorner}]scale=w=${maxW}:h=${maxH}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd,format=rgba[logo_scaled]`
      );
      fp.push(
        // Glass chip background: 0x121A24 at F0 alpha (~94%) is dark enough
        // to anchor against a bright avatar yet still feels "lit" rather
        // than a cutout black hole.
        `[logo_scaled]pad=iw*${padX.toFixed(3)}:ih*${padY.toFixed(3)}:iw*${xOff.toFixed(3)}:ih*${yOff.toFixed(3)}:color=0x121A24F0[logo_padded]`
      );
      // Round the corners with a geq alpha mask. R = 14% of chip height,
      // clamped to [10, 24] px so it reads as a soft chip on both 1080p
      // landscape and 1080×1920 vertical without going overboard.
      const chipApproxH = Math.round(maxH * padY);
      const cornerR = Math.max(10, Math.min(24, Math.round(chipApproxH * 0.14)));
      // For each pixel, compute its distance from the nearest corner anchor.
      // A point is INSIDE the rounded rect iff: (dx² + dy²) ≤ R², where
      //   dx = R-X if X<R, else (X-(W-1-R) if X>W-1-R, else 0)
      //   dy = R-Y if Y<R, else (Y-(H-1-R) if Y>H-1-R, else 0)
      // Note: the previous formulation of this filter only kept pixels where
      // BOTH X and Y were within the corner band, which erased the long
      // straight edges of the chip and produced a "dumbbell" silhouette.
      fp.push(
        `[logo_padded]format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='if(lte(hypot(if(lt(X\\,${cornerR})\\,${cornerR}-X\\,if(gt(X\\,W-1-${cornerR})\\,X-(W-1-${cornerR})\\,0))\\,if(lt(Y\\,${cornerR})\\,${cornerR}-Y\\,if(gt(Y\\,H-1-${cornerR})\\,Y-(H-1-${cornerR})\\,0)))\\,${cornerR})\\,alpha(X\\,Y)\\,0)'[logo_rounded]`
      );
      // Subtle hairline edge — neutral lift, no brand-color competition.
      fp.push(
        `[logo_rounded]drawbox=x=0:y=0:w=iw:h=ih:color=0x2A334060:t=1[logo_pill]`
      );
      // T104 corner logo fade-in: when the intro sting is active, the corner
      // logo's alpha ramps 0→1 between 1.3s and 1.6s (synchronized with the
      // blackout fade-out), so it appears to "settle in" as the sting ends.
      // Otherwise overlay the pill chip directly with full alpha.
      const cornerFadeIn = buildCornerLogoFadeIn(introState, "logo_pill", "logo_pill_in");
      if (cornerFadeIn.length > 0) {
        fp.push(...cornerFadeIn);
        fp.push(`[${lastV}][logo_pill_in]overlay=W-w-${margin}:${margin}:format=auto[with_logo]`);
      } else {
        fp.push(`[${lastV}][logo_pill]overlay=W-w-${margin}:${margin}:format=auto[with_logo]`);
      }
      lastV = "with_logo";
    }

    // ── 8. Opening hook text (first sentence, 0-2s, top of frame) ──
    if (hookAssPath) {
      const escapedHook = hookAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escapedHook}'[with_hook]`);
      lastV = "with_hook";
    }

    // ── 9. Word captions (above lower-third center) ──
    if (captionAssPath) {
      const escaped = captionAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_caps]`);
      lastV = "with_caps";
    }

    // ── 9b. Numeric callouts (pop-in stat emphasis, off-axis from avatar) ──
    if (calloutsAssPath) {
      const escaped = calloutsAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_callouts]`);
      lastV = "with_callouts";
    }

    // ── 9c. Premium stat-popin (T204): multi-layer animated stat callouts ──
    // Sits above legacy T103 callouts in the chain (though they won't co-
    // occur — T204 windows are pre-filtered out of T103 above). Composition:
    // pill (scale-in) + count-up number + suffix pop + icon spin-in +
    // underline draw + 8-particle radial burst + hold + fade-out.
    if (statPopinAssPath) {
      const escaped = statPopinAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_statpop]`);
      lastV = "with_statpop";
    }

    // ── 10. CTA text in lower-third (only when outro card is NOT active) ──
    if (ctaAssPath) {
      const escaped = ctaAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_cta]`);
      lastV = "with_cta";
    }

    // ── 10b. Outro CTA card (T105): full-screen branded card in last ~2.5s ──
    // Vector ASS rectangle (\p1) filled with brand color + headline + URL with
    // \move slide-up + \fad. Avatar is already dimmed to 30% in the avatar
    // overlay step above; this card draws on top of the dimmed scene.
    if (outroCardAssPath) {
      const escaped = outroCardAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_outro]`);
      lastV = "with_outro";
    }

    // ── 10c. Intro sting (T104) ──
    // Order: BLACKOUT covers everything first (fades out at blackoutFadeEnd),
    // then the LARGE LOGO sits centred on top of the blackout (fades in/out
    // within the blackout window). When introState is inactive, all helpers
    // return [] and the chain is unchanged.
    if (introState.active && logoIdx >= 0 && blackoutIdx >= 0) {
      const blackoutFilters = buildBlackoutFilter(introState, blackoutIdx, lastV, "with_blackout");
      fp.push(...blackoutFilters);
      lastV = "with_blackout";

      const largeLogoFilters = buildLargeLogoFilters(
        introState,
        logoLabelLarge,
        outW,
        outH,
        cornerMaxH,
        lastV,
        "with_large_logo",
      );
      fp.push(...largeLogoFilters);
      lastV = "with_large_logo";

      // Swoosh removed — no longer applied to lastV.
    }

    // ── 11. Film grain — removed ──
    // noise=allf=t+u generates per-pixel random values every frame (~100M ops/sec).
    // Removed to keep render times fast; imperceptible on compressed social video.

    // ── 12. Cinematic fade in / fade out ──
    const fadeDur = 0.4;
    const fadeOutStart = Math.max(0, duration - fadeDur);
    fp.push(`[${lastV}]fade=t=in:st=0:d=${fadeDur},fade=t=out:st=${fadeOutStart}:d=${fadeDur}[faded]`);
    lastV = "faded";

    // ── 13. FPS normalize to exactly 30fps ──
    fp.push(`[${lastV}]fps=30[vout]`);

    // ── Audio chain ──
    // When ElevenLabs audio is supplied, use it as the speech source instead of the
    // avatar's Azure TTS track. (Azure no longer supports lip-sync to external audio,
    // so the avatar mouth movements follow Azure TTS, but the listener hears ElevenLabs.)
    const af: string[] = [];
    const musicFadeOut = Math.max(0, duration - 1.5);

    // Speech processing chain — TWO-PASS LOUDNORM + HIGHPASS.
    //
    // Pipeline order (Tier 1 polish):
    //   aformat → introMute → highpass(80Hz) → loudnorm
    //
    // - highpass=f=80: removes sub-voice rumble (<80Hz). Voice fundamentals
    //   start at ~85Hz (male) and ~165Hz (female), so 80Hz cuts only HVAC
    //   rumble / mic handling noise / room boom. K-weighted LUFS already
    //   discounts <100Hz, so adding highpass before the apply-pass shifts
    //   the final loudness by <0.1 LU — safely within tolerance.
    //
    // - aecho REMOVED (was: aecho=0.8:0.9:40:0.3 on Azure TTS only).
    //   The slap echo was a 90s-era trick to humanise dry TTS; modern
    //   broadcast voiceover is dry. measureLoudness is unaffected because
    //   it measures the raw source without any filters.
    //
    // Two-pass loudnorm:
    //   Pass 1 (already done above for measurement): print_format=json on
    //   the speech-only source to get accurate input_i/tp/lra/thresh/offset.
    //   Pass 2 (this filter chain): apply loudnorm with measured_* params
    //   and linear=true → lands within ±0.5 LU of target instead of ±2 LU.
    // If pass 1 failed for any reason (logged inside measureLoudness),
    // fall back to single-pass which still works, just less precisely.
    const isElSpeech = elAudioIdx >= 0;
    // Use the pre-measured loudness from above. If measurement succeeded,
    // emit a full two-pass loudnorm with measured_* params + linear=true;
    // otherwise emit single-pass (still works, just less precisely).
    const _t = _loudnessTarget;
    const loudnormFilter = measuredLoudness
      ? [
          `loudnorm=I=${_t.I}`,
          `TP=${_t.TP}`,
          `LRA=${_t.LRA}`,
          `measured_I=${measuredLoudness.measured_I}`,
          `measured_TP=${measuredLoudness.measured_TP}`,
          `measured_LRA=${measuredLoudness.measured_LRA}`,
          `measured_thresh=${measuredLoudness.measured_thresh}`,
          `offset=${measuredLoudness.offset}`,
          `linear=true`,
          `print_format=summary`,
        ].join(":")
      : `loudnorm=I=${_t.I}:TP=${_t.TP}:LRA=${_t.LRA}`;

    // When the intro sting is active AND using Azure TTS, silence speech during
    // the logo screen and ramp audio smoothly into full volume over the last
    // 100 ms of the blackout so there is no audible click/pop at the transition.
    //
    // For ElevenLabs (isElSpeech=true): the route handler already prepends
    // INTRO_BREAK_SEC seconds of silence to the EL audio file and shifts all
    // word timings by the same duration. The audio is therefore naturally silent
    // during the intro window — no additional mute filter needed.
    //
    // For Azure TTS (isElSpeech=false): the avatar SSML has a leading <break>
    // of the same duration, but the audio is still continuous. The mute + ramp
    // prevents any residual audio from leaking through the blackout.
    const rampStart = introState.active
      ? (introState.blackoutFadeEnd - 0.1).toFixed(3)
      : "0";
    const introMute = introState.active && !isElSpeech
      ? `,volume=0.0:enable='lt(t\\,${rampStart})',afade=t=in:st=${rampStart}:d=0.100`
      : "";
    const speechChain = isElSpeech
      ? `aformat=fltp:48000:stereo${introMute},highpass=f=80,${loudnormFilter}`
      : `aformat=fltp:44100:stereo${introMute},highpass=f=80,${loudnormFilter}`;

    // Sidechain ducking params (broadcast standard for VO under music):
    //   threshold=0.05  → ~-26 dBFS linear; speech reliably exceeds this
    //                     after loudnorm (peaks ~-1 dBTP, avg ~-23 LUFS)
    //   ratio=8         → ~6-8 dB attenuation while speech is present
    //   attack=5 ms     → fast clamp when a syllable starts
    //   release=250 ms  → smooth lift in pauses (no audible pumping)
    //   makeup=1        → no makeup gain (music returns to its 0.12 level)
    //   level_sc=1      → unity gain on the sidechain key signal
    // The asplit=2 tap of the speech bus into [speech_out, speech_key]
    // ensures the same post-loudnorm signal is BOTH heard AND used to key
    // the ducker — so the ducker is calibrated against LUFS-normalized
    // speech regardless of source (Azure or ElevenLabs).
    const SIDECHAIN_PARAMS = "threshold=0.05:ratio=8:attack=5:release=250:makeup=1:level_sc=1";
    // Music bed chain (user-locked: "music + voice both clearly audible, no
    // disturbance"). Order matters — applied left to right:
    //
    //   aformat=fltp:48000:stereo  → match speech sample rate / channel layout
    //                                so amix below has zero resampling cost
    //   lowpass=f=6000              → KILLS the "typing/clicking" sound the
    //                                 user reported. The lo-fi music tracks
    //                                 contain hi-hat / shaker / cassette
    //                                 percussion in 4–10 kHz which, at low
    //                                 volume under speech, sound exactly like
    //                                 keyboard taps (same band as consonant
    //                                 sibilants). 6 kHz cutoff preserves the
    //                                 musical body (bass + melody + pads all
    //                                 live below 6 kHz) and discards the
    //                                 distracting transients. Standard
    //                                 broadcast technique for VO music beds.
    //   volume=0.15                 → top of user-locked 10–15% range. Now
    //                                 safe to be slightly louder because
    //                                 lowpass removed the harsh frequencies
    //                                 that fight speech sibilants. Sidechain
    //                                 below still ducks ~6–8 dB under speech
    //                                 so voice always wins.
    //   afade in/out                → 2 s quartic fade-in at start + 2 s
    //                                 fade-out at end so music doesn't pop
    //                                 in/out abruptly.
    const MUSIC_BED_CHAIN = `aformat=fltp:48000:stereo,lowpass=f=6000,volume=0.15,afade=t=in:st=0:d=2:curve=qua,afade=t=out:st=${musicFadeOut}:d=2:curve=qua`;

    if (musicIdx >= 0) {
      if (realism) {
        af.push(
          `[${speechSrcIdx}:a]${speechChain}[speech_e]`,
          `[speech_e]asplit=2[speech_out][speech_key]`,
          `[${musicIdx}:a]${MUSIC_BED_CHAIN}[bg_music]`,
          `[bg_music][speech_key]sidechaincompress=${SIDECHAIN_PARAMS}[bg_music_ducked]`,
          `[speech_out][bg_music_ducked]amix=inputs=2:duration=first:normalize=0[aout]`
        );
      } else {
        af.push(
          `[${speechSrcIdx}:a]aformat=fltp:48000:stereo,volume=1.0[speech]`,
          `[speech]asplit=2[speech_out][speech_key]`,
          `[${musicIdx}:a]${MUSIC_BED_CHAIN}[bg_music]`,
          `[bg_music][speech_key]sidechaincompress=${SIDECHAIN_PARAMS}[bg_music_ducked]`,
          `[speech_out][bg_music_ducked]amix=inputs=2:duration=first:normalize=0[aout]`
        );
      }
    } else {
      if (realism) {
        af.push(`[${speechSrcIdx}:a]${speechChain}[aout]`);
      } else {
        af.push(`[${speechSrcIdx}:a]aformat=fltp:48000:stereo[aout]`);
      }
    }

    const fullFilter = [...fp, ...af].join(";");
    logger.info({ fullFilter }, "FFmpeg filter graph");

    const outputOptions = [
      "-map [vout]",
      "-map [aout]",
      `-t ${duration}`,
      "-c:v libx264",
      // veryfast: significantly lower CPU and memory vs fast, acceptable quality for
      // short social clips. CRF=18 still drives quality; preset mainly affects
      // motion-estimation buffer size (veryfast = much smaller).
      "-preset veryfast",
      "-crf 18",
      // Hard bitrate ceiling per project spec (4000kbps). Also caps VBV buffer memory.
      "-maxrate 4000k",
      "-bufsize 8000k",
      "-profile:v high",
      "-level 4.1",
      "-g 60",
      "-keyint_min 60",
      "-sc_threshold 0",
      // 4 threads — matches the 4-vCPU Cloud Run machine configuration.
      "-threads 4",
      "-c:a aac",
      "-b:a 192k",
      "-ar 48000",
      "-movflags +faststart",
      "-pix_fmt yuv420p",
    ];

    cmd
      .complexFilter(fullFilter)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on("start", (cmdLine) => logger.info({ cmdLine }, "FFmpeg started"))
      .on("progress", (p) => logger.info({ percent: p.percent }, "FFmpeg progress"))
      .on("end", () => { logger.info({ outputPath }, "FFmpeg done"); resolve(outputPath); })
      .on("error", (err, _stdout, stderr) => {
        logger.error({ err, stderr }, "FFmpeg error");
        reject(new Error(`FFmpeg failed: ${err.message}\n${stderr ?? ""}`));
      })
      .run();
  });
}
