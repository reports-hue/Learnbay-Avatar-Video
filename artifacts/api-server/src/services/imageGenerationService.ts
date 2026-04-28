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

  const prompt = `Professional ${aspect} video background for a marketing video about: "${topic}". ${styleDesc}. Primary palette inspired by ${bgColor1} and ${bgColor2}. Absolutely NO people, NO faces, NO text, NO logos, NO words, NO numbers, NO letters. Pure environment and atmosphere only. Cinematic depth of field, photorealistic, 4K broadcast quality, designed to have a talking-head presenter composited in the foreground.`;

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
      output_format: "png",
      output_compression: 90,
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
    // base64 PNG — decode directly
    writeFileSync(localPath, Buffer.from(b64, "base64"));
  }

  const sizeBytes = statSync(localPath).size;
  logger.info({ localPath, sizeBytes }, "AI background image saved");
  return localPath;
}
