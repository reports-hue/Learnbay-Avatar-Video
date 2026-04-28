import OpenAI from "openai";
import { logger } from "../lib/logger.js";

const endpoint = process.env.AZURE_OPENAI_ENDPOINT ?? "";
const apiKey = process.env.AZURE_OPENAI_API_KEY ?? "";
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o";
const apiVersion = "2024-12-01-preview";

const client = new OpenAI({
  apiKey,
  baseURL: `${endpoint.replace(/\/$/, "")}/openai/deployments/${deploymentName}`,
  defaultQuery: { "api-version": apiVersion },
  defaultHeaders: { "api-key": apiKey },
});

const DURATIONS: Record<string, string> = {
  "YouTube Shorts": "20-30 seconds",
  "Instagram Reels": "20-30 seconds",
  "Facebook Reels": "20-30 seconds",
  "YouTube Video": "60-90 seconds",
  "Landscape Video": "30-60 seconds",
};

export async function generateScript(topic: string, platform: string): Promise<string> {
  const duration = DURATIONS[platform] ?? "20-30 seconds";

  const prompt = `Create a highly engaging video script for ${platform} on topic: ${topic}.

Rules:
- Strong hook in first 2 seconds
- Short sentences
- Natural pauses (use ... for pauses)
- End with: Follow Libraryminds
- Duration: ${duration}
- No stage directions, no speaker labels, no timestamps
- Return clean script only, no extra formatting`;

  logger.info({ topic, platform }, "Generating script");

  const response = await client.chat.completions.create({
    model: deploymentName,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 600,
    temperature: 0.85,
  });

  const script = response.choices[0]?.message?.content?.trim() ?? "";
  logger.info({ scriptLength: script.length }, "Script generated");
  return script;
}
