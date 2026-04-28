import { Router, type IRouter, type Request, type Response } from "express";
import axios from "axios";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger.js";

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

export default router;
