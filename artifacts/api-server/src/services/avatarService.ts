import axios from "axios";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

export type PacingRate = "slow" | "natural" | "fast";

const PACING_VALUES: Record<PacingRate, string> = {
  slow: "0.88",
  natural: "0.95",
  fast: "1.05",
};

export interface AvatarJobConfig {
  script: string;
  character: string;
  style: string;
  voice: string;
  voiceStyle?: string;
  backgroundColor: string;
  bgImageUrl?: string;
  pacing?: PacingRate;
  realism?: boolean;
}

// Supported SSML speaking styles per Azure TTS voice
const VOICE_STYLES: Record<string, string[]> = {
  "en-US-AriaNeural": ["chat", "empathetic", "narration-professional", "newscast-casual", "customerservice"],
  "en-US-JennyNeural": ["assistant", "chat", "customerservice", "newscast"],
  "en-US-GuyNeural": ["narration-professional", "newscast"],
  "en-US-DavisNeural": ["chat", "cheerful", "excited", "friendly", "hopeful", "angry"],
  "en-GB-SoniaNeural": ["cheerful", "sad"],
  "en-US-AvaMultilingualNeural": ["chat", "cheerful", "excited"],
  "en-US-AndrewMultilingualNeural": ["chat", "excited"],
};

export { VOICE_STYLES };

// Split text into sentences for natural pause insertion
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Escape XML special characters
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Insert natural breathing pauses (break after commas, between sentences)
function addBreaks(sentence: string): string {
  // Add short break after commas
  return xmlEscape(sentence).replace(/,/g, ",<break time=\"150ms\"/>");
}

function buildSsml(
  script: string,
  voice: string,
  voiceStyle?: string,
  pacing: PacingRate = "natural"
): string {
  const rate = PACING_VALUES[pacing];
  const sentences = splitSentences(script);
  const styles = VOICE_STYLES[voice] ?? [];
  const effectiveStyle = voiceStyle && styles.includes(voiceStyle) ? voiceStyle : (styles.includes("chat") ? "chat" : null);

  // Build sentence-level content with breathing pauses between
  const sentenceXml = sentences
    .map((s) => `${addBreaks(s)}<break time="300ms"/>`)
    .join("\n    ");

  const prosodyContent = `<prosody rate="${rate}" pitch="-2%"><mstts:silence type="Sentenceboundary" value="200ms"/>\n    ${sentenceXml}\n  </prosody>`;

  const inner = effectiveStyle
    ? `<mstts:express-as style="${effectiveStyle}" styledegree="1.2">${prosodyContent}</mstts:express-as>`
    : prosodyContent;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${voice}">${inner}</voice></speak>`;
}

export async function generateAvatarVideo(config: AvatarJobConfig): Promise<string> {
  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  const jobId = uuidv4();

  const baseUrl = `https://${region}.api.cognitive.microsoft.com/avatar/batchsyntheses/${jobId}?api-version=2024-04-15-preview`;

  // In realism mode: use green screen background for chroma key compositing
  const effectiveBgColor = config.realism !== false ? "#00FF00FF" : config.backgroundColor;

  const avatarConfig: Record<string, unknown> = {
    customized: false,
    talkingAvatarCharacter: config.character || "lisa",
    talkingAvatarStyle: config.style || "graceful-sitting",
    videoFormat: "mp4",
    videoCodec: "h264",
    backgroundColor: config.bgImageUrl ? "#000000FF" : effectiveBgColor,
  };

  if (config.bgImageUrl) {
    avatarConfig["backgroundImage"] = { url: config.bgImageUrl, fileName: "background.jpg" };
  }

  // Always use SSML for maximum realism
  const ssml = buildSsml(config.script, config.voice, config.voiceStyle, config.pacing ?? "natural");
  const requestBody: Record<string, unknown> = {
    avatarConfig,
    inputKind: "SSML",
    inputs: [{ content: ssml }],
  };

  logger.info({ jobId, character: config.character, style: config.style, voice: config.voice, pacing: config.pacing, realism: config.realism !== false, bgColor: effectiveBgColor }, "Submitting avatar synthesis job");

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
