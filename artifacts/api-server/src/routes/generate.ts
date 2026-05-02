import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { logger } from "../lib/logger.js";
import * as jobStore from "../lib/jobStore.js";
import type { JobState, JobResult } from "../lib/jobStore.js";
import { generateScript, generateBrandTheme, researchCompanyForScript, type ScriptStyle } from "../services/openai.js";
import { generateAvatarVideo, resolveAvatarStyle, getAvatarPose, type AvatarJobConfig, type PacingRate } from "../services/avatarService.js";
import { postProcessAvatarVideo, extractThumbnail, type CaptionStyle } from "../services/ffmpegService.js";
import { generateBackgroundImage } from "../services/imageGenerationService.js";
import { getWordTimings } from "../services/speech.js";
import { synthesizeElevenLabs } from "../services/elevenLabsService.js";
import { segmentScript } from "../services/scriptSegmenter.js";
import { fetchBrollResources, writeBrollAuditTrail } from "../services/brollEngine.js";
import { INTRO_BREAK_SEC } from "../services/introStingService.js";
import ffmpeg from "fluent-ffmpeg";

const execFileAsync = promisify(execFile);

/**
 * Prepend `durationSec` seconds of silence to an audio file.
 * Produces a new MP3 at `outputPath`. Used so ElevenLabs speech
 * starts AFTER the intro logo reveal instead of being muted.
 */
async function prependSilenceToElAudio(inputPath: string, outputPath: string, durationSec: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-t", String(durationSec), "-i", "anullsrc=r=44100:cl=stereo",
    "-i", inputPath,
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[aout]",
    "-map", "[aout]",
    "-c:a", "libmp3lame", "-b:a", "192k",
    outputPath,
  ]);
}

/**
 * Probe a media file's duration in seconds. Returns 0 on any error so
 * the caller can short-circuit b-roll planning instead of crashing the
 * render. This is intentionally lenient — duration is only used as a
 * budget hint for the segmenter, not a hard correctness requirement.
 */
async function probeDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve(0);
      resolve(metadata.format.duration ?? 0);
    });
  });
}

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

const PACING_SSML_RATE: Record<PacingRate, string> = {
  slow: "0.88",
  natural: "0.95",
  fast: "1.05",
};

// Mirror of ffmpegService's VERTICAL_PLATFORMS so the b-roll planner picks
// the right Pexels orientation. Keep these two lists in sync.
const VERTICAL_PLATFORMS = new Set(["YouTube Shorts", "Instagram Reels", "Facebook Reels"]);

// ─── Job store ─────────────────────────────────────────────────────
// Job state is persisted to SQLite via `lib/jobStore.ts` so that progress
// survives server restarts. Public types re-exported for any external code
// that previously imported them from this module.
export type { JobResult, JobState };

// Clean up jobs older than 4 hours, every 30 minutes.
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
setInterval(() => {
  try {
    const removed = jobStore.cleanup(FOUR_HOURS_MS);
    if (removed > 0) {
      logger.info({ removed }, "jobStore: cleaned up expired jobs");
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "jobStore cleanup failed");
  }
}, 30 * 60 * 1000);

function updateJob(jobId: string, patch: Partial<JobState>) {
  jobStore.update(jobId, patch);
}

// ─── Generate request type ────────────────────────────────────────
export interface GenerateRequest {
  topic?: string;
  platform?: string;
  avatar?: string;
  avatarStyle?: string;
  voice?: string;
  voiceStyle?: string;
  scriptStyle?: ScriptStyle;
  backgroundColor?: string;
  gradientColor2?: string;
  bgImageUrl?: string;
  logoUrl?: string;
  primaryColor?: string;
  cta?: string;
  captionStyle?: CaptionStyle;
  autoBackground?: boolean;
  realism?: boolean;
  pacing?: PacingRate;
  customPhotoUrl?: string;
  elevenLabsKey?: string;
  companyName?: string;
  companyWebsite?: string;
  companyDescription?: string;
  /**
   * Optional pre-approved script. When present, runGenerationJob skips the
   * `generateScript` LLM call and uses this string verbatim. Used by the
   * "preview & edit script" flow so the user can tweak wording before the
   * expensive avatar+ffmpeg pipeline runs.
   */
  scriptOverride?: string;
}

// ─── Async generation job ─────────────────────────────────────────
async function runGenerationJob(jobId: string, body: GenerateRequest) {
  const {
    topic = "",
    platform = "",
    avatar = "lisa",
    avatarStyle = "",
    voice = "en-US-AvaMultilingualNeural",
    voiceStyle,
    scriptStyle = "viral",
    backgroundColor,
    gradientColor2: requestGradientColor2,
    bgImageUrl,
    logoUrl,
    primaryColor,
    cta,
    captionStyle = "animated",
    autoBackground = false,
    realism = true,
    pacing = "natural",
    elevenLabsKey,
    companyName = "",
    companyWebsite = "",
    companyDescription = "",
    scriptOverride,
  } = body;

  // Whitelist of Azure Avatar characters confirmed to work with this API version
  const VALID_AVATAR_CHARACTERS = ["lisa", "harry", "jeff"];
  const resolvedAvatar = VALID_AVATAR_CHARACTERS.includes(avatar) ? avatar : "lisa";
  if (avatar !== resolvedAvatar) {
    logger.warn({ avatar }, "Unknown avatar character, falling back to lisa");
  }
  // Always pass a valid non-empty style. Empty string causes Azure InvalidStyleName.
  const resolvedAvatarStyle = resolveAvatarStyle(resolvedAvatar, avatarStyle);

  const isElevenLabs = typeof voice === "string" && voice.startsWith("el:");
  const elVoiceId = isElevenLabs ? voice.slice(3) : null;
  const elApiKey = elevenLabsKey || process.env.ELEVENLABS_API_KEY || "";

  const videoId = uuidv4().replace(/-/g, "").slice(0, 12);

  try {
    const hasOverride = typeof scriptOverride === "string" && scriptOverride.trim().length > 0;
    updateJob(jobId, {
      status: "running",
      step: "script",
      percent: 5,
      message: hasOverride
        ? "Using your approved script. Preparing brand theme…"
        : "Researching your topic & crafting AI script…",
    });

    // Run company research (if brand profile present) and theme generation in parallel.
    // Skip company research when the user pre-approved a script — the research only
    // exists to feed `generateScript`, so it's pure waste when we have an override.
    const needsResearch = !hasOverride && companyName.trim().length > 0;
    const needsTheme = autoBackground || !backgroundColor;
    const hasImageDeployment = !!(process.env.AZURE_IMAGE_DEPLOYMENT || process.env.AZURE_OPENAI_ENDPOINT);
    const needsAiBg = autoBackground && hasImageDeployment && !bgImageUrl;

    const [companyContext, brandThemeResult] = await Promise.all([
      needsResearch
        ? researchCompanyForScript(companyName, companyWebsite, companyDescription, topic)
        : Promise.resolve(""),
      needsTheme
        ? generateBrandTheme(topic, platform)
        : Promise.resolve(null),
    ]);

    const script = hasOverride
      ? scriptOverride.trim()
      : await generateScript(topic, platform, scriptStyle as ScriptStyle, companyContext || undefined);

    let resolvedBgColor1 = (backgroundColor ?? "#000000FF").slice(0, 7);
    let resolvedBgColor2: string | undefined = requestGradientColor2;
    let resolvedAccent = primaryColor ?? "#4A9FFF";

    if (brandThemeResult) {
      resolvedBgColor1 = brandThemeResult.bgColor1;
      resolvedBgColor2 = brandThemeResult.bgColor2;
      resolvedAccent = primaryColor ?? brandThemeResult.accentColor;
    }

    // ── AI background image generation (gpt-image-1) ──
    let aiBgImagePath: string | undefined;
    if (needsAiBg) {
      updateJob(jobId, { step: "ai_background", percent: 16, message: "Generating AI background image…" });
      try {
        aiBgImagePath = await generateBackgroundImage(
          topic,
          brandThemeResult?.backgroundStyle ?? "cinematic_dark",
          resolvedBgColor1,
          resolvedBgColor2 ?? resolvedBgColor1,
          platform,
          `bg_${videoId}.jpg`,
          getAvatarPose(resolvedAvatar, resolvedAvatarStyle),
        );
        logger.info({ aiBgImagePath }, "AI background image ready");
      } catch (err) {
        const e = err as { message?: string; response?: { status?: number; data?: unknown } };
        logger.warn(
          {
            message: e?.message,
            status: e?.response?.status,
            responseData: e?.response?.data,
          },
          "AI background generation failed — falling back to gradient"
        );
      }
    }

    updateJob(jobId, { step: "script_done", percent: 18, message: "Script ready. Getting word timings…", script });

    // ── Intro-sting leading break ──
    // When a logo is present the intro sting shows for INTRO_BREAK_SEC seconds.
    // To prevent the avatar from mouthing words behind the blackout (and the
    // ElevenLabs audio from playing silently while muted), we insert a leading
    // gap equal to INTRO_BREAK_SEC into BOTH the avatar SSML and the EL audio.
    // This pushes all speech — and therefore all word-timing events — INTRO_BREAK_SEC
    // seconds later in the timeline, aligning perfectly with the moment the
    // blackout lifts and the avatar becomes visible.
    const introDurationSec = logoUrl ? INTRO_BREAK_SEC : 0;
    const introBreakMs = Math.round(introDurationSec * 1000);

    // ── Step 2: Word timings / ElevenLabs TTS ──
    const pacingRate = PACING_SSML_RATE[pacing] ?? "0.95";
    let wordTimings: import("../services/speech.js").WordTiming[] = [];
    let elAudioUrl: string | undefined;
    let elAudioPath: string | undefined;

    if (isElevenLabs && elVoiceId) {
      if (!elApiKey) throw new Error("ElevenLabs API key is required. Add it in Voice Settings.");
      updateJob(jobId, { step: "elevenlabs", percent: 20, message: "Synthesizing voice with ElevenLabs…" });
      const elResult = await synthesizeElevenLabs(script, elVoiceId, elApiKey);
      const rawElAudioPath = path.join(outputsDir, elResult.filename);
      const publicDomain = process.env.REPLIT_DEV_DOMAIN || process.env.PUBLIC_URL;
      if (!publicDomain) throw new Error("Cannot determine public URL for ElevenLabs audio. Set REPLIT_DEV_DOMAIN or PUBLIC_URL.");

      // Prepend leading silence so EL speech starts after the intro sting.
      if (introDurationSec > 0) {
        const paddedFilename = `el_padded_${videoId}.mp3`;
        const paddedPath = path.join(outputsDir, paddedFilename);
        await prependSilenceToElAudio(rawElAudioPath, paddedPath, introDurationSec);
        elAudioPath = paddedPath;
        elAudioUrl = `https://${publicDomain}/api/video/${paddedFilename}`;
      } else {
        elAudioPath = rawElAudioPath;
        elAudioUrl = `https://${publicDomain}/api/video/${elResult.filename}`;
      }

      // Shift word timings by the intro break so captions align with the padded audio.
      wordTimings = elResult.wordTimings.map(t => ({
        word: t.word,
        startSec: t.start / 1000 + introDurationSec,
        durationSec: (t.end - t.start) / 1000,
      }));
    } else if (captionStyle !== "none") {
      // Hard rule: never silently fall back to estimated timing. If the SDK
      // can't deliver real word-boundary events, fail the render with a clear
      // error rather than shipping mistimed captions.
      // Pass introBreakMs so the timing SSML matches the avatar SSML break,
      // causing word-boundary audioOffset values to be auto-shifted.
      wordTimings = await getWordTimings(script, voice, pacingRate, introBreakMs);
    }

    updateJob(jobId, { step: "avatar_start", percent: 25, message: "Azure AI is rendering your avatar (2–5 min)…" });

    // ── Step 3: Avatar synthesis ──
    // Transparent WebM path replaces the legacy green-screen + chroma key flow.
    // It only kicks in when we'd otherwise be doing chroma keying (realism on,
    // no Azure-side bg image). The legacy chroma path stays wired in case Azure
    // ever rejects the transparent request — to fall back, set the constant
    // PREFER_TRANSPARENT_WEBM below to false. That single switch flips both the
    // Azure request body (avatarService.ts) and the FFmpeg overlay strategy
    // (ffmpegService.ts useGreenScreen branch).
    // Set to false: Azure's avatar batch synthesis API (api-version
    // 2024-04-15-preview) does NOT honour backgroundColor:"transparent".
    // It accepts videoFormat:"webm" + videoCodec:"vp9" but silently
    // substitutes a WHITE background (verified Apr 30 2026: ffprobe shows
    // pix_fmt=yuv420p with no alpha plane; corner pixels = #FFFFFF).
    // The legacy mp4 + green-screen + chroma key path is the working route.
    // See replit.md → "Known Azure Limitations" for the full investigation.
    const PREFER_TRANSPARENT_WEBM = false;
    const wantsAlphaCompositing = realism && !bgImageUrl;
    const useTransparent = PREFER_TRANSPARENT_WEBM && wantsAlphaCompositing;
    const useGreenScreen = !PREFER_TRANSPARENT_WEBM && wantsAlphaCompositing;
    const azureBgColor = resolvedBgColor1 + "FF";

    const avatarConfig: AvatarJobConfig = {
      script,
      character: resolvedAvatar,
      style: resolvedAvatarStyle,
      voice: isElevenLabs ? "en-US-AvaMultilingualNeural" : voice,
      voiceStyle: voiceStyle || undefined,
      backgroundColor: azureBgColor,
      bgImageUrl: bgImageUrl || undefined,
      pacing,
      realism,
      videoId,
      audioUrl: elAudioUrl,
      useTransparent,
      leadingBreakSec: introDurationSec > 0 ? introDurationSec : undefined,
    };

    const avatarVideoPath = await generateAvatarVideo(avatarConfig);
    updateJob(jobId, { step: "avatar_done", percent: 75, message: "Avatar rendered! Applying cinematic effects…" });

    // ── Step 3.5: Plan B-roll cutaways (T202 segmenter + T203 fetcher) ──
    // Best-effort. Any failure here MUST NOT block the render — we just
    // ship the video without b-roll. The segmenter and fetcher both
    // return graceful empties on error, but we still wrap in try/catch
    // for absolute safety.
    let brollResources: import("../services/brollEngine.js").BrollResource[] = [];
    let statPopinSegments: import("../services/scriptSegmenter.js").Segment[] = [];
    if (wordTimings.length > 0) {
      try {
        const brollIsVertical = VERTICAL_PLATFORMS.has(platform);
        const avatarDurationSec = await probeDurationSec(avatarVideoPath);
        if (avatarDurationSec > 0) {
          updateJob(jobId, { step: "broll_plan", percent: 78, message: "Planning b-roll cutaways…" });
          const plan = await segmentScript({
            script,
            wordTimings,
            style: scriptStyle,
            platform,
            duration: avatarDurationSec,
          });
          if (plan.segments.length > 0) {
            // T204: split the segmenter plan — stat-popin segments are
            // rendered by the premium stat-popin engine (multi-layer ASS),
            // broll-* segments by the Pexels b-roll engine. Both pipelines
            // share the same plan but emit independent ASS/filter graphs.
            statPopinSegments = plan.segments.filter((s) => s.mode === "stat-popin");
            const brollSegments = plan.segments.filter(
              (s) =>
                s.mode === "broll-pip" ||
                s.mode === "broll-fullscreen"
            );
            if (brollSegments.length > 0) {
              updateJob(jobId, {
                step: "broll_fetch",
                percent: 80,
                message: `Fetching ${brollSegments.length} b-roll clip(s)…`,
              });
              brollResources = await fetchBrollResources({
                segments: brollSegments,
                isVertical: brollIsVertical,
                cacheDir: path.join(outputsDir, "cache", "pexels"),
                accentColor: resolvedAccent,
              });
            }
            if (statPopinSegments.length > 0) {
              logger.info(
                {
                  jobId,
                  count: statPopinSegments.length,
                  sample: statPopinSegments.slice(0, 3).map((s) => ({
                    start: s.startSec,
                    text: s.emphasisText,
                  })),
                },
                "Stat-popin segments scheduled (T204)"
              );
            }
          }
        }
      } catch (brollErr) {
        const m = (brollErr as { message?: string })?.message ?? String(brollErr);
        logger.warn(
          { jobId, message: m.slice(0, 200) },
          "B-roll planning failed; continuing render without cutaways"
        );
        brollResources = [];
        statPopinSegments = [];
      }
    }

    // ── Step 4: Post-process ──
    const outputFilename = `video_${videoId}.mp4`;
    await postProcessAvatarVideo(avatarVideoPath, {
      videoId,
      platform,
      logoUrl: logoUrl || undefined,
      primaryColor: resolvedAccent,
      backgroundColor: azureBgColor,
      gradientColor2: resolvedBgColor2,
      backgroundStyle: brandThemeResult?.backgroundStyle,
      bgImagePath: aiBgImagePath,
      wordTimings: wordTimings.length > 0 ? wordTimings : undefined,
      captionStyle,
      outputFilename,
      useGreenScreen,
      useTransparentAvatar: useTransparent,
      realism,
      script,
      elAudioPath,
      brollResources: brollResources.length > 0 ? brollResources : undefined,
      statPopinSegments: statPopinSegments.length > 0 ? statPopinSegments : undefined,
    });

    // Persist b-roll attribution audit trail (license compliance).
    if (brollResources.length > 0) {
      await writeBrollAuditTrail(videoId, outputsDir, brollResources);
    }

    // ── Step 5: Thumbnail ──
    updateJob(jobId, { step: "thumbnail", percent: 95, message: "Generating thumbnail…" });
    const finalVideoPath = path.join(outputsDir, outputFilename);
    const thumbnailFilename = `thumb_${videoId}.jpg`;
    const thumbnailPath = path.join(outputsDir, thumbnailFilename);
    const thumbResult = await extractThumbnail(finalVideoPath, thumbnailPath);

    const result: JobResult = {
      videoId,
      script,
      videoUrl: `/api/video/${outputFilename}`,
      thumbnailUrl: thumbResult ? `/api/video/${thumbnailFilename}` : null,
      brandTheme: {
        bgColor1: resolvedBgColor1,
        bgColor2: resolvedBgColor2 ?? resolvedBgColor1,
        accentColor: resolvedAccent,
      },
      cta: cta || undefined,
    };

    updateJob(jobId, { status: "done", step: "done", percent: 100, message: "Your video is ready!", result });

    // Best-effort cleanup of the per-job raw avatar download (24-50 MB each).
    // Only fires on success; on failure we keep it for debugging. Errors are
    // swallowed — file may already be gone, or be a webm vs mp4 mismatch.
    try {
      const fsp = await import("fs/promises");
      await Promise.all([
        fsp.unlink(path.join(outputsDir, `avatar_raw_${videoId}.mp4`)).catch(() => undefined),
        fsp.unlink(path.join(outputsDir, `avatar_raw_${videoId}.webm`)).catch(() => undefined),
      ]);
    } catch {
      // ignore — cleanup is best-effort
    }
  } catch (err) {
    const e = err as { message?: string; response?: { status?: number; data?: unknown } };
    const status = e?.response?.status;
    const data = e?.response?.data;
    const baseMsg = e?.message ?? String(err);
    logger.error(
      { jobId, message: baseMsg, status, responseData: data },
      "Generation job failed"
    );
    let message = baseMsg;
    if (status && data) {
      const dataStr = typeof data === "string" ? data : JSON.stringify(data);
      message = `${baseMsg} (status ${status}): ${dataStr.slice(0, 400)}`;
    }
    updateJob(jobId, { status: "failed", error: message });
  }
}

// ─── POST /api/script — synchronous script-only generation ───────
// Returns a draft script for the user to review/edit before kicking off the
// full (expensive) avatar+ffmpeg pipeline. Synchronous on purpose: scripts
// take 2-6s to generate and the UX wants the result inline, not via polling.
router.post("/script", async (req: Request, res: Response) => {
  const body = req.body as Pick<
    GenerateRequest,
    "topic" | "platform" | "scriptStyle" | "companyName" | "companyWebsite" | "companyDescription"
  >;
  const topic = (body.topic ?? "").trim();
  const platform = (body.platform ?? "").trim();
  if (!topic || !platform) {
    res.status(400).json({ error: "topic and platform are required" });
    return;
  }

  const scriptStyle = (body.scriptStyle ?? "viral") as ScriptStyle;
  const companyName = (body.companyName ?? "").trim();
  const companyWebsite = (body.companyWebsite ?? "").trim();
  const companyDescription = (body.companyDescription ?? "").trim();

  try {
    const companyContext = companyName.length > 0
      ? await researchCompanyForScript(companyName, companyWebsite, companyDescription, topic)
      : "";
    const script = await generateScript(topic, platform, scriptStyle, companyContext || undefined);
    res.json({ script });
  } catch (err) {
    const e = err as { message?: string; response?: { status?: number; data?: unknown } };
    req.log.error(
      { message: e?.message, status: e?.response?.status, responseData: e?.response?.data },
      "Script-only generation failed"
    );
    res.status(500).json({ error: e?.message ?? "Script generation failed" });
  }
});

// ─── POST /api/generate — start job, return jobId immediately ─────
router.post("/generate", async (req: Request, res: Response) => {
  const body = req.body as GenerateRequest;
  const { topic, platform } = body;

  if (!topic || !platform) {
    res.status(400).json({ error: "topic and platform are required" });
    return;
  }

  const jobId = uuidv4().replace(/-/g, "").slice(0, 16);
  jobStore.set(jobId, {
    status: "pending",
    step: "start",
    percent: 0,
    message: "Starting…",
    createdAt: Date.now(),
  });

  // Fire and forget — client polls for progress
  runGenerationJob(jobId, body).catch(() => {});

  res.json({ jobId });
});

// ─── GET /api/jobs — list all completed job results (recovery) ────
router.get("/jobs", (_req: Request, res: Response) => {
  res.json(jobStore.listDone());
});

// ─── GET /api/videos — scan outputs dir for all video files ────────
router.get("/videos", (_req: Request, res: Response) => {
  try {
    const files = readdirSync(outputsDir)
      .filter(f => f.startsWith("video_") && f.endsWith(".mp4"))
      .map(f => {
        const videoId = f.replace("video_", "").replace(".mp4", "");
        const thumbFile = `thumb_${videoId}.jpg`;
        const thumbExists = existsSync(path.join(outputsDir, thumbFile));
        const stat = statSync(path.join(outputsDir, f));
        return {
          videoId,
          videoUrl: `/api/video/${f}`,
          thumbnailUrl: thumbExists ? `/api/video/${thumbFile}` : null,
          createdAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── DELETE /api/videos/:videoId — remove MP4 + thumbnail from disk ──
router.delete("/videos/:videoId", (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params["videoId"])
    ? req.params["videoId"][0]
    : req.params["videoId"];
  // Sanitise: only allow [a-z0-9_-] to prevent path traversal
  const videoId = (rawId ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!videoId) {
    res.status(400).json({ error: "Invalid videoId" });
    return;
  }
  const targets = [
    path.join(outputsDir, `video_${videoId}.mp4`),
    path.join(outputsDir, `thumb_${videoId}.jpg`),
  ];
  const removed: string[] = [];
  for (const p of targets) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed.push(path.basename(p));
      } catch (err) {
        req.log.warn({ err, p }, "Failed to delete file");
      }
    }
  }
  if (removed.length === 0) {
    res.status(404).json({ error: "Video not found", videoId });
    return;
  }
  req.log.info({ videoId, removed }, "Deleted video files");
  res.json({ ok: true, videoId, removed });
});

// ─── GET /api/jobs/:jobId — poll job status ───────────────────────
router.get("/jobs/:jobId", (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params["jobId"])
    ? req.params["jobId"][0]
    : req.params["jobId"];
  const job = jobStore.get(jobId ?? "");
  if (!job) {
    res.status(404).json({ error: "Job not found. It may have expired (jobs are kept for 4 hours)." });
    return;
  }
  res.json(job);
});

// ─── Video file serving ─────────────────────────────────────────
router.get("/video/:filename", (req: Request, res: Response) => {
  const filename = Array.isArray(req.params["filename"])
    ? req.params["filename"][0]
    : req.params["filename"];
  const safeFilename = path.basename(filename ?? "");
  const filePath = path.join(outputsDir, safeFilename);

  if (!existsSync(filePath)) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  res.sendFile(filePath);
});

// ─── Voice preview endpoint ─────────────────────────────────────
router.post("/preview-voice", async (req: Request, res: Response) => {
  const { voice = "en-US-AvaMultilingualNeural" } = req.body as { voice?: string };

  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";
  const key = process.env.AZURE_SPEECH_KEY ?? "";

  if (!key) {
    res.status(503).json({ error: "Azure Speech not configured" });
    return;
  }

  const sampleText = "Hi! I'm your AI video presenter. Here's what I'll sound like in your video.";
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">
  <voice name="${voice}">
    <prosody rate="0.95" pitch="-2%">${sampleText}</prosody>
  </voice>
</speak>`;

  try {
    const ttsUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const response = await axios.post(ttsUrl, ssml, {
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
      },
      responseType: "arraybuffer",
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(response.data);
  } catch (err) {
    req.log.error({ err }, "Voice preview failed");
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Voice preview failed: ${msg}` });
  }
});

export default router;
