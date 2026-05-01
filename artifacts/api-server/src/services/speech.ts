import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { logger } from "../lib/logger.js";

export interface WordTiming {
  word: string;
  startSec: number;
  durationSec: number;
}

// Voices that support mstts:express-as style="chat"
const CHAT_STYLE_VOICES = new Set([
  "en-US-AvaMultilingualNeural",
  "en-US-AriaNeural",
  "en-US-JennyNeural",
  "en-US-AndrewMultilingualNeural",
  "en-US-DavisNeural",
]);

// Escape XML
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Wrap ALL-CAPS words with emphasis
function addEmphasis(text: string): string {
  return text.replace(/\b([A-Z]{2,})\b/g, (_, word) =>
    `<emphasis level="moderate">${xmlEscape(word)}</emphasis>`
  );
}

// Split into sentences, apply alternating micro-rate variation
function buildSentenceXml(script: string): string {
  const sentences = script.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const rates = ["0.93", "0.97"];
  return sentences
    .map((sentence, i) => {
      const rate = rates[i % 2];
      const safe = addEmphasis(xmlEscape(sentence));
      return `<prosody rate="${rate}">${safe}</prosody>`;
    })
    .join("<break time=\"250ms\"/>");
}

// Build SSML for word-timing synthesis (matches the pacing in the avatar video)
function buildTimingSsml(script: string, voiceName: string, pacingRate = "0.95", leadingBreakMs = 0): string {
  const useChat = CHAT_STYLE_VOICES.has(voiceName);
  const sentenceXml = buildSentenceXml(script);

  // Optional leading break: mirrors the break added to the avatar SSML so the
  // word-boundary audioOffset values are shifted by the same duration.
  const breakTag = leadingBreakMs > 0 ? `<break time="${leadingBreakMs}ms"/>` : "";

  const prosodyWrapper = `<prosody rate="${pacingRate}" pitch="-1%">${breakTag}${sentenceXml}</prosody>`;

  const inner = useChat
    ? `<mstts:express-as style="chat" styledegree="1.1">${prosodyWrapper}</mstts:express-as>`
    : prosodyWrapper;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${voiceName}">${inner}</voice></speak>`;
}

export async function getWordTimings(
  script: string,
  voiceName: string,
  pacingRate = "0.95",
  leadingBreakMs = 0
): Promise<WordTiming[]> {
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";
  if (!key) {
    throw new Error(
      "AZURE_SPEECH_KEY is not set — cannot collect word boundary events. " +
      "Captions require real Azure Speech SDK timestamps; estimates are not allowed."
    );
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
  speechConfig.speechSynthesisVoiceName = voiceName;

  // Pull-stream sink — we don't need the audio bytes, only the wordBoundary events
  const pullStream = sdk.AudioOutputStream.createPullStream();
  const audioConfig = sdk.AudioConfig.fromStreamOutput(pullStream);
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

  const timings: WordTiming[] = [];

  synthesizer.wordBoundary = (_s, e) => {
    if (e.boundaryType === sdk.SpeechSynthesisBoundaryType.Word) {
      timings.push({
        word: e.text,
        startSec: e.audioOffset / 10_000_000,
        durationSec: e.duration / 10_000_000,
      });
    }
  };

  const expectedWordCount = script.split(/\s+/).filter(Boolean).length;
  logger.info(
    { voiceName, expectedWordCount, pacingRate },
    "Getting word timings via Azure Speech SDK wordBoundary events"
  );

  const ssml = buildTimingSsml(script, voiceName, pacingRate, leadingBreakMs);

  return new Promise((resolve, reject) => {
    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();
        if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
          // Hard rule: NEVER fall back to estimated timing. Fail loudly.
          reject(
            new Error(
              `Azure Speech SDK synthesis did not complete (reason=${result.reason}). ` +
              `Word boundary events cannot be derived; captions require real SDK timestamps.`
            )
          );
          return;
        }
        if (timings.length === 0) {
          // Hard rule: NEVER fall back to estimated timing.
          reject(
            new Error(
              "Azure Speech SDK returned zero wordBoundary events. " +
              "Cannot generate captions without real per-word timestamps."
            )
          );
          return;
        }

        // Verification logging — first 5 timestamps + drift check
        const preview = timings.slice(0, 5).map((t) => ({
          word: t.word,
          start: +t.startSec.toFixed(3),
          dur: +t.durationSec.toFixed(3),
        }));
        const drift = Math.abs(timings.length - expectedWordCount);
        logger.info(
          { timingCount: timings.length, expectedWordCount, drift, preview },
          "Word timings retrieved from SDK wordBoundary events"
        );
        if (drift > 5) {
          // Within ±5 is the spec tolerance — outside is a real signal something is wrong (SSML markup
          // counted as words, voice mismatch, etc.). Surface as a warning but don't fail the render.
          logger.warn(
            { drift, expectedWordCount, actual: timings.length },
            "Word timing count drift exceeds ±5 from script word count"
          );
        }
        resolve(timings);
      },
      (err) => {
        synthesizer.close();
        // Hard rule: NEVER silently fall back. NEVER log full error objects (may contain keys).
        // SDK error callback signature passes a string message.
        reject(new Error(`Azure Speech SDK wordBoundary collection failed: ${String(err)}`));
      }
    );
  });
}
