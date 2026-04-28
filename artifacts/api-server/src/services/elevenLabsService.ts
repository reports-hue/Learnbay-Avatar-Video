import axios from "axios";
import { writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  description?: string;
  preview_url: string;
}

export interface ElWordTiming {
  word: string;
  start: number; // ms
  end: number;   // ms
}

export interface ElevenLabsSynthResult {
  filename: string;
  localPath: string;
  wordTimings: ElWordTiming[];
}

// ─── List voices from ElevenLabs ─────────────────────────────────
export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const response = await axios.get("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
    timeout: 10000,
  });
  const voices = (response.data as { voices: ElevenLabsVoice[] }).voices ?? [];
  return voices.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Synthesize speech + get word timings ────────────────────────
export async function synthesizeElevenLabs(
  script: string,
  voiceId: string,
  apiKey: string
): Promise<ElevenLabsSynthResult> {
  const filename = `el_${uuidv4().replace(/-/g, "").slice(0, 12)}.mp3`;
  const localPath = path.join(outputsDir, filename);

  logger.info({ voiceId, chars: script.length }, "Calling ElevenLabs TTS with-timestamps");

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      text: script,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      timeout: 120_000,
    }
  );

  const data = response.data as {
    audio_base64: string;
    alignment: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
  };

  // Save audio
  await writeFile(localPath, Buffer.from(data.audio_base64, "base64"));
  logger.info({ filename }, "ElevenLabs audio saved");

  // Convert character-level alignment → word timings (in ms)
  const wordTimings = charAlignmentToWords(data.alignment);
  logger.info({ wordCount: wordTimings.length }, "Word timings extracted from ElevenLabs alignment");

  return { filename, localPath, wordTimings };
}

// ─── Preview: short TTS sample ────────────────────────────────────
export async function previewElevenLabsVoice(
  voiceId: string,
  apiKey: string
): Promise<Buffer> {
  const sampleText = "Hi! I'm your AI video presenter. Here's what I'll sound like in your video.";

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text: sampleText,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout: 30_000,
    }
  );

  return Buffer.from(response.data as ArrayBuffer);
}

// ─── Internal: char alignment → word timings ────────────────────
function charAlignmentToWords(alignment: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): ElWordTiming[] {
  const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
  const words: ElWordTiming[] = [];
  let currentWord = "";
  let wordStart = 0;

  for (let i = 0; i <= characters.length; i++) {
    const char = i < characters.length ? characters[i] : " ";
    const isSpace = char === " " || char === "\n" || i === characters.length;
    const start = i < character_start_times_seconds.length ? character_start_times_seconds[i] : 0;
    const end = i > 0 && i - 1 < character_end_times_seconds.length
      ? character_end_times_seconds[i - 1]
      : 0;

    if (isSpace) {
      const trimmed = currentWord.replace(/[.,!?;:"'()\-]/g, "").trim();
      if (trimmed) {
        words.push({ word: trimmed, start: wordStart * 1000, end: end * 1000 });
      }
      currentWord = "";
    } else {
      if (!currentWord) {
        wordStart = start;
      }
      currentWord += char;
    }
  }

  return words;
}
