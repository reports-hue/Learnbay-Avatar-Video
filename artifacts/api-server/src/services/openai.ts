import OpenAI from "openai";
import { logger } from "../lib/logger.js";

const endpoint = process.env.AZURE_OPENAI_ENDPOINT ?? "";
const apiKey = process.env.AZURE_OPENAI_API_KEY ?? "";
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o-mini";
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

export interface BrandTheme {
  bgColor1: string;
  bgColor2: string;
  accentColor: string;
}

export async function generateBrandTheme(topic: string, platform: string): Promise<BrandTheme> {
  const prompt = `You are a professional motion graphics designer. Given a video topic and platform, choose a sophisticated, broadcast-quality color scheme for the video background and branding.

Topic: "${topic}"
Platform: ${platform}

Rules:
- bgColor1: the primary dark background color (hex #RRGGBB, should be dark/deep)
- bgColor2: a slightly lighter/warmer variant of the same hue (for a vertical gradient from top to bottom)
- accentColor: a vibrant accent color that contrasts well and matches the topic mood
- Colors must be professional, modern, and appropriate for the topic/niche
- No neon colors. Think premium brand palette.

Return ONLY valid JSON like:
{"bgColor1":"#0D1B2A","bgColor2":"#1A3A5C","accentColor":"#4A9FFF"}`;

  logger.info({ topic, platform }, "Generating brand theme");

  const response = await client.chat.completions.create({
    model: deploymentName,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 80,
    temperature: 0.7,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
  try {
    const parsed = JSON.parse(raw) as Partial<BrandTheme>;
    const theme: BrandTheme = {
      bgColor1: /^#[0-9a-fA-F]{6}$/.test(parsed.bgColor1 ?? "") ? parsed.bgColor1! : "#0D1B2A",
      bgColor2: /^#[0-9a-fA-F]{6}$/.test(parsed.bgColor2 ?? "") ? parsed.bgColor2! : "#1A3A5C",
      accentColor: /^#[0-9a-fA-F]{6}$/.test(parsed.accentColor ?? "") ? parsed.accentColor! : "#4A9FFF",
    };
    logger.info({ theme }, "Brand theme generated");
    return theme;
  } catch {
    logger.warn({ raw }, "Failed to parse brand theme, using defaults");
    return { bgColor1: "#0D1B2A", bgColor2: "#1A3A5C", accentColor: "#4A9FFF" };
  }
}

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
