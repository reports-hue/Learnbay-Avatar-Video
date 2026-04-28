import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { generateScript, generateBrandTheme } from "../services/openai.js";
import { generateAvatarVideo, type AvatarJobConfig } from "../services/avatarService.js";
import { postProcessAvatarVideo } from "../services/ffmpegService.js";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

export interface GenerateRequest {
  topic?: string;
  platform?: string;
  avatar?: string;
  avatarStyle?: string;
  voice?: string;
  backgroundColor?: string;
  bgImageUrl?: string;
  logoUrl?: string;
  primaryColor?: string;
  cta?: string;
  autoBackground?: boolean;
}

router.post("/generate", async (req: Request, res: Response) => {
  const {
    topic,
    platform,
    avatar = "lisa",
    avatarStyle = "graceful-sitting",
    voice = "en-US-AvaMultilingualNeural",
    backgroundColor,
    bgImageUrl,
    logoUrl,
    primaryColor,
    cta,
    autoBackground = false,
  } = req.body as GenerateRequest;

  if (!topic || !platform) {
    res.status(400).json({ error: "topic and platform are required" });
    return;
  }

  req.log.info({ topic, platform, avatar, avatarStyle, voice, autoBackground }, "Starting avatar video generation");

  try {
    req.log.info("Step 1: Generating script");
    const script = await generateScript(topic, platform);

    req.log.info("Step 1b: Resolving brand theme");
    let resolvedBgColor1 = (backgroundColor ?? "#000000FF").slice(0, 7);
    let resolvedBgColor2: string | undefined;
    let resolvedAccent = primaryColor ?? "#7C3AED";

    if (autoBackground || !backgroundColor) {
      const theme = await generateBrandTheme(topic, platform);
      resolvedBgColor1 = theme.bgColor1;
      resolvedBgColor2 = theme.bgColor2;
      resolvedAccent = primaryColor ?? theme.accentColor;
      req.log.info({ theme, resolvedAccent }, "Auto brand theme applied");
    }

    const azureBgColor = resolvedBgColor1 + "FF";

    req.log.info("Step 2: Generating avatar video via Azure");
    const avatarConfig: AvatarJobConfig = {
      script,
      character: avatar,
      style: avatarStyle,
      voice,
      backgroundColor: bgImageUrl ? "#000000FF" : azureBgColor,
      bgImageUrl: bgImageUrl || undefined,
    };
    const avatarVideoPath = await generateAvatarVideo(avatarConfig);

    req.log.info("Step 3: Post-processing (resize, logo, branding, CTA)");
    await postProcessAvatarVideo(avatarVideoPath, {
      platform,
      logoUrl: logoUrl || undefined,
      primaryColor: resolvedAccent,
      backgroundColor: azureBgColor,
      gradientColor2: resolvedBgColor2,
      cta: cta || undefined,
    });

    res.json({
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
    res.status(500).json({ error: message });
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
