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
function buildTimingSsml(script: string, voiceName: string, pacingRate = "0.95"): string {
  const useChat = CHAT_STYLE_VOICES.has(voiceName);
  const sentenceXml = buildSentenceXml(script);

  const prosodyWrapper = `<prosody rate="${pacingRate}" pitch="-1%">${sentenceXml}</prosody>`;

  const inner = useChat
    ? `<mstts:express-as style="chat" styledegree="1.1">${prosodyWrapper}</mstts:express-as>`
    : prosodyWrapper;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${voiceName}">${inner}</voice></speak>`;
}

export async function getWordTimings(
  script: string,
  voiceName: string,
  pacingRate = "0.95"
): Promise<WordTiming[]> {
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";

  const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
  speechConfig.speechSynthesisVoiceName = voiceName;

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

  logger.info({ voiceName, wordCount: script.split(/\s+/).length, pacingRate }, "Getting word timings via SSML");

  const ssml = buildTimingSsml(script, voiceName, pacingRate);

  return new Promise((resolve, reject) => {
    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          logger.info({ timingCount: timings.length }, "Word timings retrieved via SSML");
          resolve(timings.length > 0 ? timings : estimateWordTimings(script));
        } else {
          logger.warn({ reason: result.reason }, "SSML timing synthesis failed, falling back to estimates");
          resolve(estimateWordTimings(script));
        }
      },
      (err) => {
        synthesizer.close();
        logger.warn({ err }, "Word timing synthesis error, using estimates");
        resolve(estimateWordTimings(script));
      }
    );
  });
}

function estimateWordTimings(script: string): WordTiming[] {
  const WPM = 138; // Slightly slower to match 0.95 pacing rate
  const secPerWord = 60 / WPM;
  const words = script.replace(/[^\w\s'-]/g, " ").split(/\s+/).filter(Boolean);
  let cursor = 0.5;
  return words.map((word) => {
    const duration = secPerWord * (1 + word.length * 0.015);
    const timing: WordTiming = { word, startSec: cursor, durationSec: duration };
    cursor += duration;
    return timing;
  });
}
