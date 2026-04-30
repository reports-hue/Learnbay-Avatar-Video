import axios from "axios";
import { writeFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

const STYLE_PROMPTS: Record<string, string> = {
  cinematic_dark:
    "dark cinematic atmosphere, dramatic side lighting, deep shadows, volumetric light rays, subtle lens flare, film noir aesthetic, anamorphic bokeh, desaturated rich tones",
  tech_gradient:
    "futuristic technology environment, cool blue and purple ambient lighting, abstract holographic data streams, glowing circuit board elements, clean minimal depth, cyberpunk atmosphere",
  warm_studio:
    "warm professional studio setting, soft golden-amber key light, shallow depth of field, elegant bokeh, cream and terracotta tones, cozy yet high-end broadcast feel",
  creative_pop:
    "vibrant creative studio, bold saturated colors, geometric shapes in soft focus, artistic splashes, energetic dynamic composition, Gen Z aesthetic",
  corporate_sleek:
    "clean modern corporate office interior, dark navy and charcoal palette, large floor-to-ceiling windows with city view, subtle glass reflections, premium executive look",
};

export async function generateBackgroundImage(
  topic: string,
  backgroundStyle: string,
  bgColor1: string,
  bgColor2: string,
  platform: string,
  outputFilename: string
): Promise<string> {
  // Dedicated image endpoint/key takes priority; fall back to general Azure OpenAI
  const endpoint = (
    process.env.AZURE_IMAGE_ENDPOINT ??
    process.env.AZURE_OPENAI_ENDPOINT ??
    ""
  ).replace(/\/$/, "");
  const apiKey =
    process.env.AZURE_IMAGE_API_KEY ??
    process.env.AZURE_OPENAI_API_KEY ??
    "";
  const imageDeployment = process.env.AZURE_IMAGE_DEPLOYMENT ?? "gpt-image-1";

  const isVertical =
    platform === "YouTube Shorts" ||
    platform === "Instagram Reels" ||
    platform === "Facebook Reels";

  // Supported sizes for gpt-image-1
  const size = isVertical ? "1024x1536" : "1536x1024";

  const styleDesc =
    STYLE_PROMPTS[backgroundStyle] ?? STYLE_PROMPTS.cinematic_dark;
  const aspect = isVertical ? "vertical 9:16" : "horizontal 16:9";

  // Topic-aware scene hint — pushes the model toward a relevant location instead
  // of a generic abstract background. Keyword-driven; falls back to no hint.
  const t = topic.toLowerCase();
  let sceneHint = "";
  if (/\b(ai|tech|software|api|saas|code|cloud|crypto|blockchain|cyber|data|machine learning|ml|llm|gpt|developer|programming)\b/.test(t)) {
    sceneHint = "Setting: sleek futuristic technology office or neon-lit cyber city skyline at dusk.";
  } else if (/\b(finance|money|invest|stock|trading|bank|wealth|crypto|dollar|profit|business|startup|founder|ceo)\b/.test(t)) {
    sceneHint = "Setting: premium marble executive desk or floor-to-ceiling window with city skyline at golden hour.";
  } else if (/\b(fitness|gym|workout|health|body|muscle|run|yoga|exercise|nutrition|diet)\b/.test(t)) {
    sceneHint = "Setting: high-end modern gym interior or outdoor sunrise mountain trail.";
  } else if (/\b(food|recipe|cook|chef|kitchen|meal|restaurant)\b/.test(t)) {
    sceneHint = "Setting: warm artisanal kitchen with soft natural window light and wooden surfaces.";
  } else if (/\b(travel|trip|vacation|destination|tourism|hotel|flight)\b/.test(t)) {
    sceneHint = "Setting: aspirational travel destination with golden hour ambient light.";
  } else if (/\b(beauty|fashion|style|skincare|makeup|wellness|lifestyle|aesthetic|home|design|interior)\b/.test(t)) {
    sceneHint = "Setting: minimal aesthetic apartment interior with soft diffused window light.";
  } else if (/\b(book|read|library|study|learn|education|course|tutorial|teach|knowledge)\b/.test(t)) {
    sceneHint = "Setting: warm cosy library or study with leather and wood textures, soft amber accent lighting.";
  }

  const prompt = `Ultra-wide ${aspect} cinematic video background for a marketing video about: "${topic}". ${sceneHint} ${styleDesc}. Primary palette inspired by ${bgColor1} and ${bgColor2}. 8K photorealistic, hyper-detailed, golden hour lighting, shallow depth of field, anamorphic bokeh, premium broadcast quality. Absolutely NO people, NO faces, NO text, NO logos, NO words, NO numbers, NO letters, NO watermarks. Pure environment and atmosphere only — designed to have a talking-head presenter composited in the foreground.`;

  const url = `${endpoint}/openai/deployments/${imageDeployment}/images/generations?api-version=2025-04-01-preview`;

  logger.info(
    { topic, backgroundStyle, imageDeployment, size, endpoint: url },
    "Generating AI background image"
  );

  const response = await axios.post(
    url,
    {
      prompt,
      n: 1,
      size,
      quality: "medium",
      // Spec rule: ALWAYS request JPEG from gpt-image-1 (PNG is rejected/oversized).
      // Do NOT add output_compression — Azure rejects that parameter.
      output_format: "jpeg",
    },
    {
      headers: {
        // Serverless endpoint uses Bearer token auth
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 120_000,
    }
  );

  // gpt-image-1 always returns b64_json
  const b64: string | undefined =
    response.data?.data?.[0]?.b64_json ??
    response.data?.data?.[0]?.url;

  if (!b64) {
    throw new Error(
      `No image data returned from Azure OpenAI image generation: ${JSON.stringify(response.data).slice(0, 300)}`
    );
  }

  const localPath = path.join(outputsDir, outputFilename);

  if (b64.startsWith("http")) {
    // Fallback: URL response — download it
    const imgResponse = await axios.get<Buffer>(b64, {
      responseType: "arraybuffer",
      timeout: 60_000,
    });
    writeFileSync(localPath, imgResponse.data);
  } else {
    // base64 JPEG — decode directly
    writeFileSync(localPath, Buffer.from(b64, "base64"));
  }

  const sizeBytes = statSync(localPath).size;
  logger.info({ localPath, sizeBytes }, "AI background image saved");
  return localPath;
}
