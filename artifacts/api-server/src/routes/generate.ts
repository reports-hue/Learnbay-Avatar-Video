import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { generateScript, generateBrandTheme, type ScriptStyle } from "../services/openai.js";
import { generateAvatarVideo, type AvatarJobConfig } from "../services/avatarService.js";
import { postProcessAvatarVideo, type CaptionStyle } from "../services/ffmpegService.js";
import { getWordTimings } from "../services/speech.js";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

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
}

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
  } = req.body as GenerateRequest;

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

  req.log.info({ topic, platform, avatar, voice, scriptStyle, captionStyle, autoBackground }, "Starting video generation");

  try {
    // Step 1: Script + brand theme (parallel)
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

    // Step 2: Word timings (for captions) — run while avatar renders
    let wordTimings: import("../services/speech.js").WordTiming[] = [];
    if (captionStyle !== "none") {
      try {
        wordTimings = await getWordTimings(script, voice);
        req.log.info({ wordCount: wordTimings.length }, "Word timings ready");
      } catch (e) {
        req.log.warn({ err: e }, "Word timings failed, continuing without");
      }
    }

    send("progress", { step: "avatar_start", percent: 25, message: "Azure AI is rendering your avatar (2–5 min)…" });

    // Step 3: Avatar synthesis
    const azureBgColor = resolvedBgColor1 + "FF";
    const avatarConfig: AvatarJobConfig = {
      script,
      character: avatar,
      style: avatarStyle,
      voice,
      voiceStyle: voiceStyle || undefined,
      backgroundColor: bgImageUrl ? "#000000FF" : azureBgColor,
      bgImageUrl: bgImageUrl || undefined,
    };

    const avatarVideoPath = await generateAvatarVideo(avatarConfig);
    send("progress", { step: "avatar_done", percent: 75, message: "Avatar rendered. Applying cinematic effects…" });

    // Step 4: Post-process
    await postProcessAvatarVideo(avatarVideoPath, {
      platform,
      logoUrl: logoUrl || undefined,
      primaryColor: resolvedAccent,
      backgroundColor: azureBgColor,
      gradientColor2: resolvedBgColor2,
      cta: cta || undefined,
      wordTimings: wordTimings.length > 0 ? wordTimings : undefined,
      captionStyle,
    });

    send("progress", { step: "done", percent: 100, message: "Your video is ready!" });
    send("done", {
      success: true,
      script,
      videoUrl: "/api/video/final.mp4",
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

export default router;
