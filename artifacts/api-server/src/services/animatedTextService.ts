/**
 * Animated Text Screen Generator (TYPE 1 b-roll — "broll-text" mode)
 *
 * Creates short H.264 MP4 clips with a dark navy background and a large
 * centered glowing white key phrase — the classic YouTube Shorts animated
 * text card style (e.g. "Agentic AI" with glow rings).
 *
 * Generation is pure FFmpeg lavfi (no canvas / Puppeteer). Results are
 * cached by content hash so re-renders for the same phrase are instant.
 * Cache lives in outputs/cache/anim_text/.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { createHash } from "crypto";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

export interface AnimatedTextOptions {
  /** Key phrase to display (2–5 words from the script). */
  text: string;
  /** Clip duration in seconds. Typically 4–8 s. */
  durationSec: number;
  /** Output width in pixels (1080 for portrait, 1920 for landscape). */
  width: number;
  /** Output height in pixels (1920 for portrait, 1080 for landscape). */
  height: number;
  /** Brand accent hex colour for glow (e.g. "#4A9FFF"). Default "#4488ff". */
  accentColor?: string;
  /** Cache directory for generated clips. */
  cacheDir: string;
}

/** Escape a key phrase for safe use inside an FFmpeg drawtext option value. */
function escapeDrawText(s: string): string {
  return s
    .replace(/\\/g, "\\\\") // backslash first
    .replace(/'/g, "\\'");  // single-quote → \'
}

/**
 * Generate a professional animated text screen clip.
 * Returns the output MP4 file path on success, or null on failure (non-fatal).
 */
export async function generateAnimatedTextClip(
  opts: AnimatedTextOptions
): Promise<string | null> {
  const { text, durationSec, width, height, accentColor = "#4488ff", cacheDir } = opts;

  const key = createHash("sha256")
    .update(`${text}|${durationSec.toFixed(2)}|${width}|${height}|${accentColor}`)
    .digest("hex")
    .slice(0, 20);

  await mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `anim_text_${key}.mp4`);

  if (existsSync(outPath)) {
    logger.info({ key, text: text.slice(0, 40) }, "Animated text clip: cache hit");
    return outPath;
  }

  // Font size relative to the shorter dimension so it scales for both
  // portrait (1080×1920) and landscape (1920×1080).
  const shortSide = Math.min(width, height);
  const fontSize = Math.round(shortSide * 0.09);

  const escapedText = escapeDrawText(text);
  const fontFile = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";
  const accent = accentColor.replace(/^#/, "");

  // Fade durations — 0.5 s in / 0.5 s out (clamped to clip length)
  const fadeInDur  = Math.min(0.5, durationSec * 0.10).toFixed(2);
  const fadeOutSt  = Math.max(durationSec - 0.6, durationSec * 0.85).toFixed(2);
  const fadeOutDur = (durationSec - parseFloat(fadeOutSt)).toFixed(2);

  /** Build one drawtext layer. */
  const dt = (
    hexColor: string,
    alpha: number,
    shadowX: number,
    shadowY: number,
    shadowAlpha: number
  ) =>
    `drawtext=text='${escapedText}':fontfile='${fontFile}':fontsize=${fontSize}:` +
    `fontcolor=0x${hexColor}@${alpha}:` +
    `shadowcolor=0x${accent}@${shadowAlpha}:shadowx=${shadowX}:shadowy=${shadowY}:` +
    `x=(w-text_w)/2:y=(h-text_h)/2`;

  // Four drawtext layers from outermost glow → crisp main text:
  //   1. Wide soft accent glow
  //   2. Mid accent glow
  //   3. Tight blue-white inner glow
  //   4. Crisp white text (small drop shadow)
  const vf = [
    dt(accent,    0.12, 20, 20, 0.15),
    dt(accent,    0.22, 10, 10, 0.28),
    dt("ccddff",  0.50,  5,  5, 0.45),
    dt("ffffff",  1.00,  3,  3, 0.65),
    `fade=t=in:st=0:d=${fadeInDur}`,
    `fade=t=out:st=${fadeOutSt}:d=${fadeOutDur}`,
  ].join(",");

  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=0x080c14:size=${width}x${height}:rate=30:duration=${durationSec.toFixed(2)}`,
    "-vf", vf,
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", "fast",
    "-pix_fmt", "yuv420p",
    "-an",
    outPath,
  ];

  try {
    await execFileAsync("ffmpeg", args, { timeout: 60_000 });
    logger.info({ text: text.slice(0, 40), durationSec, width, height }, "Animated text clip generated");
    return outPath;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, text: text.slice(0, 40) },
      "Animated text clip generation failed"
    );
    return null;
  }
}
