import { Router, type IRouter, type Request, type Response } from "express";
import axios from "axios";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger.js";
import { listElevenLabsVoices, previewElevenLabsVoice } from "../services/elevenLabsService.js";
import { prepareLogoFromBuffer } from "../services/logoService.js";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

// ─── In-memory voice cache ────────────────────────────────────────
let voiceCache: AzureVoice[] | null = null;
let voiceCacheExpiry = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface AzureVoice {
  value: string;
  label: string;
  locale: string;
  localeName: string;
  gender: "Male" | "Female";
  isHD: boolean;
  isMultilingual: boolean;
  styles: string[];
}

// ─── GET /api/voices ─────────────────────────────────────────────
router.get("/voices", async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (voiceCache && now < voiceCacheExpiry) {
      res.json(voiceCache);
      return;
    }

    const region = process.env.AZURE_SPEECH_REGION ?? "eastus";
    const key = process.env.AZURE_SPEECH_KEY ?? "";

    const response = await axios.get(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
      { headers: { "Ocp-Apim-Subscription-Key": key } }
    );

    const rawVoices = response.data as Array<{
      ShortName: string;
      LocalName?: string;
      Locale: string;
      LocaleName: string;
      Gender: "Male" | "Female";
      StyleList?: string[];
    }>;

    voiceCache = rawVoices.map((v) => {
      const isHD = v.ShortName.includes("DragonHD") || v.ShortName.includes("OmniLatest");
      const isMultilingual = v.ShortName.includes("Multilingual") || v.ShortName.includes("Turbo");
      // Build a clean label from the short name suffix
      const suffix = v.ShortName.split("-").slice(2).join("-")
        .replace(/Neural$/, "")
        .replace(/LatestNeural$/, "")
        .replace(/DragonHDLatestNeural$/, "")
        .replace(/DragonHDFlashLatestNeural$/, "")
        .replace(/OmniLatestNeural$/, "")
        .replace(/MultilingualNeural$/, "")
        .replace(/TurboMultilingualNeural$/, "")
        .replace(/:DragonHD.*$/, "")
        .replace(/:MAI-Voice-\d$/, "")
        .trim();

      return {
        value: v.ShortName,
        label: suffix || v.ShortName,
        locale: v.Locale,
        localeName: v.LocaleName,
        gender: v.Gender,
        isHD,
        isMultilingual,
        styles: v.StyleList ?? [],
      };
    });

    voiceCacheExpiry = now + CACHE_TTL;
    logger.info({ count: voiceCache.length }, "Voice list fetched and cached");
    res.json(voiceCache);
  } catch (err) {
    logger.error({ err }, "Failed to fetch voice list");
    res.status(500).json({ error: "Failed to fetch voices" });
  }
});

// ─── POST /api/upload-photo ──────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: outputsDir,
    filename: (_req, _file, cb) => {
      cb(null, `photo_${uuidv4().replace(/-/g, "").slice(0, 12)}.jpg`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

router.post("/upload-photo", upload.single("photo"), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No photo uploaded" });
    return;
  }
  const photoUrl = `/api/video/${req.file.filename}`;
  logger.info({ filename: req.file.filename }, "Photo uploaded");
  res.json({ photoUrl, filename: req.file.filename, localPath: req.file.path });
});

// ─── POST /api/upload-logo ──────────────────────────────────────
//
// Accepts a multipart "logo" field with PNG/JPEG/GIF/WEBP/BMP/SVG. SVG is
// rasterized to PNG via ImageMagick (logoService.prepareLogoFromBuffer) so
// the render pipeline can use it directly. Returns a `/api/video/...` URL
// suitable for storing in `BrandProfile.logoUrl`.
//
// Files go through MEMORY storage (not multer disk), because the SVG path
// has to rasterize before persisting — writing the raw SVG to disk first
// then converting wastes a round trip. 5MB upload cap matches the URL
// downloader.
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith("image/") ||
      file.mimetype === "application/octet-stream"; // some browsers send SVG with this
    if (ok) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

router.post(
  "/upload-logo",
  uploadLogo.single("logo"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No logo uploaded" });
      return;
    }
    try {
      const asset = await prepareLogoFromBuffer(
        req.file.buffer,
        outputsDir,
        req.file.mimetype,
      );
      // logoService writes to outputsDir/logo_dl.png by convention. Move
      // the file to a unique name so multiple users uploading concurrently
      // don't clobber each other.
      const finalName = `logo_${uuidv4().replace(/-/g, "").slice(0, 12)}.png`;
      const finalPath = path.join(outputsDir, finalName);
      await (await import("fs/promises")).rename(asset.path, finalPath);
      const logoUrl = `/api/video/${finalName}`;
      logger.info(
        { filename: finalName, fmt: asset.sourceFormat, w: asset.width, h: asset.height },
        "Logo uploaded",
      );
      res.json({
        logoUrl,
        filename: finalName,
        width: asset.width,
        height: asset.height,
        sourceFormat: asset.sourceFormat,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "Logo upload failed");
      res.status(400).json({ error: msg });
    }
  },
);

// ─── GET /api/elevenlabs/status ─────────────────────────────────
router.get("/elevenlabs/status", (_req: Request, res: Response) => {
  const hasServerKey = !!(process.env.ELEVENLABS_API_KEY);
  res.json({ hasServerKey });
});

// ─── GET /api/elevenlabs/voices ──────────────────────────────────
router.get("/elevenlabs/voices", async (req: Request, res: Response) => {
  const apiKey = (req.headers["x-elevenlabs-key"] as string) || process.env.ELEVENLABS_API_KEY || "";
  if (!apiKey) {
    res.status(400).json({ error: "ElevenLabs API key required. Pass it in x-elevenlabs-key header." });
    return;
  }
  try {
    const voices = await listElevenLabsVoices(apiKey);
    res.json(voices);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Failed to fetch ElevenLabs voices");
    const isAuthError = msg.includes("401") || msg.includes("Unauthorized");
    res.status(isAuthError ? 401 : 500).json({
      error: isAuthError ? "Invalid ElevenLabs API key" : `Failed to fetch voices: ${msg}`,
    });
  }
});

// ─── POST /api/elevenlabs/preview ────────────────────────────────
router.post("/elevenlabs/preview", async (req: Request, res: Response) => {
  const { voiceId } = req.body as { voiceId?: string };
  const apiKey = (req.headers["x-elevenlabs-key"] as string) || process.env.ELEVENLABS_API_KEY || "";
  if (!apiKey || !voiceId) {
    res.status(400).json({ error: "voiceId and ElevenLabs API key required" });
    return;
  }
  try {
    const audioBuffer = await previewElevenLabsVoice(voiceId, apiKey);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audioBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "ElevenLabs preview failed");
    res.status(500).json({ error: `Preview failed: ${msg}` });
  }
});

export default router;
