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
  "YouTube Shorts": "25-35 seconds when spoken at a natural pace",
  "Instagram Reels": "25-35 seconds when spoken at a natural pace",
  "Facebook Reels": "25-35 seconds when spoken at a natural pace",
  "YouTube Video": "70-90 seconds when spoken at a natural pace",
  "Landscape Video": "40-60 seconds when spoken at a natural pace",
};

// Natural human speech rules applied to all styles
const HUMAN_SPEECH_RULES = `
MANDATORY HUMAN SPEECH RULES (apply to every script):
- Write EXACTLY how a real person talks out loud — NOT how someone writes
- Use contractions always: I'm, we've, you'll, it's, they're, don't, can't, that's
- Include ONE natural filler transition in the script: "So here's the thing", or "And look", or "Now here's what's interesting", or "But wait"
- Vary sentence length — mix very short punchy sentences (3-5 words) with longer explanatory ones (12-18 words)
- Never start two consecutive sentences with the same word
- NO bullet points, NO numbered lists, NO list format whatsoever
- NO stage directions, NO speaker labels, NO [brackets], NO timestamps
- After writing the script, review it and replace any phrase that sounds AI-generated or overly formal with a more casual human equivalent
- Use "..." for natural pauses where a speaker would breathe
- The script should feel like real speech, unscripted and personal`;

const STYLE_PROMPTS: Record<ScriptStyle, string> = {
  viral: `
Style: VIRAL HOOK — stops the scroll in the first 2 seconds.
- Open with a bold contrarian statement or surprising stat. First 3 seconds must create a pattern interrupt.
- Example openers: "Nobody talks about this, but..." / "I tested this for 30 days and..." / "This one thing changed everything for me..."
- Fast-paced energy throughout. Create urgency. Build to a punchy revelation.
- End with a strong call to follow or subscribe.`,

  listicle: `
Style: LISTICLE — but spoken naturally, NOT formatted as a list.
- Do NOT say "Number one... Number two..." — instead weave the points naturally: "First up..." then "And then there's..." then "But the one that surprised me most..."
- Clear natural intro: "I've got X things that..." — but phrased conversationally.
- Each point gets one crisp sentence. Keep it rapid-fire.
- End with which point hit hardest for you personally.`,

  story: `
Style: PERSONAL STORY — real and relatable.
- Begin in the MIDDLE of action: "I was..." or "Last week I..." or "Three months ago I tried something weird..."
- Build tension naturally. Use "And then..." and "That's when I realized..."
- Reveal the lesson like you're telling a friend, not a Ted Talk.
- Apply it directly to the viewer at the end: "So if you're dealing with..."`,

  educational: `
Style: EDUCATIONAL — expert but approachable.
- Lead with what most people get WRONG: "Most people think... but actually..."
- Use a simple analogy to explain the concept (the simpler the better)
- Give ONE concrete actionable takeaway
- Position yourself as someone who figured this out, not a textbook: "What I've learned is..."`,

  sales: `
Style: SALES — emotional, problem-focused, authentic.
- Open by naming the pain point directly and personally: "If you're tired of..." or "I know what it feels like when..."
- Agitate it — make the viewer feel understood
- Then pivot to the solution naturally: "That's exactly why..."
- End with a specific CTA that creates mild urgency — not pushy, just clear`,
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

export async function generateScript(
  topic: string,
  platform: string,
  style: ScriptStyle = "viral"
): Promise<string> {
  const duration = DURATIONS[platform] ?? "25-35 seconds when spoken at a natural pace";
  const styleGuide = STYLE_PROMPTS[style];

  const prompt = `Write a ${platform} video script about this topic: ${topic}

${styleGuide}

${HUMAN_SPEECH_RULES}

Additional requirements:
- Target spoken duration: ${duration}
- Strong hook in the FIRST 2 seconds that would stop someone scrolling
- Return ONLY the clean spoken script text — no notes, no formatting, no headers`;

  logger.info({ topic, platform, style }, "Generating natural-speech script");

  const response = await client.chat.completions.create({
    model: deploymentName,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 700,
    temperature: 0.88,
  });

  const script = response.choices[0]?.message?.content?.trim() ?? "";
  logger.info({ scriptLength: script.length, style }, "Script generated");
  return script;
}
