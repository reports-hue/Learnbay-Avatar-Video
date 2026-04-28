import axios from "axios";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

export interface AvatarJobConfig {
  script: string;
  character: string;
  style: string;
  voice: string;
  voiceStyle?: string;
  backgroundColor: string;
  bgImageUrl?: string;
}

// Supported SSML speaking styles per Azure TTS voice
const VOICE_STYLES: Record<string, string[]> = {
  "en-US-AriaNeural": ["chat", "empathetic", "narration-professional", "newscast-casual", "customerservice"],
  "en-US-JennyNeural": ["assistant", "chat", "customerservice", "newscast"],
  "en-US-GuyNeural": ["narration-professional", "newscast"],
  "en-US-DavisNeural": ["chat", "cheerful", "excited", "friendly", "hopeful", "angry"],
  "en-GB-SoniaNeural": ["cheerful", "sad"],
};

function buildSsml(script: string, voice: string, voiceStyle?: string): string {
  const safeScript = script
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const styles = VOICE_STYLES[voice];
  const useStyle = voiceStyle && styles?.includes(voiceStyle);

  const inner = useStyle
    ? `<mstts:express-as style="${voiceStyle}" styledegree="1.3">${safeScript}</mstts:express-as>`
    : safeScript;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${voice}">${inner}</voice></speak>`;
}

export { VOICE_STYLES };

export async function generateAvatarVideo(config: AvatarJobConfig): Promise<string> {
  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  const jobId = uuidv4();

  const baseUrl = `https://${region}.api.cognitive.microsoft.com/avatar/batchsyntheses/${jobId}?api-version=2024-04-15-preview`;

  const useSSML = !!(config.voiceStyle && VOICE_STYLES[config.voice]?.includes(config.voiceStyle));

  const avatarConfig: Record<string, unknown> = {
    customized: false,
    talkingAvatarCharacter: config.character,
    talkingAvatarStyle: config.style,
    videoFormat: "mp4",
    videoCodec: "h264",
    backgroundColor: config.backgroundColor,
  };

  if (config.bgImageUrl) {
    avatarConfig["backgroundImage"] = {
      url: config.bgImageUrl,
      fileName: "background.jpg",
    };
  }

  const requestBody: Record<string, unknown> = {
    avatarConfig,
  };

  if (useSSML) {
    requestBody["inputKind"] = "SSML";
    requestBody["inputs"] = [{ content: buildSsml(config.script, config.voice, config.voiceStyle) }];
    logger.info({ voice: config.voice, voiceStyle: config.voiceStyle }, "Using SSML with emotion style");
  } else {
    requestBody["synthesisConfig"] = { voice: config.voice };
    requestBody["inputKind"] = "PlainText";
    requestBody["inputs"] = [{ content: config.script }];
  }

  logger.info({ jobId, character: config.character, style: config.style, voice: config.voice, useSSML }, "Submitting avatar synthesis job");

  await axios.put(baseUrl, requestBody, {
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/json",
    },
  });

  logger.info({ jobId }, "Avatar job submitted, polling for completion");

  const maxWaitMs = 25 * 60 * 1000;
  const pollIntervalMs = 6000;
  const pollStart = Date.now();

  while (Date.now() - pollStart < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const statusRes = await axios.get(baseUrl, {
      headers: { "Ocp-Apim-Subscription-Key": key },
    });

    const { status, outputs, properties } = statusRes.data as {
      status: string;
      outputs?: { result?: string };
      properties?: { error?: unknown };
    };

    logger.info({ jobId, status }, "Avatar job status");

    if (status === "Succeeded") {
      const videoUrl = outputs?.result;
      if (!videoUrl) throw new Error("Avatar job succeeded but no result URL found");
      const outputPath = path.join(outputsDir, "avatar_raw.mp4");
      await downloadFile(videoUrl, outputPath);
      logger.info({ outputPath }, "Avatar video downloaded");
      return outputPath;
    }

    if (status === "Failed") {
      throw new Error(`Avatar synthesis failed: ${JSON.stringify(properties?.error ?? "unknown")}`);
    }
  }

  throw new Error("Avatar synthesis timed out after 25 minutes");
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await axios.get<NodeJS.ReadableStream>(url, { responseType: "stream" });
  const writer = createWriteStream(dest);
  return new Promise((resolve, reject) => {
    (response.data as NodeJS.ReadableStream).pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}
