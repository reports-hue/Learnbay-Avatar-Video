import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

export async function generateVoice(script: string): Promise<string> {
  const outputPath = path.join(outputsDir, "voice.mp3");

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY ?? "",
    process.env.AZURE_SPEECH_REGION ?? "eastus"
  );
  speechConfig.speechSynthesisVoiceName = "en-US-AriaNeural";
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

  const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outputPath);
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

  logger.info("Generating voice with Azure TTS");

  return new Promise((resolve, reject) => {
    synthesizer.speakTextAsync(
      script,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          logger.info({ outputPath }, "Voice generated");
          resolve(outputPath);
        } else {
          const err = new Error(
            `Voice synthesis failed: ${result.errorDetails ?? result.reason}`
          );
          logger.error({ err }, "Voice synthesis error");
          reject(err);
        }
      },
      (err) => {
        synthesizer.close();
        logger.error({ err }, "Voice synthesis exception");
        reject(new Error(String(err)));
      }
    );
  });
}
