import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { generateScript, generateBrandTheme, researchCompanyForScript, type ScriptStyle } from "../services/openai.js";
import { generateAvatarVideo, type AvatarJobConfig, type PacingRate } from "../services/avatarService.js";
import { postProcessAvatarVideo, extractThumbnail, type CaptionStyle } from "../services/ffmpegService.js";
import { generateBackgroundImage } from "../services/imageGenerationService.js";
import { getWordTimings } from "../services/speech.js";
import { synthesizeElevenLabs } from "../services/elevenLabsService.js";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

const PACING_SSML_RATE: Record<PacingRate, string> = {
  slow: "0.88",
  natural: "0.95",
  fast: "1.05",
};

// ─── Job store ─────────────────────────────────────────────────────
export interface JobResult {
  videoId: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  script: string;
  brandTheme: { bgColor1: string; bgColor2: string; accentColor: string };
}

export interface JobState {
  status: "pending" | "running" | "done" | "failed";
  step: string;
  percent: number;
  message: string;
  script?: string;
  result?: JobResult;
  error?: string;
  createdAt: number;
}

const jobs = new Map<string, JobState>();

// Clean up jobs older than 4 hours
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

function updateJob(jobId: string, patch: Partial<JobState>) {
  const existing = jobs.get(jobId);
  if (existing) jobs.set(jobId, { ...existing, ...patch });
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
  } = body;

  // Whitelist of Azure Avatar characters confirmed to work with this API version
  const VALID_AVATAR_CHARACTERS = ["lisa", "harry", "jeff"];
  const resolvedAvatar = VALID_AVATAR_CHARACTERS.includes(avatar) ? avatar : "lisa";
  if (avatar !== resolvedAvatar) {
    logger.warn({ avatar }, "Unknown avatar character, falling back to lisa");
  }

  const isElevenLabs = typeof voice === "string" && voice.startsWith("el:");
  const elVoiceId = isElevenLabs ? voice.slice(3) : null;
  const elApiKey = elevenLabsKey || process.env.ELEVENLABS_API_KEY || "";

  const videoId = uuidv4().replace(/-/g, "").slice(0, 12);

  try {
    updateJob(jobId, { status: "running", step: "script", percent: 5, message: "Researching your topic & crafting AI script…" });

    // Run company research (if brand profile present) and theme generation in parallel
    const needsResearch = companyName.trim().length > 0;
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

    const script = await generateScript(topic, platform, scriptStyle as ScriptStyle, companyContext || undefined);

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
          `bg_${videoId}.jpg`
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

    // ── Step 2: Word timings / ElevenLabs TTS ──
    const pacingRate = PACING_SSML_RATE[pacing] ?? "0.95";
    let wordTimings: import("../services/speech.js").WordTiming[] = [];
    let elAudioUrl: string | undefined;
    let elAudioPath: string | undefined;

    if (isElevenLabs && elVoiceId) {
      if (!elApiKey) throw new Error("ElevenLabs API key is required. Add it in Voice Settings.");
      updateJob(jobId, { step: "elevenlabs", percent: 20, message: "Synthesizing voice with ElevenLabs…" });
      const elResult = await synthesizeElevenLabs(script, elVoiceId, elApiKey);
      elAudioPath = path.join(outputsDir, elResult.filename);
      const publicDomain = process.env.REPLIT_DEV_DOMAIN || process.env.PUBLIC_URL;
      if (!publicDomain) throw new Error("Cannot determine public URL for ElevenLabs audio. Set REPLIT_DEV_DOMAIN or PUBLIC_URL.");
      elAudioUrl = `https://${publicDomain}/api/video/${elResult.filename}`;
      wordTimings = elResult.wordTimings.map(t => ({
        word: t.word,
        startSec: t.start / 1000,
        durationSec: (t.end - t.start) / 1000,
      }));
    } else if (captionStyle !== "none") {
      // Hard rule: never silently fall back to estimated timing. If the SDK
      // can't deliver real word-boundary events, fail the render with a clear
      // error rather than shipping mistimed captions.
      wordTimings = await getWordTimings(script, voice, pacingRate);
    }

    updateJob(jobId, { step: "avatar_start", percent: 25, message: "Azure AI is rendering your avatar (2–5 min)…" });

    // ── Step 3: Avatar synthesis ──
    const useGreenScreen = realism && !bgImageUrl;
    const azureBgColor = resolvedBgColor1 + "FF";

    const avatarConfig: AvatarJobConfig = {
      script,
      character: resolvedAvatar,
      style: avatarStyle,
      voice: isElevenLabs ? "en-US-AvaMultilingualNeural" : voice,
      voiceStyle: voiceStyle || undefined,
      backgroundColor: azureBgColor,
      bgImageUrl: bgImageUrl || undefined,
      pacing,
      realism,
      audioUrl: elAudioUrl,
    };

    const avatarVideoPath = await generateAvatarVideo(avatarConfig);
    updateJob(jobId, { step: "avatar_done", percent: 75, message: "Avatar rendered! Applying cinematic effects…" });

    // ── Step 4: Post-process ──
    const outputFilename = `video_${videoId}.mp4`;
    await postProcessAvatarVideo(avatarVideoPath, {
      platform,
      logoUrl: logoUrl || undefined,
      primaryColor: resolvedAccent,
      backgroundColor: azureBgColor,
      gradientColor2: resolvedBgColor2,
      backgroundStyle: brandThemeResult?.backgroundStyle,
      bgImagePath: aiBgImagePath,
      cta: cta || undefined,
      wordTimings: wordTimings.length > 0 ? wordTimings : undefined,
      captionStyle,
      outputFilename,
      useGreenScreen,
      realism,
      script,
      elAudioPath,
    });

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
    };

    updateJob(jobId, { status: "done", step: "done", percent: 100, message: "Your video is ready!", result });
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

// ─── POST /api/generate — start job, return jobId immediately ─────
router.post("/generate", async (req: Request, res: Response) => {
  const body = req.body as GenerateRequest;
  const { topic, platform } = body;

  if (!topic || !platform) {
    res.status(400).json({ error: "topic and platform are required" });
    return;
  }

  const jobId = uuidv4().replace(/-/g, "").slice(0, 16);
  jobs.set(jobId, {
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
  const completed = Array.from(jobs.entries())
    .filter(([, j]) => j.status === "done" && j.result)
    .map(([id, j]) => ({ jobId: id, ...j.result }));
  res.json(completed);
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
  const job = jobs.get(jobId ?? "");
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
