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
  // ElevenLabs: pass API key from client when voice starts with "el:"
  elevenLabsKey?: string;
}

// ─── Video generation (SSE) ─────────────────────────────────────
router.post("/generate", async (req: Request, res: Response) => {
  const {
    topic,
    platform,
    avatar = "lisa",
    avatarStyle = "graceful-sitting",
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
  } = req.body as GenerateRequest;

  // Detect ElevenLabs voice (prefixed with "el:")
  const isElevenLabs = typeof voice === "string" && voice.startsWith("el:");
  const elVoiceId = isElevenLabs ? voice.slice(3) : null;
  const elApiKey = elevenLabsKey || process.env.ELEVENLABS_API_KEY || "";

  if (!topic || !platform) {
    res.status(400).json({ error: "topic and platform are required" });
    return;
  }

  // ── Setup SSE ──
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  function send(event: string, data: object) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
      (res as unknown as { flush: () => void }).flush();
    }
  }

  const videoId = uuidv4().replace(/-/g, "").slice(0, 12);
  req.log.info({ topic, platform, avatar, voice, scriptStyle, captionStyle, realism, pacing, videoId }, "Starting video generation");

  try {
    // ── Step 1: Script + brand theme (parallel) ──
    send("progress", { step: "script", percent: 5, message: "Crafting your AI script…" });

    const [script, brandThemeResult] = await Promise.all([
      generateScript(topic, platform, scriptStyle as ScriptStyle),
      (autoBackground || !backgroundColor) ? generateBrandTheme(topic, platform) : Promise.resolve(null),
    ]);

    let resolvedBgColor1 = (backgroundColor ?? "#000000FF").slice(0, 7);
    let resolvedBgColor2: string | undefined = requestGradientColor2;
    let resolvedAccent = primaryColor ?? "#4A9FFF";

    if (brandThemeResult) {
      resolvedBgColor1 = brandThemeResult.bgColor1;
      resolvedBgColor2 = brandThemeResult.bgColor2;
      resolvedAccent = primaryColor ?? brandThemeResult.accentColor;
    }

    send("progress", { step: "script_done", percent: 18, message: "Script ready. Getting word timings…", script });

    // ── Step 2: Word timings (for captions) ──
    const pacingRate = PACING_SSML_RATE[pacing] ?? "0.95";
    let wordTimings: import("../services/speech.js").WordTiming[] = [];

    // ElevenLabs audio synthesis — runs before avatar step since we need the public audio URL
    let elAudioUrl: string | undefined;
    if (isElevenLabs && elVoiceId) {
      if (!elApiKey) throw new Error("ElevenLabs API key is required. Add it in Settings or set ELEVENLABS_API_KEY.");
      send("progress", { step: "elevenlabs", percent: 20, message: "Synthesizing voice with ElevenLabs…" });
      const elResult = await synthesizeElevenLabs(script, elVoiceId, elApiKey);
      // Construct a publicly accessible URL for the audio file
      // Azure's servers need to reach this URL — use the Replit dev domain or PUBLIC_URL
      const publicDomain = process.env.REPLIT_DEV_DOMAIN || process.env.PUBLIC_URL;
      if (!publicDomain) throw new Error("Cannot determine public URL for ElevenLabs audio. Set REPLIT_DEV_DOMAIN or PUBLIC_URL.");
      elAudioUrl = `https://${publicDomain}/api/video/${elResult.filename}`;
      // Convert ElevenLabs ms timings → WordTiming format (startSec/durationSec)
      wordTimings = elResult.wordTimings.map(t => ({
        word: t.word,
        startSec: t.start / 1000,
        durationSec: (t.end - t.start) / 1000,
      }));
      req.log.info({ audioUrl: elAudioUrl, wordCount: wordTimings.length }, "ElevenLabs audio ready");
    } else if (captionStyle !== "none") {
      try {
        wordTimings = await getWordTimings(script, voice, pacingRate);
        req.log.info({ wordCount: wordTimings.length }, "Azure word timings ready");
      } catch (e) {
        req.log.warn({ err: e }, "Word timings failed, continuing without");
      }
    }

    send("progress", { step: "avatar_start", percent: 25, message: "Azure AI is rendering your avatar (2–5 min)…" });

    // ── Step 3: Avatar synthesis ──
    // Use green screen when realism=true and no image background (for chroma key compositing)
    const useGreenScreen = realism && !bgImageUrl;
    const azureBgColor = resolvedBgColor1 + "FF";

    const avatarConfig: AvatarJobConfig = {
      script,
      character: avatar,
      style: avatarStyle,
      voice: isElevenLabs ? "en-US-AvaMultilingualNeural" : voice, // fallback voice name (unused when audioUrl set)
      voiceStyle: voiceStyle || undefined,
      backgroundColor: azureBgColor,
      bgImageUrl: bgImageUrl || undefined,
      pacing,
      realism,
      audioUrl: elAudioUrl, // set only for ElevenLabs; triggers PreSynthesizedAudio mode
    };

    const avatarVideoPath = await generateAvatarVideo(avatarConfig);
    send("progress", { step: "avatar_done", percent: 75, message: "Avatar rendered! Applying cinematic effects…" });

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

    // ── Step 5: Generate thumbnail ──
    send("progress", { step: "done", percent: 95, message: "Generating thumbnail…" });
    const finalVideoPath = path.join(outputsDir, outputFilename);
    const thumbnailFilename = `thumb_${videoId}.jpg`;
    const thumbnailPath = path.join(outputsDir, thumbnailFilename);
    const thumbResult = await extractThumbnail(finalVideoPath, thumbnailPath);

    send("progress", { step: "done", percent: 100, message: "Your video is ready!" });
    send("done", {
      success: true,
      videoId,
      script,
      videoUrl: `/api/video/${outputFilename}`,
      thumbnailUrl: thumbResult ? `/api/video/${thumbnailFilename}` : null,
      brandTheme: {
        bgColor1: resolvedBgColor1,
        bgColor2: resolvedBgColor2 ?? resolvedBgColor1,
        accentColor: resolvedAccent,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Video generation failed");
    const message = err instanceof Error ? err.message : String(err);
    send("error", { message });
  } finally {
    res.end();
  }
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
// Generates a 5-second TTS sample of the selected voice
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
