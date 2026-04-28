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

export interface BrandAnalysisResult {
  companyName: string;
  tagline: string;
  description: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  tone: string;
  suggestedCta: string;
}

export async function analyzeBrand(
  html: string,
  url: string,
  metaInfo: Record<string, string>
): Promise<BrandAnalysisResult> {
  const textContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2500);

  const metaSummary = Object.entries(metaInfo)
    .slice(0, 15)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const prompt = `You are a brand analyst. Analyze this website data and extract brand identity.

URL: ${url}
Meta tags:
${metaSummary}

Page text snippet:
${textContent.slice(0, 1200)}

Return ONLY valid JSON (no code blocks) with these exact keys:
{
  "companyName": "the main brand/company name",
  "tagline": "their tagline or slogan (empty string if unknown)",
  "description": "1-2 sentence brand description for AI video context",
  "logoUrl": "use detected_logo_url from meta or empty string",
  "primaryColor": "dominant brand color as #RRGGBB hex (extract from theme-color or infer from brand)",
  "secondaryColor": "secondary/accent color as #RRGGBB hex",
  "tone": "one of: professional, casual, energetic, trustworthy, creative",
  "suggestedCta": "natural video CTA e.g. 'Visit acme.com today'"
}`;

  const response = await client.chat.completions.create({
    model: deploymentName,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 250,
    temperature: 0.3,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
  try {
    const result = JSON.parse(raw.replace(/```json\n?|```/g, "")) as BrandAnalysisResult;
    logger.info({ companyName: result.companyName, primaryColor: result.primaryColor }, "Brand analyzed");
    return {
      companyName: result.companyName ?? "",
      tagline: result.tagline ?? "",
      description: result.description ?? "",
      logoUrl: metaInfo["detected_logo_url"] ?? result.logoUrl ?? "",
      primaryColor: /^#[0-9a-fA-F]{6}$/.test(result.primaryColor ?? "") ? result.primaryColor : "#7C3AED",
      secondaryColor: /^#[0-9a-fA-F]{6}$/.test(result.secondaryColor ?? "") ? result.secondaryColor : "#4A9FFF",
      tone: result.tone ?? "professional",
      suggestedCta: result.suggestedCta ?? "",
    };
  } catch {
    logger.warn({ raw }, "Failed to parse brand analysis, returning defaults");
    return { companyName: "", tagline: "", description: "", logoUrl: "", primaryColor: "#7C3AED", secondaryColor: "#4A9FFF", tone: "professional", suggestedCta: "" };
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
