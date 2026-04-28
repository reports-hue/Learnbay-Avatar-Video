import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import { logger } from "../lib/logger.js";
import type { WordTiming } from "./speech.js";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, "../assets");
const outputsDir = path.resolve(__dirname, "../outputs");

const VERTICAL_PLATFORMS = new Set([
  "YouTube Shorts",
  "Instagram Reels",
  "Facebook Reels",
]);

export type CaptionStyle = "none" | "animated" | "static";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function getDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
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

// RGB hex → ASS &HBBGGRR& color string
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

// ─────────────────────────────────────────────
// CTA subtitle (bottom lower-third text)
// ─────────────────────────────────────────────
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
  const fontSize = h >= 1080 ? 52 : 38;
  const marginV = Math.round(lowerH * 0.35);
  const accentAss = toAssColor(accentColor);
  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CTA,Arial,${fontSize},&H00FFFFFF,${accentAss},&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,2.5,0,2,28,28,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,${endTime},CTA,,0,0,0,,${cta}
`;
  await fs.writeFile(outputPath, content, "utf8");
}

// ─────────────────────────────────────────────
// Animated word-by-word captions (HeyGen-style)
// ─────────────────────────────────────────────
async function generateAnimatedCaptionsAss(
  wordTimings: WordTiming[],
  outputPath: string,
  w: number,
  h: number,
  accentColor: string,
  lowerH: number
): Promise<void> {
  const isVertical = h > w;
  const fontSize = isVertical ? 72 : 56;
  // Position captions in center-lower area (above lower-third)
  const captionY = h - lowerH - (isVertical ? 180 : 140);
  const accentAss = toAssColor(accentColor);
  const WINDOW = 4; // words visible at a time

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,${fontSize},&H00FFFFFF,${accentAss},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3.0,1.5,5,20,20,${captionY},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];

  for (let i = 0; i < wordTimings.length; i++) {
    const wt = wordTimings[i];
    const nextWt = wordTimings[i + 1];
    const startTime = formatAssTime(Math.max(0, wt.startSec));
    const endTime = nextWt
      ? formatAssTime(nextWt.startSec)
      : formatAssTime(wt.startSec + wt.durationSec + 0.25);

    // Build sliding window of words
    const windowStart = Math.max(0, i - (WINDOW - 1));
    const windowWords = wordTimings.slice(windowStart, i + 1);

    const line = windowWords.map((w2, idx) => {
      const isActive = windowStart + idx === i;
      if (isActive) {
        // Current word: accent color, bold, slightly larger
        return `{\\c${accentAss}&\\b1\\fscx110\\fscy110}${w2.word}{\\c&H00FFFFFF&\\b0\\fscx100\\fscy100}`;
      }
      return `{\\c&H00FFFFFF&\\b0}${w2.word}`;
    }).join(" ");

    events.push(`Dialogue: 0,${startTime},${endTime},Cap,,0,0,0,,${line}`);
  }

  await fs.writeFile(outputPath, header + events.join("\n") + "\n", "utf8");
}

// ─────────────────────────────────────────────
// Static captions from word timings (3-word lines)
// ─────────────────────────────────────────────
async function generateStaticCaptionsAss(
  wordTimings: WordTiming[],
  outputPath: string,
  w: number,
  h: number,
  lowerH: number
): Promise<void> {
  const isVertical = h > w;
  const fontSize = isVertical ? 62 : 48;
  const captionY = h - lowerH - (isVertical ? 160 : 120);
  const CHUNK = 4;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,3.0,1.5,5,20,20,${captionY},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  for (let i = 0; i < wordTimings.length; i += CHUNK) {
    const chunk = wordTimings.slice(i, i + CHUNK);
    const start = formatAssTime(chunk[0].startSec);
    const lastWord = chunk[chunk.length - 1];
    const end = i + CHUNK < wordTimings.length
      ? formatAssTime(wordTimings[i + CHUNK].startSec)
      : formatAssTime(lastWord.startSec + lastWord.durationSec + 0.2);
    const text = chunk.map((w) => w.word).join(" ");
    events.push(`Dialogue: 0,${start},${end},Cap,,0,0,0,,${text}`);
  }

  await fs.writeFile(outputPath, header + events.join("\n") + "\n", "utf8");
}

// ─────────────────────────────────────────────
// Main post-processing
// ─────────────────────────────────────────────
export interface PostProcessOptions {
  platform?: string;
  logoUrl?: string;
  primaryColor?: string;
  backgroundColor?: string;
  gradientColor2?: string;
  cta?: string;
  musicPath?: string;
  wordTimings?: WordTiming[];
  captionStyle?: CaptionStyle;
  outputFilename?: string;
}

export async function postProcessAvatarVideo(
  avatarVideoPath: string,
  options: PostProcessOptions = {}
): Promise<string> {
  const outputPath = path.join(outputsDir, options.outputFilename ?? "final.mp4");
  const duration = await getDuration(avatarVideoPath);
  const isVertical = VERTICAL_PLATFORMS.has(options.platform ?? "");

  const outW = isVertical ? 1080 : 1920;
  const outH = isVertical ? 1920 : 1080;
  const lowerH = Math.round(outH * 0.22);
  const barH = isVertical ? 5 : 4;

  const bgHex = toFFmpegHex((options.backgroundColor ?? "#000000FF").slice(0, 7));
  const bg2Hex = options.gradientColor2 ? toFFmpegHex(options.gradientColor2) : null;
  const accentHex = toFFmpegHex(options.primaryColor ?? "#4A9FFF");
  const accentColor = options.primaryColor ?? "#4A9FFF";
  const useGradient = bg2Hex !== null;

  // ── Resolve logo ──
  let logoPath: string | null = null;
  if (options.logoUrl) {
    try {
      const dlPath = path.join(outputsDir, "logo_dl.png");
      await downloadUrl(options.logoUrl, dlPath);
      logoPath = dlPath;
    } catch { logger.warn("Logo download failed, skipping"); }
  }
  if (!logoPath) {
    const builtinLogo = path.join(assetsDir, "logo.png");
    if (existsSync(builtinLogo)) logoPath = builtinLogo;
  }

  // ── Resolve music ──
  const musicAssetPath = path.join(assetsDir, "music.mp3");
  const musicPath = options.musicPath ?? (existsSync(musicAssetPath) ? musicAssetPath : null);

  // ── CTA subtitle file ──
  let ctaAssPath: string | null = null;
  if (options.cta) {
    ctaAssPath = path.join(outputsDir, "cta.ass");
    await generateCtaAssFile(options.cta, ctaAssPath, duration, outW, outH, accentColor, lowerH);
  }

  // ── Caption subtitle file ──
  let captionAssPath: string | null = null;
  const captionStyle = options.captionStyle ?? "animated";
  const wordTimings = options.wordTimings ?? [];

  if (captionStyle !== "none" && wordTimings.length > 0) {
    captionAssPath = path.join(outputsDir, "captions.ass");
    if (captionStyle === "animated") {
      await generateAnimatedCaptionsAss(wordTimings, captionAssPath, outW, outH, accentColor, lowerH);
    } else {
      await generateStaticCaptionsAss(wordTimings, captionAssPath, outW, outH, lowerH);
    }
    logger.info({ captionStyle, wordCount: wordTimings.length }, "Caption ASS file generated");
  }

  logger.info({ platform: options.platform, isVertical, outW, outH, useGradient, bgHex, bg2Hex, accentHex, captionStyle, duration }, "Post-processing avatar video");

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();
    let inputIndex = 0;

    cmd = cmd.input(avatarVideoPath);
    const avatarIdx = inputIndex++;

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

    const fp: string[] = [];

    // ── 1. Background: gradient or flat ──
    if (useGradient) {
      const dur = Math.ceil(duration) + 2;
      if (isVertical) {
        fp.push(`gradients=s=${outW}x${outH}:type=linear:x0=${outW / 2}:y0=0:x1=${outW / 2}:y1=${outH}:c0=${bgHex}:c1=${bg2Hex}:duration=${dur}:rate=30[grad_bg]`);
        fp.push(`[${avatarIdx}:v]scale=${outW}:-2[av_s]`);
        fp.push(`[grad_bg][av_s]overlay=(W-w)/2:(H-h)*3/5[av_framed]`);
      } else {
        fp.push(`gradients=s=${outW}x${outH}:type=linear:x0=0:y0=0:x1=${outW}:y1=${outH}:c0=${bgHex}:c1=${bg2Hex}:duration=${dur}:rate=30[grad_bg]`);
        fp.push(`[${avatarIdx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[av_s]`);
        fp.push(`[grad_bg][av_s]overlay=(W-w)/2:(H-h)/2[av_framed]`);
      }
    } else {
      if (isVertical) {
        fp.push(
          `[${avatarIdx}:v]scale=${outW}:-2[av_s]`,
          `[av_s]pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)*3/5:color=${bgHex}[av_framed]`
        );
      } else {
        fp.push(
          `[${avatarIdx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=${bgHex}[av_framed]`
        );
      }
    }

    let lastV = "av_framed";

    // ── 2. Cinematic: slight sharpen + vignette ──
    fp.push(`[${lastV}]unsharp=5:5:0.8:5:5:0[sharpened]`);
    lastV = "sharpened";
    fp.push(`[${lastV}]vignette=PI/5:0.8[vignetted]`);
    lastV = "vignetted";

    // ── 3. Professional lower-third (two-layer dark overlay) ──
    const lt = lowerH;
    const lt2 = Math.round(lt * 0.55);
    fp.push(`[${lastV}]drawbox=x=0:y=ih-${lt}:w=iw:h=${lt}:c=black@0.52:t=fill[with_lt1]`);
    fp.push(`[with_lt1]drawbox=x=0:y=ih-${lt2}:w=iw:h=${lt2}:c=black@0.22:t=fill[with_lt]`);
    lastV = "with_lt";

    // ── 4. Brand accent line above lower-third ──
    fp.push(`[${lastV}]drawbox=x=0:y=ih-${lt + barH}:w=iw:h=${barH}:c=${accentHex}:t=fill[with_bar]`);
    lastV = "with_bar";

    // ── 5. Logo — top-right ──
    if (logoIdx >= 0) {
      const logoW = isVertical ? Math.round(outW * 0.18) : Math.round(outW * 0.10);
      const pad = isVertical ? 22 : 16;
      fp.push(`[${logoIdx}:v]scale=${logoW}:-1[logo_s]`);
      fp.push(`[${lastV}][logo_s]overlay=W-w-${pad}:${pad}[with_logo]`);
      lastV = "with_logo";
    }

    // ── 6. Word captions (above lower-third center area) ──
    if (captionAssPath) {
      const escaped = captionAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_caps]`);
      lastV = "with_caps";
    }

    // ── 7. CTA text in lower-third ──
    if (ctaAssPath) {
      const escaped = ctaAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_cta]`);
      lastV = "with_cta";
    }

    // ── 8. Cinematic fade in / fade out ──
    const fadeDur = 0.4;
    const fadeOutStart = Math.max(0, duration - fadeDur);
    fp.push(
      `[${lastV}]fade=t=in:st=0:d=${fadeDur},fade=t=out:st=${fadeOutStart}:d=${fadeDur}[faded]`
    );
    lastV = "faded";

    // ── 9. FPS normalize ──
    fp.push(`[${lastV}]fps=30[vout]`);

    // ── Audio chain ──
    const af: string[] = [];
    if (musicIdx >= 0) {
      af.push(
        `[${avatarIdx}:a]aformat=fltp:44100:stereo,volume=1.0[speech]`,
        `[${musicIdx}:a]aformat=fltp:44100:stereo,volume=0.07[bg_music]`,
        `[speech][bg_music]amix=inputs=2:duration=first[aout]`
      );
    } else {
      af.push(`[${avatarIdx}:a]aformat=fltp:44100:stereo[aout]`);
    }

    const fullFilter = [...fp, ...af].join(";");
    logger.info({ fullFilter }, "FFmpeg filter graph");

    const outputOptions = [
      "-map [vout]",
      "-map [aout]",
      `-t ${duration}`,
      "-c:v libx264",
      "-preset fast",
      "-crf 20",
      "-c:a aac",
      "-b:a 128k",
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
