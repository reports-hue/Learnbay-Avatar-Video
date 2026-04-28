import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { createWriteStream } from "fs";
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

function hexToFFmpeg(hex: string): string {
  const clean = hex.replace("#", "").slice(0, 6);
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return `0x${clean}`;
  return "0x7C3AED";
}

export interface PostProcessOptions {
  platform?: string;
  logoUrl?: string;
  primaryColor?: string;
  backgroundColor?: string;
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

  // --- Resolve logo ---
  let logoPath: string | null = null;
  if (options.logoUrl) {
    try {
      const dlPath = path.join(outputsDir, "logo_dl.png");
      await downloadUrl(options.logoUrl, dlPath);
      logoPath = dlPath;
      logger.info({ logoPath }, "Logo downloaded from URL");
    } catch (e) {
      logger.warn({ err: e }, "Failed to download logo URL, skipping");
    }
  }
  if (!logoPath) {
    const builtinLogo = path.join(assetsDir, "logo.png");
    if (existsSync(builtinLogo)) logoPath = builtinLogo;
  }

  // --- Resolve music ---
  const musicAssetPath = path.join(assetsDir, "music.mp3");
  const musicPath = options.musicPath ?? (existsSync(musicAssetPath) ? musicAssetPath : null);

  // --- Background color for padding ---
  const bgHex = hexToFFmpeg(
    (options.backgroundColor ?? "#000000FF").replace(/FF$/, "").replace(/^#/, "#").slice(0, 7)
  );
  const brandHex = hexToFFmpeg(options.primaryColor ?? "#7C3AED");

  logger.info(
    { platform: options.platform, isVertical, outW, outH, logoPath, musicPath, bgHex, brandHex, duration },
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

    const filterParts: string[] = [];

    // 1. Scale + pad avatar to target dimensions
    if (isVertical) {
      // Scale avatar to full width (1080), pad height to 1920 with background color
      // Avatar sits at vertical center-bottom (y = 60% from top)
      filterParts.push(
        `[${avatarIdx}:v]scale=${outW}:-2[av_scaled]`,
        `[av_scaled]pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)*3/5:color=${bgHex}[av_framed]`
      );
    } else {
      // Scale to 1920x1080, pad if needed
      filterParts.push(
        `[${avatarIdx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=${bgHex}[av_framed]`
      );
    }

    let lastV = "av_framed";

    // 2. Brand accent bar at the bottom
    if (options.primaryColor) {
      const barH = isVertical ? 12 : 8;
      filterParts.push(
        `[${lastV}]drawbox=x=0:y=ih-${barH}:w=iw:h=${barH}:c=${brandHex}:t=fill[with_bar]`
      );
      lastV = "with_bar";
    }

    // 3. Logo overlay — top-right corner
    if (logoIdx >= 0) {
      const logoW = Math.round(outW * 0.13);
      const pad = 18;
      filterParts.push(
        `[${logoIdx}:v]scale=${logoW}:-1[logo_s]`,
        `[${lastV}][logo_s]overlay=W-w-${pad}:${pad}[with_logo]`
      );
      lastV = "with_logo";
    }

    // 4. CTA text at bottom-center (above brand bar)
    const ctaText = options.cta;
    if (ctaText) {
      const escapedCta = ctaText.replace(/'/g, "\\'").replace(/:/g, "\\:");
      const fontSize = isVertical ? 38 : 32;
      const yPos = isVertical ? `h-${100}` : `h-${80}`;
      filterParts.push(
        `[${lastV}]drawtext=text='${escapedCta}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPos}:box=1:boxcolor=black@0.45:boxborderw=8[with_cta]`
      );
      lastV = "with_cta";
    }

    // 5. FPS normalize
    filterParts.push(`[${lastV}]fps=30[vout]`);

    // 6. Audio chain
    const audioFilters: string[] = [];
    if (musicIdx >= 0) {
      audioFilters.push(
        `[${avatarIdx}:a]aformat=fltp:44100:stereo,volume=1.0[speech]`,
        `[${musicIdx}:a]aformat=fltp:44100:stereo,volume=0.08[bg_music]`,
        `[speech][bg_music]amix=inputs=2:duration=first[aout]`
      );
    } else {
      audioFilters.push(`[${avatarIdx}:a]aformat=fltp:44100:stereo[aout]`);
    }

    const fullFilter = [...filterParts, ...audioFilters].join(";");
    logger.info({ fullFilter }, "FFmpeg filter graph");

    const outputOptions = [
      "-map [vout]",
      "-map [aout]",
      `-t ${duration}`,
      "-c:v libx264",
      "-preset fast",
      "-crf 22",
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
