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
  outputFilename: string,
  /**
   * Avatar pose. Influences scene COMPOSITION so the AI-painted bg leaves
   * the correct negative space for the composited avatar:
   *   - "sitting"  → desk/table surface in lower foreground, mid-frame
   *                  vertical clear zone for the seated upper body
   *   - "standing" → open central area with floor visible, taller
   *                  vertical clear zone
   * Optional — defaults to "sitting" (matches our default Lisa avatar).
   */
  avatarPose?: "sitting" | "standing"
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

  // Pose-aware composition hint — keeps the central foreground / lower-third
  // visually interesting but uncluttered so the composited avatar reads cleanly.
  // Sitting avatars need a desk/table surface implied; standing avatars need
  // the floor visible and more vertical headroom.
  const pose = avatarPose ?? "sitting";
  const composition = pose === "standing"
    ? "Composition: open central area with floor visible in the lower third, tall vertical clear zone left of frame center for a standing presenter shown waist-up; environment richness pushed to the sides and background plane."
    : "Composition: clean elegant desk or table surface implied across the lower third in soft focus, mid-frame vertical clear zone for a seated presenter shown chest-up; environment richness pushed to the sides and background plane.";

  // ── Logo placard reservation (Tier 2A) ──
  // The corner logo chip is overlaid in ffmpeg at the TOP-RIGHT of the frame
  // (see ffmpegService.ts ~line 1597). Without this hint the AI paints a
  // generic background and the logo chip ends up looking pasted on. With it,
  // the AI paints a clean architectural surface (frosted glass / brushed metal
  // / wood / stone / etched plaque) sized roughly to the chip footprint, so
  // the real logo composited on top reads as IN the scene, not ON the scene.
  //
  // Constraints kept tight to avoid two failure modes:
  //   1) Garbled hallucinated text on the placard — mitigated by the strong
  //      "completely BLANK, no text, no logo" instruction AND the global
  //      negative prompt's "NO text, NO words, NO letters" still in force.
  //   2) Placard dominating the composition — mitigated by explicit size
  //      (~22% × 7%, matching the chip footprint) and "subtle, restrained,
  //      architecturally integrated, not a billboard."
  //
  // If the AI ignores the instruction entirely, fallback = current behavior
  // (clean bg + chip overlay), so the worst case is no regression.
  const placardHint = "Architectural detail: include a clean, BLANK rectangular surface in the TOP-RIGHT corner of the frame (sized approximately 22% wide by 7% tall of the total frame), suitable for a corporate brand mark to be composited on top later. The surface should feel architecturally integrated — for example a frosted glass panel, a brushed metal nameplate, a wood plaque, an etched stone marker, a backlit signage area, or a softly-lit wall mount — sized small and tasteful, NOT dominating the composition. The placard surface itself MUST be COMPLETELY BLANK — do NOT render any logo, text, words, letters, numbers, or symbols on or around it. Leave it as an empty surface that picks up the scene's ambient lighting.";

  const prompt = `Ultra-wide ${aspect} cinematic video background for a marketing video about: "${topic}". ${sceneHint} ${composition} ${placardHint} ${styleDesc}. Primary palette inspired by ${bgColor1} and ${bgColor2}. 8K photorealistic, hyper-detailed, golden hour lighting, shallow depth of field, anamorphic bokeh, premium broadcast quality. Absolutely NO people, NO faces, NO text, NO words, NO numbers, NO letters, NO watermarks anywhere in the image. Pure environment and atmosphere only — designed to have a talking-head presenter composited in the foreground and a brand mark composited onto the top-right placard surface.`;

  const url = `${endpoint}/openai/deployments/${imageDeployment}/images/generations?api-version=2025-04-01-preview`;

  logger.info(
    { topic, backgroundStyle, imageDeployment, size, endpoint: url, avatarPose: pose },
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
