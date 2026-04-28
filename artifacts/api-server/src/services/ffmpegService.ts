import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import fs from "fs/promises";
import { logger } from "../lib/logger.js";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, "../assets");
const outputsDir = path.resolve(__dirname, "../outputs");

async function getDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
  });
}

export interface PostProcessOptions {
  logoUrl?: string;
  primaryColor?: string;
  musicPath?: string;
}

export async function postProcessAvatarVideo(
  avatarVideoPath: string,
  options: PostProcessOptions = {}
): Promise<string> {
  const outputPath = path.join(outputsDir, "final.mp4");
  const duration = await getDuration(avatarVideoPath);

  let logoPath: string | null = null;
  if (options.logoUrl) {
    try {
      const dlPath = path.join(outputsDir, "logo_dl.png");
      const res = await axios.get<NodeJS.ReadableStream>(options.logoUrl, { responseType: "stream" });
      const writeStream = (await import("fs")).createWriteStream(dlPath);
      await new Promise<void>((resolve, reject) => {
        (res.data as NodeJS.ReadableStream).pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      logoPath = dlPath;
      logger.info({ logoPath }, "Logo downloaded");
    } catch (e) {
      logger.warn({ err: e }, "Failed to download logo, skipping");
    }
  } else {
    const builtinLogo = path.join(assetsDir, "logo.png");
    if (existsSync(builtinLogo)) logoPath = builtinLogo;
  }

  const musicAssetPath = path.join(assetsDir, "music.mp3");
  const musicPath = options.musicPath ?? (existsSync(musicAssetPath) ? musicAssetPath : null);

  logger.info({ avatarVideoPath, logoPath, musicPath, duration }, "Post-processing avatar video");

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
    let lastVideo = `${avatarIdx}:v`;
    const primaryHex = hexToFFmpegColor(options.primaryColor ?? "#7C3AED");

    if (logoIdx >= 0) {
      filterParts.push(
        `[${logoIdx}:v]scale=iw*0.12:-1[logo_s]`,
        `[${lastVideo}][logo_s]overlay=W-w-20:20[with_logo]`
      );
      lastVideo = "with_logo";
    }

    if (options.primaryColor) {
      const pad = 6;
      filterParts.push(
        `color=c=${primaryHex}:s=iw/1:1:r=30[bar]`,
        `[${lastVideo}][bar]overlay=0:H-${pad}[with_bar]`
      );
      lastVideo = "with_bar";
    }

    filterParts.push(`[${lastVideo}]fps=30[vout]`);

    const audioFilters: string[] = [];
    if (musicIdx >= 0) {
      audioFilters.push(
        `[${avatarIdx}:a]aformat=fltp:44100:stereo,volume=1.0[speech]`,
        `[${musicIdx}:a]aformat=fltp:44100:stereo,volume=0.08[music]`,
        `[speech][music]amix=inputs=2:duration=first[aout]`
      );
    } else {
      audioFilters.push(`[${avatarIdx}:a]aformat=fltp:44100:stereo[aout]`);
    }

    const fullFilter = [...filterParts, ...audioFilters].join(";");
    logger.info({ fullFilter }, "FFmpeg filter graph");

    const outputOptions = [
      "-map [vout]",
      "-map [aout]",
      `-t ${duration + 0.5}`,
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

function hexToFFmpegColor(hex: string): string {
  const clean = hex.replace("#", "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return `0x${clean}`;
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = clean[0]! + clean[0]!;
    const g = clean[1]! + clean[1]!;
    const b = clean[2]! + clean[2]!;
    return `0x${r}${g}${b}`;
  }
  return "0x7C3AED";
}

export async function processVideo(platform: string): Promise<string> {
  const isVertical = ["YouTube Shorts", "Instagram Reels", "Facebook Reels"].includes(platform);
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

  logger.info({ platform, isVertical, avatarExists, bgExists, logoExists, musicExists, voiceExists, srtExists }, "Starting FFmpeg legacy processing");

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
    if (voiceExists) {
      cmd = cmd.input(voicePath);
      voiceInputIndex = inputIndex++;
    }

    let avatarInputIndex = -1;
    if (avatarExists) {
      cmd = cmd.input(path.join(assetsDir, "avatar.mp4")).inputOptions(["-stream_loop -1"]);
      avatarInputIndex = inputIndex++;
    }

    let logoInputIndex = -1;
    if (logoExists) {
      cmd = cmd.input(path.join(assetsDir, "logo.png"));
      logoInputIndex = inputIndex++;
    }

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
      "-c:v libx264",
      "-preset fast",
      "-crf 23",
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
