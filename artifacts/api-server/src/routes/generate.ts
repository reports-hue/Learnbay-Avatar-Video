import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { generateScript, generateBrandTheme, type ScriptStyle } from "../services/openai.js";
import { generateAvatarVideo, type AvatarJobConfig, type PacingRate } from "../services/avatarService.js";
import { postProcessAvatarVideo, extractThumbnail, type CaptionStyle } from "../services/ffmpegService.js";
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
  } = body;

  const isElevenLabs = typeof voice === "string" && voice.startsWith("el:");
  const elVoiceId = isElevenLabs ? voice.slice(3) : null;
  const elApiKey = elevenLabsKey || process.env.ELEVENLABS_API_KEY || "";

  const videoId = uuidv4().replace(/-/g, "").slice(0, 12);

  try {
    updateJob(jobId, { status: "running", step: "script", percent: 5, message: "Crafting your AI script…" });

    const [script, brandThemeResult] = await Promise.all([
      generateScript(topic, platform, scriptStyle as ScriptStyle),
      (autoBackground || !backgroundColor)
        ? generateBrandTheme(topic, platform)
        : Promise.resolve(null),
    ]);

    let resolvedBgColor1 = (backgroundColor ?? "#000000FF").slice(0, 7);
    let resolvedBgColor2: string | undefined = requestGradientColor2;
    let resolvedAccent = primaryColor ?? "#4A9FFF";

    if (brandThemeResult) {
      resolvedBgColor1 = brandThemeResult.bgColor1;
      resolvedBgColor2 = brandThemeResult.bgColor2;
      resolvedAccent = primaryColor ?? brandThemeResult.accentColor;
    }

    updateJob(jobId, { step: "script_done", percent: 18, message: "Script ready. Getting word timings…", script });

    // ── Step 2: Word timings / ElevenLabs TTS ──
    const pacingRate = PACING_SSML_RATE[pacing] ?? "0.95";
    let wordTimings: import("../services/speech.js").WordTiming[] = [];
    let elAudioUrl: string | undefined;

    if (isElevenLabs && elVoiceId) {
      if (!elApiKey) throw new Error("ElevenLabs API key is required. Add it in Voice Settings.");
      updateJob(jobId, { step: "elevenlabs", percent: 20, message: "Synthesizing voice with ElevenLabs…" });
      const elResult = await synthesizeElevenLabs(script, elVoiceId, elApiKey);
      const publicDomain = process.env.REPLIT_DEV_DOMAIN || process.env.PUBLIC_URL;
      if (!publicDomain) throw new Error("Cannot determine public URL for ElevenLabs audio. Set REPLIT_DEV_DOMAIN or PUBLIC_URL.");
      elAudioUrl = `https://${publicDomain}/api/video/${elResult.filename}`;
      wordTimings = elResult.wordTimings.map(t => ({
        word: t.word,
        startSec: t.start / 1000,
        durationSec: (t.end - t.start) / 1000,
      }));
    } else if (captionStyle !== "none") {
      try {
        wordTimings = await getWordTimings(script, voice, pacingRate);
      } catch {
        // captions will be skipped
      }
    }

    updateJob(jobId, { step: "avatar_start", percent: 25, message: "Azure AI is rendering your avatar (2–5 min)…" });

    // ── Step 3: Avatar synthesis ──
    const useGreenScreen = realism && !bgImageUrl;
    const azureBgColor = resolvedBgColor1 + "FF";

    const avatarConfig: AvatarJobConfig = {
      script,
      character: avatar,
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
      cta: cta || undefined,
      wordTimings: wordTimings.length > 0 ? wordTimings : undefined,
      captionStyle,
      outputFilename,
      useGreenScreen,
      realism,
      script,
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
    const message = err instanceof Error ? err.message : String(err);
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
