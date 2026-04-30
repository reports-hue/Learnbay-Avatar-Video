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

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

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
async function generateAnimatedCaptionsAss(
  wordTimings: WordTiming[],
  outputPath: string,
  w: number,
  h: number,
  accentColor: string,
  lowerH: number
): Promise<void> {
  const isVertical = h > w;
  const baseFontSize = isVertical ? 52 : 42;
  const activeFontSize = isVertical ? 58 : 46;
  const captionY = h - lowerH - (isVertical ? 160 : 120);
  const accentAss = toAssColor(accentColor);
  const WINDOW = 3; // max 3 words at a time

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,${baseFontSize},&H00FFFFFF,${accentAss},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,3,5,40,40,${captionY},1

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

    const windowStart = Math.max(0, i - (WINDOW - 1));
    const windowWords = wordTimings.slice(windowStart, i + 1);

    const line = windowWords.map((w2, idx) => {
      const isActive = windowStart + idx === i;
      if (isActive) {
        return `{\\c${accentAss}&\\b1\\fs${activeFontSize}\\shad1}${w2.word}{\\c&H00FFFFFF&\\b0\\fs${baseFontSize}\\shad0}`;
      }
      return `{\\c&H00FFFFFF&\\b0\\fs${baseFontSize}}${w2.word}`;
    }).join(" ");

    events.push(`Dialogue: 0,${startTime},${endTime},Cap,,0,0,0,,${line}`);
  }

  await fs.writeFile(outputPath, header + events.join("\n") + "\n", "utf8");
}

// Static captions: 3-word chunks with pill background
async function generateStaticCaptionsAss(
  wordTimings: WordTiming[],
  outputPath: string,
  w: number,
  h: number,
  lowerH: number
): Promise<void> {
  const isVertical = h > w;
  const fontSize = isVertical ? 54 : 42;
  const captionY = h - lowerH - (isVertical ? 140 : 110);
  const CHUNK = 3;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,3,5,40,40,${captionY},1

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
  realism?: boolean;        // default true — enables chroma key, grain, Ken Burns, enhanced audio
  script?: string;          // used for opening hook text
  elAudioPath?: string;     // local path to ElevenLabs MP3 — when set, replaces the avatar's Azure TTS audio
}

export async function postProcessAvatarVideo(
  avatarVideoPath: string,
  options: PostProcessOptions = {}
): Promise<string> {
  const outputPath = path.join(outputsDir, options.outputFilename ?? "final.mp4");
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
  const useGreenScreen = options.useGreenScreen === true;

  const outW = isVertical ? 1080 : 1920;
  const outH = isVertical ? 1920 : 1080;
  const lowerH = Math.round(outH * 0.22);
  const barH = isVertical ? 5 : 4;

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

  // ── ASS files ──
  let ctaAssPath: string | null = null;
  if (options.cta) {
    ctaAssPath = path.join(outputsDir, "cta.ass");
    await generateCtaAssFile(options.cta, ctaAssPath, duration, outW, outH, accentColor, lowerH);
  }

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
    logger.info({ captionStyle, wordCount: wordTimings.length }, "Caption ASS generated");
  }

  // ── Opening hook text ASS ──
  let hookAssPath: string | null = null;
  if (options.script && realism) {
    hookAssPath = path.join(outputsDir, "hook.ass");
    await generateHookAssFile(options.script, hookAssPath, outW, outH, accentColor);
  }

  const bgImagePath = options.bgImagePath && existsSync(options.bgImagePath) ? options.bgImagePath : null;
  const elAudioPath = options.elAudioPath && existsSync(options.elAudioPath) ? options.elAudioPath : null;

  logger.info({ platform: options.platform, isVertical, outW, outH, useGreenScreen, useGradient, hasBgImage: !!bgImagePath, hasElAudio: !!elAudioPath, realism, captionStyle, avatarDuration, elDuration, retimeRatio: useRetime ? retimeRatio : 1, duration }, "Post-processing avatar video");

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

    // Speech audio source: prefer ElevenLabs MP3 when supplied, else use Azure TTS from the avatar video
    const speechSrcIdx = elAudioIdx >= 0 ? elAudioIdx : avatarIdx;

    const fp: string[] = [];

    // ── 1. Background source ──
    if (bgImgIdx >= 0) {
      // AI-generated or user-supplied background image: scale to oversized, loop for duration
      fp.push(`[${bgImgIdx}:v]scale=${outW103}:${outH103}:force_original_aspect_ratio=increase,crop=${outW103}:${outH103},loop=loop=-1:size=1:start=0,setpts=PTS-STARTPTS,fps=30,trim=duration=${bgDur}[bg_raw]`);
    } else if (useGradient) {
      fp.push(`gradients=s=${outW103}x${outH103}:type=linear:x0=0:y0=0:x1=${outW103}:y1=${outH103}:c0=${bgHex}:c1=${bg2Hex}:duration=${bgDur}:rate=30[bg_raw]`);
    } else {
      fp.push(`color=c=${bgHex}:s=${outW103}x${outH103}:r=30:d=${bgDur}[bg_raw]`);
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
      fp.push(`[bg_lit]crop=${outW}:${outH}:x='min(iw-ow\\,(iw-ow)*t/${duration})':y='(ih-oh)/2'[bg]`);
    } else {
      fp.push(`[bg_lit]crop=${outW}:${outH}:x='(iw-ow)/2':y='(ih-oh)/2'[bg]`);
    }

    // ── 3. Avatar compositing ──
    let lastV = "av_framed";

    // If we need to retime the avatar to match ElevenLabs audio duration,
    // apply setpts BEFORE chromakey/scale so all downstream stages see the
    // retimed video. Otherwise reference the raw avatar input directly.
    let avSrc = `${avatarIdx}:v`;
    if (useRetime) {
      fp.push(`[${avatarIdx}:v]setpts=PTS*${retimeRatio.toFixed(4)}[av_retimed]`);
      avSrc = "av_retimed";
      logger.info({ avatarDuration, elDuration, retimeRatio }, "Retiming avatar video to match ElevenLabs audio");
    }

    if (useGreenScreen) {
      fp.push(`[${avSrc}]chromakey=color=0x00ff00:similarity=0.30:blend=0.10[ck_pre]`);
      fp.push(`[ck_pre]despill=type=green:mix=0.5:expand=0[ck_out]`);
      if (isVertical) {
        // Portrait output: Azure returns landscape (1920×1080). Scale to full output
        // height so the avatar fills the frame top-to-bottom, then center-crop to
        // output width. This prevents the "tiny box" regression where the avatar
        // only occupied the bottom 30% of the portrait frame.
        fp.push(`[ck_out]scale=-2:${outH}[av_tall]`);
        fp.push(`[av_tall]crop=${outW}:${outH}:(iw-${outW})/2:0[av_s]`);
        fp.push(`[bg][av_s]overlay=0:0[av_framed]`);
      } else {
        // Landscape output: scale avatar to 88% of output height and anchor to bottom
        const avatarH = Math.round(outH * 0.88);
        const avatarY = outH - avatarH - 30;
        fp.push(`[ck_out]scale=-2:${avatarH}[av_s]`);
        fp.push(`[bg][av_s]overlay=(W-w)/2:${avatarY}[av_framed]`);
      }
    } else {
      // Non-green-screen: scale avatar and overlay on background
      if (isVertical) {
        // Same cover approach: scale to full height, center-crop width
        fp.push(`[${avSrc}]scale=-2:${outH}[av_tall]`);
        fp.push(`[av_tall]crop=${outW}:${outH}:(iw-${outW})/2:0[av_s]`);
        fp.push(`[bg][av_s]overlay=0:0[av_framed]`);
      } else {
        fp.push(`[${avSrc}]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[av_s]`);
        fp.push(`[bg][av_s]overlay=(W-w)/2:(H-h)/2[av_framed]`);
      }
    }

    // ── 4. Color grade + cinematic sharpening ──
    if (realism) {
      fp.push(`[${lastV}]eq=brightness=0.02:saturation=1.1:contrast=1.05[graded]`);
      fp.push(`[graded]unsharp=3:3:0.6:3:3:0.0[sharpened]`);
      fp.push(`[sharpened]vignette=PI/6:0.8[vignetted]`);
      lastV = "vignetted";
    } else {
      fp.push(`[${lastV}]unsharp=5:5:0.8:5:5:0[sharpened]`);
      fp.push(`[sharpened]vignette=PI/5:0.8[vignetted]`);
      lastV = "vignetted";
    }

    // ── 5. Professional lower-third (two-layer dark overlay) ──
    const lt = lowerH;
    const lt2 = Math.round(lt * 0.55);
    fp.push(`[${lastV}]drawbox=x=0:y=ih-${lt}:w=iw:h=${lt}:c=black@0.52:t=fill[with_lt1]`);
    fp.push(`[with_lt1]drawbox=x=0:y=ih-${lt2}:w=iw:h=${lt2}:c=black@0.22:t=fill[with_lt]`);
    lastV = "with_lt";

    // ── 6. Brand accent line above lower-third ──
    fp.push(`[${lastV}]drawbox=x=0:y=ih-${lt + barH}:w=iw:h=${barH}:c=${accentHex}:t=fill[with_bar]`);
    lastV = "with_bar";

    // ── 7. Logo — top-right with dark glass pill background ──
    if (logoIdx >= 0) {
      const logoW = isVertical ? Math.round(outW * 0.15) : Math.round(outW * 0.09);
      const margin = isVertical ? 24 : 18;
      const hPad = 18; // horizontal padding inside pill
      const vPad = 12; // vertical padding inside pill
      // Scale logo, preserve alpha, add semi-transparent dark padding (pill background)
      fp.push(`[${logoIdx}:v]scale=${logoW}:-1,format=rgba[logo_raw]`);
      fp.push(`[logo_raw]pad=iw+${hPad * 2}:ih+${vPad * 2}:${hPad}:${vPad}:color=0x000000B0[logo_pill]`);
      fp.push(`[${lastV}][logo_pill]overlay=W-w-${margin}:${margin}:format=auto[with_logo]`);
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

    // ── 10. CTA text in lower-third ──
    if (ctaAssPath) {
      const escaped = ctaAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_cta]`);
      lastV = "with_cta";
    }

    // ── 11. Film grain (after all overlays, for organic texture) ──
    if (realism) {
      fp.push(`[${lastV}]noise=alls=4:allf=t+u[grained]`);
      lastV = "grained";
    }

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

    // Speech processing chain.
    // ElevenLabs is studio-mastered audio: skip the artificial room "aecho"
    // (it was only there to humanise dry Azure TTS) and use a lighter
    // loudnorm pass so we don't squash the existing dynamics.
    const isElSpeech = elAudioIdx >= 0;
    const speechChain = isElSpeech
      ? `aformat=fltp:48000:stereo,loudnorm=I=-14:TP=-1.0:LRA=9`
      : `aformat=fltp:44100:stereo,loudnorm=I=-16:TP=-1.5:LRA=11,aecho=0.8:0.9:40:0.3`;

    if (musicIdx >= 0) {
      if (realism) {
        af.push(
          `[${speechSrcIdx}:a]${speechChain}[speech_e]`,
          `[${musicIdx}:a]aformat=fltp:48000:stereo,volume=0.06,afade=t=in:st=0:d=1:curve=qua,afade=t=out:st=${musicFadeOut}:d=1.5:curve=qua[bg_music]`,
          `[speech_e][bg_music]amix=inputs=2:duration=first:normalize=0[aout]`
        );
      } else {
        af.push(
          `[${speechSrcIdx}:a]aformat=fltp:48000:stereo,volume=1.0[speech]`,
          `[${musicIdx}:a]aformat=fltp:48000:stereo,volume=0.07[bg_music]`,
          `[speech][bg_music]amix=inputs=2:duration=first:normalize=0[aout]`
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
      "-preset medium",
      "-crf 18",
      "-profile:v high",
      "-level 4.1",
      "-g 60",
      "-keyint_min 60",
      "-sc_threshold 0",
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
