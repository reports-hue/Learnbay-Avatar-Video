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
  // When set, use pre-synthesized audio (e.g. ElevenLabs) instead of Azure TTS
  audioUrl?: string;
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
  "en-US-AndrewNeural": ["chat", "excited", "friendly"],
  "en-US-EmmaNeural": ["chat", "cheerful", "excited"],
  "en-US-BrianNeural": ["chat", "friendly"],
};

export { VOICE_STYLES };

// Extract locale from voice short name (e.g. hi-IN-SwaraNeural → hi-IN)
function extractLocale(voice: string): string {
  const parts = voice.split("-");
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return "en-US";
}

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

// Add natural breaks for commas (shorter = less avatar head reset)
function addBreaks(sentence: string): string {
  return xmlEscape(sentence).replace(/,/g, ",<break time=\"80ms\"/>");
}

function buildSsml(
  script: string,
  voice: string,
  voiceStyle?: string,
  pacing: PacingRate = "natural"
): string {
  const rate = PACING_VALUES[pacing];
  const lang = extractLocale(voice);
  const sentences = splitSentences(script);
  const styles = VOICE_STYLES[voice] ?? [];
  const effectiveStyle = voiceStyle && styles.includes(voiceStyle) ? voiceStyle : (styles.includes("chat") ? "chat" : null);

  // Build sentence-level content — NO explicit breaks between sentences.
  // Rely on the TTS engine's natural sentence rhythm + short boundary silence.
  // This prevents the avatar from hitting a "dead" pause and resetting head position.
  const sentenceXml = sentences
    .map((s, i) => {
      // Slight micro-rate variation between sentences for natural cadence
      const microRate = i % 2 === 0 ? +parseFloat(rate) - 0.02 : +parseFloat(rate) + 0.02;
      return `<prosody rate="${microRate.toFixed(2)}">${addBreaks(s)}</prosody>`;
    })
    .join(" ");

  // Wrap all in one parent prosody block with minimal sentence boundary silence
  const prosodyContent = `<prosody pitch="-2%"><mstts:silence type="Sentenceboundary" value="80ms"/>${sentenceXml}</prosody>`;

  // Only add express-as if voice supports it (mainly English Neural voices)
  const supportsStyle = styles.length > 0;
  const inner = effectiveStyle && supportsStyle
    ? `<mstts:express-as style="${effectiveStyle}" styledegree="1.1">${prosodyContent}</mstts:express-as>`
    : prosodyContent;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}">${inner}</voice></speak>`;
}

export async function generateAvatarVideo(config: AvatarJobConfig): Promise<string> {
  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  const jobId = uuidv4();

  // Use 2024-04-15-preview because it supports `inputKind: "PreSynthesizedAudio"`
  // (lip-sync to externally-supplied audio such as ElevenLabs). The 2024-08-01
  // GA version dropped that input kind and only accepts PlainText/SSML.
  const baseUrl = `https://${region}.api.cognitive.microsoft.com/avatar/batchsyntheses/${jobId}?api-version=2024-04-15-preview`;

  // In realism mode: use green screen background for chroma key compositing
  const effectiveBgColor = config.realism !== false ? "#00FF00FF" : config.backgroundColor;

  const avatarConfig: Record<string, unknown> = {
    customized: false,
    talkingAvatarCharacter: config.character || "lisa",
    ...(config.style ? { talkingAvatarStyle: config.style } : {}),
    videoFormat: "mp4",
    videoCodec: "h264",
    backgroundColor: config.bgImageUrl ? "#000000FF" : effectiveBgColor,
    bitrateKbps: 4000,
    subtitleType: "none",
  };

  // backgroundImage must be a plain URL string per the official OpenAPI spec
  if (config.bgImageUrl) {
    avatarConfig["backgroundImage"] = config.bgImageUrl;
  }

  let requestBody: Record<string, unknown>;

  if (config.audioUrl) {
    // Pre-synthesized audio mode (e.g. ElevenLabs) — avatar lip-syncs to external audio
    logger.info({ audioUrl: config.audioUrl }, "Using PreSynthesizedAudio mode");
    requestBody = {
      synthesisConfig: { voice: config.voice },
      customVoices: {},
      avatarConfig,
      inputKind: "PreSynthesizedAudio",
      inputs: [{ audioUrl: config.audioUrl }],
    };
  } else {
    // Default: SSML with Azure TTS
    const ssml = buildSsml(config.script, config.voice, config.voiceStyle, config.pacing ?? "natural");
    requestBody = {
      synthesisConfig: { voice: config.voice },
      customVoices: {},
      avatarConfig,
      inputKind: "SSML",
      inputs: [{ content: ssml }],
    };
  }

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
