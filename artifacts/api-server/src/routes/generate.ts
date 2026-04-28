import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { generateScript } from "../services/openai.js";
import { generateVoice } from "../services/speech.js";
import { generateSRT } from "../utils/srtGenerator.js";
import { processVideo } from "../services/ffmpegService.js";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../../outputs");

router.post("/generate", async (req: Request, res: Response) => {
  const { topic, platform } = req.body as { topic?: string; platform?: string };

  if (!topic || !platform) {
    res.status(400).json({ error: "topic and platform are required" });
    return;
  }

  req.log.info({ topic, platform }, "Starting video generation");

  try {
    req.log.info("Step 1: Generating script");
    const script = await generateScript(topic, platform);

    req.log.info("Step 2: Generating voice");
    await generateVoice(script);

    req.log.info("Step 3: Generating subtitles");
    await generateSRT(script);

    req.log.info("Step 4: Processing video with FFmpeg");
    await processVideo(platform);

    res.json({
      success: true,
      script,
      videoUrl: "/api/video/final.mp4",
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
