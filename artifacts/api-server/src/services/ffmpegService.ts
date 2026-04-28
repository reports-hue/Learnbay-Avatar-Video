import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import { logger } from "../lib/logger.js";

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

function hexToAssAlpha(hex: string): string {
  const clean = hex.replace(/^#/, "").slice(0, 6).toLowerCase();
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

async function generateAssFile(
  cta: string,
  outputPath: string,
  durationSec: number,
  w: number,
  h: number,
  accentColor: string
): Promise<void> {
  const endTime = formatAssTime(durationSec);
  const fontSize = h >= 1080 ? 54 : 40;
  const lowerThirdH = Math.round(h * 0.22);
  const marginV = Math.round(lowerThirdH * 0.38);
  const accentAss = hexToAssAlpha(accentColor);
  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CTA,Arial,${fontSize},&H00FFFFFF,${accentAss},&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,2.5,0,2,30,30,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,${endTime},CTA,,0,0,0,,${cta}
`;
  await fs.writeFile(outputPath, content, "utf8");
}

function formatAssTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const cs = Math.floor((totalSec % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export interface PostProcessOptions {
  platform?: string;
  logoUrl?: string;
  primaryColor?: string;
  backgroundColor?: string;
  gradientColor2?: string;
  cta?: string;
  musicPath?: string;
}

export async function postProcessAvatarVideo(
  avatarVideoPath: string,
  options: PostProcessOptions = {}
): Promise<string> {
  const outputPath = path.join(outputsDir, "final.mp4");
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

  // --- Resolve logo ---
  let logoPath: string | null = null;
  if (options.logoUrl) {
    try {
      const dlPath = path.join(outputsDir, "logo_dl.png");
      await downloadUrl(options.logoUrl, dlPath);
      logoPath = dlPath;
      logger.info({ logoPath }, "Logo downloaded");
    } catch (e) {
      logger.warn({ err: e }, "Failed to download logo, skipping");
    }
  }
  if (!logoPath) {
    const builtinLogo = path.join(assetsDir, "logo.png");
    if (existsSync(builtinLogo)) logoPath = builtinLogo;
  }

  // --- Resolve music ---
  const musicAssetPath = path.join(assetsDir, "music.mp3");
  const musicPath = options.musicPath ?? (existsSync(musicAssetPath) ? musicAssetPath : null);

  // --- CTA ASS subtitle file ---
  let assPath: string | null = null;
  if (options.cta) {
    assPath = path.join(outputsDir, "cta.ass");
    await generateAssFile(options.cta, assPath, duration, outW, outH, accentColor);
    logger.info({ assPath }, "CTA ASS file generated");
  }

  logger.info(
    { platform: options.platform, isVertical, outW, outH, useGradient, bgHex, bg2Hex, accentHex, duration },
    "Post-processing avatar video"
  );

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

    // 1. Background: gradient (when AI theme) or flat color
    if (useGradient) {
      if (isVertical) {
        // Gradient top-to-bottom
        fp.push(
          `gradients=s=${outW}x${outH}:type=linear:x0=${outW / 2}:y0=0:x1=${outW / 2}:y1=${outH}:c0=${bgHex}:c1=${bg2Hex}:duration=${Math.ceil(duration) + 2}:rate=30[grad_bg]`
        );
      } else {
        // Gradient diagonal (top-left to bottom-right) for landscape
        fp.push(
          `gradients=s=${outW}x${outH}:type=linear:x0=0:y0=0:x1=${outW}:y1=${outH}:c0=${bgHex}:c1=${bg2Hex}:duration=${Math.ceil(duration) + 2}:rate=30[grad_bg]`
        );
      }
      // Scale avatar (without pad) and overlay on gradient
      if (isVertical) {
        fp.push(`[${avatarIdx}:v]scale=${outW}:-2[av_s]`);
        fp.push(`[grad_bg][av_s]overlay=(W-w)/2:(H-h)*3/5[av_framed]`);
      } else {
        fp.push(`[${avatarIdx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[av_s]`);
        fp.push(`[grad_bg][av_s]overlay=(W-w)/2:(H-h)/2[av_framed]`);
      }
    } else {
      // Flat color pad (original behavior)
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

    // 2. Professional lower-third: two-layer semi-transparent overlay for depth
    const lt = lowerH;
    // Primary dark overlay covering full lower-third
    fp.push(
      `[${lastV}]drawbox=x=0:y=ih-${lt}:w=iw:h=${lt}:c=black@0.52:t=fill[with_lt1]`
    );
    // Extra darkening on bottom half of lower-third (gradient illusion)
    const lt2 = Math.round(lt * 0.55);
    fp.push(
      `[with_lt1]drawbox=x=0:y=ih-${lt2}:w=iw:h=${lt2}:c=black@0.22:t=fill[with_lt]`
    );
    lastV = "with_lt";

    // 3. Accent line above lower-third
    fp.push(
      `[${lastV}]drawbox=x=0:y=ih-${lt + barH}:w=iw:h=${barH}:c=${accentHex}:t=fill[with_bar]`
    );
    lastV = "with_bar";

    // 4. Logo overlay — top-right corner with a subtle dark backing circle
    if (logoIdx >= 0) {
      const logoW = isVertical ? Math.round(outW * 0.18) : Math.round(outW * 0.10);
      const pad = isVertical ? 22 : 16;
      fp.push(
        `[${logoIdx}:v]scale=${logoW}:-1[logo_s]`,
        `[${lastV}][logo_s]overlay=W-w-${pad}:${pad}[with_logo]`
      );
      lastV = "with_logo";
    }

    // 5. CTA text via ASS subtitle in the lower-third area
    if (assPath) {
      const escaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      fp.push(`[${lastV}]subtitles='${escaped}'[with_cta]`);
      lastV = "with_cta";
    }

    // 6. FPS normalize
    fp.push(`[${lastV}]fps=30[vout]`);

    // 7. Audio chain
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
      .on("end", () => {
        logger.info({ outputPath }, "FFmpeg done");
        resolve(outputPath);
      })
      .on("error", (err, _stdout, stderr) => {
        logger.error({ err, stderr }, "FFmpeg error");
        reject(new Error(`FFmpeg failed: ${err.message}\n${stderr ?? ""}`));
      })
      .run();
  });
}

export async function processVideo(platform: string): Promise<string> {
  const isVertical = VERTICAL_PLATFORMS.has(platform);
  const outputPath = path.join(outputsDir, "final.mp4");
  const voicePath = path.join(outputsDir, "voice.mp3");
  const srtPath = path.join(outputsDir, "subtitles.srt");
  const bgVideo = isVertical ? "bg_vertical.mp4" : "bg_horizontal.mp4";
  const width = isVertical ? 1080 : 1920;
  const height = isVertical ? 1920 : 1080;

  const avatarExists = existsSync(path.join(assetsDir, "avatar.mp4"));
  const bgExists = existsSync(path.join(assetsDir, bgVideo));
  const logoExists = existsSync(path.join(assetsDir, "logo.png"));
  const musicExists = existsSync(path.join(assetsDir, "music.mp3"));
  const srtExists = existsSync(srtPath);
  const voiceExists = existsSync(voicePath);

  const voiceDuration = voiceExists ? await getDuration(voicePath) : 30;
  const totalDuration = Math.max(voiceDuration + 1, 5);

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();
    let inputIndex = 0;

    let bgInputIndex = -1;
    if (bgExists) {
      cmd = cmd.input(path.join(assetsDir, bgVideo)).inputOptions(["-stream_loop -1"]);
      bgInputIndex = inputIndex++;
    }
    let voiceInputIndex = -1;
    if (voiceExists) { cmd = cmd.input(voicePath); voiceInputIndex = inputIndex++; }
    let avatarInputIndex = -1;
    if (avatarExists) {
      cmd = cmd.input(path.join(assetsDir, "avatar.mp4")).inputOptions(["-stream_loop -1"]);
      avatarInputIndex = inputIndex++;
    }
    let logoInputIndex = -1;
    if (logoExists) { cmd = cmd.input(path.join(assetsDir, "logo.png")); logoInputIndex = inputIndex++; }
    let musicInputIndex = -1;
    if (musicExists) {
      cmd = cmd.input(path.join(assetsDir, "music.mp3")).inputOptions(["-stream_loop -1"]);
      musicInputIndex = inputIndex++;
    }

    const filterParts: string[] = [];
    if (bgExists) {
      filterParts.push(`[${bgInputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=cover,crop=${width}:${height}[bg]`);
    } else {
      filterParts.push(`color=c=black:s=${width}x${height}:r=30:duration=${totalDuration}[bg]`);
    }
    let lastVideo = "bg";
    if (avatarExists) {
      const avatarSize = isVertical ? Math.round(width * 0.7) : Math.round(height * 0.75);
      filterParts.push(
        `[${avatarInputIndex}:v]scale=${avatarSize}:-1[avatar_scaled]`,
        `[${lastVideo}][avatar_scaled]overlay=(W-w)/2:(H-h)/2[with_avatar]`
      );
      lastVideo = "with_avatar";
    }
    if (logoExists) {
      const logoSize = Math.round(width * 0.12);
      const pad = Math.round(width * 0.03);
      filterParts.push(
        `[${logoInputIndex}:v]scale=${logoSize}:-1[logo_scaled]`,
        `[${lastVideo}][logo_scaled]overlay=W-w-${pad}:H-h-${pad}[with_logo]`
      );
      lastVideo = "with_logo";
    }
    if (srtExists) {
      const escapedSrtPath = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      filterParts.push(
        `[${lastVideo}]subtitles='${escapedSrtPath}':force_style='Fontsize=22,PrimaryColour=&H00ffffff,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=40'[with_subs]`
      );
      lastVideo = "with_subs";
    }
    filterParts.push(`[${lastVideo}]fps=30[vout]`);

    const audioFilters: string[] = [];
    if (voiceExists && musicExists) {
      audioFilters.push(
        `[${voiceInputIndex}:a]aformat=fltp:44100:stereo,volume=1.0[voice]`,
        `[${musicInputIndex}:a]aformat=fltp:44100:stereo,volume=0.1[music]`,
        `[voice][music]amix=inputs=2:duration=first[aout]`
      );
    } else if (voiceExists) {
      audioFilters.push(`[${voiceInputIndex}:a]aformat=fltp:44100:stereo[aout]`);
    } else if (musicExists) {
      audioFilters.push(`[${musicInputIndex}:a]aformat=fltp:44100:stereo,volume=0.3[aout]`);
    }

    const fullFilter = [...filterParts, ...audioFilters].join(";");
    const outputOptions = [
      "-map [vout]",
      audioFilters.length > 0 ? "-map [aout]" : "-an",
      `-t ${totalDuration}`,
      "-c:v libx264", "-preset fast", "-crf 23", "-c:a aac", "-b:a 128k",
      "-movflags +faststart", "-pix_fmt yuv420p",
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
