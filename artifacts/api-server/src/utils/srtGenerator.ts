import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function splitIntoSentences(script: string): string[] {
  return script
    .split(/(?<=[.!?])\s+|\.{3}\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function generateSRT(script: string): Promise<string> {
  const srtPath = path.join(outputsDir, "subtitles.srt");
  const sentences = splitIntoSentences(script);

  const secondsPerSentence = 2.5;
  let srtContent = "";

  sentences.forEach((sentence, index) => {
    const start = index * secondsPerSentence;
    const end = start + secondsPerSentence;
    srtContent += `${index + 1}\n${formatTime(start)} --> ${formatTime(end)}\n${sentence}\n\n`;
  });

  await fs.writeFile(srtPath, srtContent, "utf-8");
  logger.info({ srtPath, sentences: sentences.length }, "SRT generated");
  return srtPath;
}
