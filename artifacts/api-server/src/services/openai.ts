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

export type ScriptStyle = "viral" | "listicle" | "story" | "educational" | "sales";

const DURATIONS: Record<string, string> = {
  "YouTube Shorts": "20-30 seconds",
  "Instagram Reels": "20-30 seconds",
  "Facebook Reels": "20-30 seconds",
  "YouTube Video": "60-90 seconds",
  "Landscape Video": "30-60 seconds",
};

const STYLE_PROMPTS: Record<ScriptStyle, string> = {
  viral: `Open with a shocking statement or question that stops the scroll. Fast-paced, punchy sentences. Create urgency. End with a strong CTA to follow.`,
  listicle: `Structure as a numbered list (3-5 points). Clear intro: "Here are X [things/tips/secrets]..." Each point is one sentence max. Rapid-fire delivery.`,
  story: `Open with "I used to..." or "Last [time period], I..." Build tension, reveal the lesson, apply it to the viewer. Personal and relatable.`,
  educational: `Explain one key concept clearly. Use an analogy. Give one actionable takeaway. Position as the expert. "What most people don't know is..."`,
  sales: `Problem → Agitate → Solve. Open with the pain point, make the viewer feel it, then reveal the solution as the hero. End with urgency CTA.`,
};

export interface BrandTheme {
  bgColor1: string;
  bgColor2: string;
  accentColor: string;
}

export async function generateBrandTheme(topic: string, platform: string): Promise<BrandTheme> {
  const prompt = `You are a professional motion graphics designer. Choose a sophisticated broadcast-quality color scheme for a ${platform} video about: "${topic}".

- bgColor1: dark primary background (hex #RRGGBB, must be dark/deep)
- bgColor2: lighter variant of same hue (for gradient — should be distinctly lighter, 20-40% lighter)
- accentColor: vibrant contrast accent matching the topic mood (not neon, premium brand palette)

Return ONLY valid JSON: {"bgColor1":"#0D1B2A","bgColor2":"#1A3A5C","accentColor":"#4A9FFF"}`;

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

export async function generateScript(topic: string, platform: string, style: ScriptStyle = "viral"): Promise<string> {
  const duration = DURATIONS[platform] ?? "20-30 seconds";
  const styleGuide = STYLE_PROMPTS[style];

  const prompt = `Create a highly engaging ${platform} video script about: ${topic}

Style: ${styleGuide}

Rules:
- Strong hook in the FIRST 2 seconds
- Short punchy sentences — max 10 words each
- Natural pauses with ... where the speaker should breathe
- End with: Follow Libraryminds
- Target duration: ${duration}
- NO stage directions, NO speaker labels, NO brackets, NO timestamps
- Return clean script text ONLY`;

  logger.info({ topic, platform, style }, "Generating script");

  const response = await client.chat.completions.create({
    model: deploymentName,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 600,
    temperature: 0.88,
  });

  const script = response.choices[0]?.message?.content?.trim() ?? "";
  logger.info({ scriptLength: script.length, style }, "Script generated");
  return script;
}
