import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { logger } from "../lib/logger.js";

export interface WordTiming {
  word: string;
  startSec: number;
  durationSec: number;
}

export async function getWordTimings(script: string, voiceName: string): Promise<WordTiming[]> {
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";

  const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
  speechConfig.speechSynthesisVoiceName = voiceName;

  // Synthesize to null stream — we only need the word boundary events
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

  logger.info({ voiceName, wordCount: script.split(/\s+/).length }, "Getting word timings from Azure TTS");

  return new Promise((resolve, reject) => {
    synthesizer.speakTextAsync(
      script,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          logger.info({ timingCount: timings.length }, "Word timings retrieved");
          resolve(timings);
        } else {
          logger.warn({ reason: result.reason }, "Word timing synthesis failed, falling back");
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
  const WPM = 145;
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
