import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { existsSync } from "fs";
import { logger } from "../lib/logger.js";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, "../../assets");
const outputsDir = path.resolve(__dirname, "../../outputs");

const VERTICAL_PLATFORMS = new Set([
  "YouTube Shorts",
  "Instagram Reels",
  "Facebook Reels",
]);

function assetPath(name: string): string {
  return path.join(assetsDir, name);
}

function hasAsset(name: string): boolean {
  return existsSync(assetPath(name));
}

async function getDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
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

  const avatarExists = hasAsset("avatar.mp4");
  const bgExists = hasAsset(bgVideo);
  const logoExists = hasAsset("logo.png");
  const musicExists = hasAsset("music.mp3");
  const srtExists = existsSync(srtPath);
  const voiceExists = existsSync(voicePath);

  logger.info(
    { platform, isVertical, avatarExists, bgExists, logoExists, musicExists },
    "Starting FFmpeg processing"
  );

  const voiceDuration = voiceExists ? await getDuration(voicePath) : 30;
  const totalDuration = Math.max(voiceDuration + 1, 5);

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();

    if (bgExists) {
      cmd = cmd.input(assetPath(bgVideo)).inputOptions(["-stream_loop -1"]);
    } else {
      cmd = cmd.input("color=c=black:size=" + width + "x" + height + ":rate=30")
        .inputFormat("lavfi");
    }

    if (voiceExists) {
      cmd = cmd.input(voicePath);
    }

    if (avatarExists) {
      cmd = cmd.input(assetPath("avatar.mp4")).inputOptions(["-stream_loop -1"]);
    }

    if (logoExists) {
      cmd = cmd.input(assetPath("logo.png"));
    }

    if (musicExists) {
      cmd = cmd.input(assetPath("music.mp3")).inputOptions(["-stream_loop -1"]);
    }

    const filterParts: string[] = [];
    let videoStream = "0:v";
    let inputIndex = 1;

    const voiceIndex = voiceExists ? inputIndex++ : -1;
    const avatarIndex = avatarExists ? inputIndex++ : -1;
    const logoIndex = logoExists ? inputIndex++ : -1;
    const musicIndex = musicExists ? inputIndex++ : -1;

    filterParts.push(`[${videoStream}]scale=${width}:${height}:force_original_aspect_ratio=cover,crop=${width}:${height}[bg]`);
    let lastVideo = "bg";

    if (avatarExists) {
      const avatarSize = isVertical ? Math.round(width * 0.7) : Math.round(height * 0.75);
      filterParts.push(
        `[${avatarIndex}:v]scale=${avatarSize}:-1[avatar_scaled]`,
        `[${lastVideo}][avatar_scaled]overlay=(W-w)/2:(H-h)/2[with_avatar]`
      );
      lastVideo = "with_avatar";
    }

    if (logoExists) {
      const logoSize = Math.round(width * 0.12);
      const pad = Math.round(width * 0.03);
      filterParts.push(
        `[${logoIndex}:v]scale=${logoSize}:-1[logo_scaled]`,
        `[${lastVideo}][logo_scaled]overlay=W-w-${pad}:H-h-${pad}[with_logo]`
      );
      lastVideo = "with_logo";
    }

    if (srtExists) {
      filterParts.push(
        `[${lastVideo}]subtitles='${srtPath.replace(/'/g, "\\'")}':force_style='Fontsize=22,PrimaryColour=&H00ffffff,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=40'[with_subs]`
      );
      lastVideo = "with_subs";
    }

    filterParts.push(`[${lastVideo}]fps=30[vout]`);

    const audioFilters: string[] = [];
    if (voiceExists && musicExists) {
      audioFilters.push(
        `[${voiceIndex}:a]aformat=fltp:44100:stereo,volume=1.0[voice]`,
        `[${musicIndex}:a]aformat=fltp:44100:stereo,volume=0.1[music]`,
        `[voice][music]amix=inputs=2:duration=first[aout]`
      );
    } else if (voiceExists) {
      audioFilters.push(`[${voiceIndex}:a]aformat=fltp:44100:stereo[aout]`);
    } else if (musicExists) {
      audioFilters.push(`[${musicIndex}:a]aformat=fltp:44100:stereo,volume=0.3[aout]`);
    }

    const fullFilter = [...filterParts, ...audioFilters].join(";");

    cmd = cmd
      .complexFilter(fullFilter)
      .outputOptions([
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
      ])
      .output(outputPath)
      .on("start", (cmd) => logger.info({ cmd }, "FFmpeg started"))
      .on("progress", (p) => logger.info({ percent: p.percent }, "FFmpeg progress"))
      .on("end", () => {
        logger.info({ outputPath }, "FFmpeg done");
        resolve(outputPath);
      })
      .on("error", (err, stdout, stderr) => {
        logger.error({ err, stderr }, "FFmpeg error");
        reject(new Error(`FFmpeg failed: ${err.message}\n${stderr}`));
      });

    cmd.run();
  });
}
