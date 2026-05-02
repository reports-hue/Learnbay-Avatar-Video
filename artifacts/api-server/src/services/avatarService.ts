import axios from "axios";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "../outputs");

export type PacingRate = "slow" | "natural" | "fast";

const PACING_VALUES: Record<PacingRate, string> = {
  slow: "0.88",
  natural: "0.95",
  fast: "1.05",
};

// Valid styles per Azure avatar character. First entry is the safe default.
const AVATAR_DEFAULT_STYLES: Record<string, string> = {
  lisa: "graceful-sitting",
  harry: "business",
  jeff: "business",
};

export function resolveAvatarStyle(character: string, requestedStyle?: string): string {
  if (requestedStyle && requestedStyle.trim()) return requestedStyle.trim();
  return AVATAR_DEFAULT_STYLES[character] ?? "graceful-sitting";
}

/**
 * Decide whether the avatar is rendered SITTING or STANDING. Used by the
 * background image generator so the AI-painted scene leaves the right kind
 * of negative space for the avatar to be composited into:
 *   - sitting  → desk/table surface in lower foreground, chair-height clear zone
 *   - standing → open room with floor visible, full vertical clear zone
 *
 * Style suffixes win over character defaults — Azure exposes hybrid styles
 * like `lisa/technical-standing` where the character is normally sitting
 * but a specific style flips that.
 *
 * Pure function — exported for testing.
 */
const AVATAR_CHARACTER_DEFAULT_POSE: Record<string, "sitting" | "standing"> = {
  lisa: "sitting",
  harry: "standing",
  jeff: "standing",
};

export function getAvatarPose(
  character: string,
  style: string,
): "sitting" | "standing" {
  const s = (style ?? "").trim().toLowerCase();
  // Explicit style hint always wins
  if (s.includes("standing")) return "standing";
  if (s.includes("sitting")) return "sitting";
  // Fall back to character default (lisa=sitting, harry/jeff=standing)
  return AVATAR_CHARACTER_DEFAULT_POSE[character] ?? "sitting";
}

export interface AvatarJobConfig {
  script: string;
  character: string;
  style: string;
  voice: string;
  voiceStyle?: string;
  backgroundColor: string;
  bgImageUrl?: string;
  pacing?: PacingRate;
  realism?: boolean;
  /**
   * Per-job identifier used to scope the on-disk filename for the downloaded
   * Azure avatar raw video. Required so that two concurrent renders never
   * overwrite each other's `avatar_raw.{mp4,webm}` (a SEVERE silent corruption
   * bug — Job-A's post-process would read Job-B's avatar). Caller must pass
   * the same `videoId` it uses for the final video filename.
   */
  videoId: string;
  // When set, use pre-synthesized audio (e.g. ElevenLabs) instead of Azure TTS
  audioUrl?: string;
  // When true: request a transparent-background WebM (VP9) so the avatar arrives
  // with a real alpha channel — no green-screen, no chroma key, no fringe. Azure
  // requires webm + vp9 + backgroundColor "transparent" for this; mp4/h264 do
  // NOT support alpha. Cannot be combined with bgImageUrl (Azure would composite
  // the image and there would be nothing to be transparent over).
  useTransparent?: boolean;
  // When set, prepends a SSML <break> of this many seconds before the script.
  // Used to add intro-sting dead time so the avatar sits idle during the logo
  // reveal instead of mouthing words behind the blackout.
  leadingBreakSec?: number;
}

// Supported SSML speaking styles per Azure TTS voice
const VOICE_STYLES: Record<string, string[]> = {
  "en-US-AriaNeural": ["chat", "empathetic", "narration-professional", "newscast-casual", "customerservice"],
  "en-US-JennyNeural": ["assistant", "chat", "customerservice", "newscast"],
  "en-US-GuyNeural": ["narration-professional", "newscast"],
  "en-US-DavisNeural": ["chat", "cheerful", "excited", "friendly", "hopeful", "angry"],
  "en-GB-SoniaNeural": ["cheerful", "sad"],
  "en-US-AvaMultilingualNeural": ["chat", "cheerful", "excited"],
  "en-US-AndrewMultilingualNeural": ["chat", "excited"],
  "en-US-AndrewNeural": ["chat", "excited", "friendly"],
  "en-US-EmmaNeural": ["chat", "cheerful", "excited"],
  "en-US-BrianNeural": ["chat", "friendly"],
};

export { VOICE_STYLES };

// ─── Retry policy ──────────────────────────────────────────────────
// Azure occasionally returns transient errors (429 throttle, 5xx, network
// hiccups) on both the submit PUT and the per-poll GET. Without retries a
// single transient failure kills a 2-5 minute render. The policy is:
//   - SUBMIT: 2 retries with 5s / 15s backoff. Only retry on transient errors.
//   - POLL:   2 retries per poll cycle with 2s backoff. Transient failures
//             never crash the outer poll loop — we just log and continue.
//   - InvalidStyleName: ONE additional whole-job retry with the character's
//             default style. Surfaces from either the submit response or the
//             Failed status payload.
//
// Non-transient errors (400 with other reason, 401/403 auth, etc.) are NEVER
// retried — those are real bugs we want to surface immediately.

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENOTFOUND",
  "ECONNABORTED",
  "EAI_AGAIN",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientError(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string };
  if (e?.code && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
  const status = e?.response?.status;
  if (typeof status === "number" && TRANSIENT_HTTP_STATUSES.has(status)) return true;
  return false;
}

/**
 * Detect Azure's "InvalidStyleName" / "InvalidAvatarStyle" error from any of:
 *   - submit response body  (HTTP 400 with code/message)
 *   - polled Failed status  (properties.error blob)
 */
function isInvalidStyleError(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  const blob =
    (typeof e?.response?.data === "string"
      ? e.response.data
      : JSON.stringify(e?.response?.data ?? "")) +
    " " +
    (e?.message ?? "");
  return /Invalid(?:Avatar)?StyleName|talkingAvatarStyle/i.test(blob);
}

function shortAxiosErr(err: unknown): { status?: number; code?: string; message?: string; bodyHead?: string } {
  const e = err as {
    response?: { status?: number; data?: unknown };
    code?: string;
    message?: string;
  };
  const data = e?.response?.data;
  const bodyHead =
    typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data ?? "").slice(0, 200);
  return {
    status: e?.response?.status,
    code: e?.code,
    message: e?.message?.slice(0, 200),
    bodyHead,
  };
}

// Extract locale from voice short name (e.g. hi-IN-SwaraNeural → hi-IN)
function extractLocale(voice: string): string {
  const parts = voice.split("-");
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return "en-US";
}

// Split text into sentences for natural pause insertion
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Escape XML special characters
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Add natural breaks for commas (shorter = less avatar head reset)
function addBreaks(sentence: string): string {
  return xmlEscape(sentence).replace(/,/g, ",<break time=\"80ms\"/>");
}

function buildSsml(
  script: string,
  voice: string,
  voiceStyle?: string,
  pacing: PacingRate = "natural",
  leadingBreakSec = 0
): string {
  const rate = PACING_VALUES[pacing];
  const lang = extractLocale(voice);
  const sentences = splitSentences(script);
  const styles = VOICE_STYLES[voice] ?? [];
  const effectiveStyle = voiceStyle && styles.includes(voiceStyle) ? voiceStyle : (styles.includes("chat") ? "chat" : null);

  // Optional leading break: avatar sits idle during the intro logo reveal so
  // its mouth does not move while the blackout is covering the frame.
  const breakTag = leadingBreakSec > 0
    ? `<break time="${Math.round(leadingBreakSec * 1000)}ms"/>`
    : "";

  // Build sentence-level content — NO explicit breaks between sentences.
  // Rely on the TTS engine's natural sentence rhythm + short boundary silence.
  // This prevents the avatar from hitting a "dead" pause and resetting head position.
  const sentenceXml = sentences
    .map((s, i) => {
      // Slight micro-rate variation between sentences for natural cadence
      const microRate = i % 2 === 0 ? +parseFloat(rate) - 0.02 : +parseFloat(rate) + 0.02;
      return `<prosody rate="${microRate.toFixed(2)}">${addBreaks(s)}</prosody>`;
    })
    .join(" ");

  // Wrap all in one parent prosody block with minimal sentence boundary silence
  const prosodyContent = `<prosody pitch="-2%"><mstts:silence type="Sentenceboundary" value="80ms"/>${breakTag}${sentenceXml}</prosody>`;

  // Only add express-as if voice supports it (mainly English Neural voices)
  const supportsStyle = styles.length > 0;
  const inner = effectiveStyle && supportsStyle
    ? `<mstts:express-as style="${effectiveStyle}" styledegree="1.1">${prosodyContent}</mstts:express-as>`
    : prosodyContent;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}">${inner}</voice></speak>`;
}

/**
 * Issue the avatar batch-synthesis PUT. Retries up to 2 times on transient
 * HTTP errors (429, 5xx, network) with 5s / 15s backoff. Non-transient
 * errors propagate immediately on the first failure so the caller can
 * decide whether to apply the InvalidStyleName fallback.
 */
async function submitWithRetry(
  url: string,
  body: unknown,
  key: string,
  jobId: string,
): Promise<void> {
  const backoffsMs = [5000, 15000];
  let attempt = 0;
  while (true) {
    try {
      await axios.put(url, body, {
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/json",
        },
        // Keep a real timeout so a hanging socket doesn't burn the whole
        // 25-min budget on a single dead connection.
        timeout: 30_000,
      });
      return;
    } catch (err) {
      const transient = isTransientError(err);
      if (!transient || attempt >= backoffsMs.length) {
        logger.warn(
          { jobId, attempt, transient, ...shortAxiosErr(err) },
          "Avatar submit failed (giving up)",
        );
        throw err;
      }
      const wait = backoffsMs[attempt];
      attempt += 1;
      logger.warn(
        { jobId, attempt, waitMs: wait, ...shortAxiosErr(err) },
        "Avatar submit transient failure — retrying",
      );
      await sleep(wait);
    }
  }
}

/**
 * Poll the avatar job status URL once. On transient failures, retry up to
 * 2 times with 2s backoff before propagating. The caller's outer loop
 * handles the long-running poll cadence — this helper makes a single poll
 * cycle resilient to one-off network blips.
 */
async function pollOnceWithRetry(
  url: string,
  key: string,
  jobId: string,
): Promise<{ status: string; outputs?: { result?: string }; properties?: { error?: unknown } }> {
  const backoffsMs = [2000, 2000];
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, {
        headers: { "Ocp-Apim-Subscription-Key": key },
        timeout: 20_000,
      });
      return res.data as {
        status: string;
        outputs?: { result?: string };
        properties?: { error?: unknown };
      };
    } catch (err) {
      const transient = isTransientError(err);
      if (!transient || attempt >= backoffsMs.length) {
        throw err;
      }
      const wait = backoffsMs[attempt];
      attempt += 1;
      logger.warn(
        { jobId, attempt, waitMs: wait, ...shortAxiosErr(err) },
        "Avatar poll transient failure — retrying",
      );
      await sleep(wait);
    }
  }
}

/**
 * Run a single avatar synthesis attempt end-to-end (submit + poll + download).
 * Returns the local file path on success. The top-level `generateAvatarVideo`
 * wraps this with the InvalidStyleName fallback path.
 */
async function runAvatarJobOnce(config: AvatarJobConfig): Promise<string> {
  const region = process.env.AZURE_SPEECH_REGION ?? "eastus";
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  const jobId = uuidv4();

  // Pin to 2024-04-15-preview for stable behaviour. As of 2025, Azure Avatar
  // Batch Synthesis no longer accepts `PreSynthesizedAudio` — only PlainText
  // and SSML are valid `inputKind` values. To still use third-party voices
  // (e.g. ElevenLabs), generate the avatar with Azure TTS here, then swap the
  // audio track during FFmpeg post-processing.
  const baseUrl = `https://${region}.api.cognitive.microsoft.com/avatar/batchsyntheses/${jobId}?api-version=2024-04-15-preview`;

  // Three modes for the avatar background:
  //   1. transparent WebM  (preferred for realism — true alpha, no chroma key)
  //   2. green screen mp4  (legacy fallback path; still wired in case Azure
  //      WebM is ever unavailable — chromakey filter remains in ffmpegService)
  //   3. solid color / Azure-composited bg image (when bgImageUrl is provided)
  //
  // useTransparent CANNOT be combined with bgImageUrl — Azure would composite
  // the image and nothing would be transparent. The route handler is expected
  // to enforce this, but we double-check here for safety.
  const useTransparent =
    config.useTransparent === true && !config.bgImageUrl;
  const useGreenScreen =
    !useTransparent && config.realism !== false && !config.bgImageUrl;
  const effectiveBgColor = useGreenScreen
    ? "#00FF00FF"
    : config.bgImageUrl
      ? "#000000FF"
      : config.backgroundColor;

  const avatarConfig: Record<string, unknown> = {
    customized: false,
    talkingAvatarCharacter: config.character || "lisa",
    ...(config.style ? { talkingAvatarStyle: config.style } : {}),
    // Transparent path REQUIRES webm + vp9 + backgroundColor "transparent".
    // mp4/h264 do not support alpha channels — Azure will silently ignore
    // backgroundColor:"transparent" and produce a black background.
    videoFormat: useTransparent ? "webm" : "mp4",
    videoCodec: useTransparent ? "vp9" : "h264",
    backgroundColor: useTransparent ? "transparent" : effectiveBgColor,
    bitrateKbps: 4000,
    subtitleType: "none",
  };

  // backgroundImage must be a plain URL string per the official OpenAPI spec
  if (config.bgImageUrl) {
    avatarConfig["backgroundImage"] = config.bgImageUrl;
  }

  // Azure batch synthesis expects a flat top-level body (no `payload` wrapper).
  // We always use SSML/Azure TTS for the avatar render — see comment above.
  // If `config.audioUrl` is set, the caller (route handler) is responsible for
  // swapping that audio into the final video during FFmpeg post-processing.
  const ssml = buildSsml(config.script, config.voice, config.voiceStyle, config.pacing ?? "natural", config.leadingBreakSec ?? 0);
  const requestBody = {
    synthesisConfig: { voice: config.voice },
    customVoices: {},
    avatarConfig,
    inputKind: "SSML",
    inputs: [{ content: ssml }],
  };

  if (config.audioUrl) {
    logger.info({ audioUrl: config.audioUrl }, "External audio supplied — avatar will be rendered with Azure TTS and audio swapped in post-processing");
  }

  logger.info(
    {
      jobId,
      character: config.character,
      style: config.style,
      voice: config.voice,
      pacing: config.pacing,
      realism: config.realism !== false,
      bgColor: useTransparent ? "transparent" : effectiveBgColor,
      videoFormat: avatarConfig["videoFormat"],
      videoCodec: avatarConfig["videoCodec"],
      mode: useTransparent ? "transparent-webm" : useGreenScreen ? "green-screen-mp4" : "solid-bg-mp4",
    },
    "Submitting avatar synthesis job"
  );

  await submitWithRetry(baseUrl, requestBody, key, jobId);

  logger.info({ jobId }, "Avatar job submitted, polling for completion");

  const maxWaitMs = 25 * 60 * 1000;
  const pollIntervalMs = 6000;
  const pollStart = Date.now();
  let consecutivePollFailures = 0;
  // After this many consecutive transient failures, give up — likely something
  // bigger than a hiccup (network down, region offline, key revoked).
  const MAX_CONSECUTIVE_POLL_FAILURES = 5;

  while (Date.now() - pollStart < maxWaitMs) {
    await sleep(pollIntervalMs);

    let data: { status: string; outputs?: { result?: string }; properties?: { error?: unknown } };
    try {
      data = await pollOnceWithRetry(baseUrl, key, jobId);
    } catch (err) {
      // Only transient errors reach here (pollOnceWithRetry already swallowed
      // 2 retries internally); count them and keep going. Non-transient errors
      // bubble up because they indicate something the caller must see.
      if (!isTransientError(err)) {
        logger.warn(
          { jobId, ...shortAxiosErr(err) },
          "Avatar poll non-transient failure — aborting job",
        );
        throw err;
      }
      consecutivePollFailures += 1;
      logger.warn(
        { jobId, consecutivePollFailures, ...shortAxiosErr(err) },
        "Avatar poll persistent transient failure",
      );
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(
          `Avatar polling failed ${consecutivePollFailures} consecutive times — last error: ${shortAxiosErr(err).message ?? "unknown"}`,
        );
      }
      continue;
    }
    consecutivePollFailures = 0;

    const { status, outputs, properties } = data;

    logger.info({ jobId, status }, "Avatar job status");

    if (status === "Succeeded") {
      const videoUrl = outputs?.result;
      if (!videoUrl) throw new Error("Avatar job succeeded but no result URL found");
      // Match the on-disk extension to the format we requested so FFmpeg/ffprobe
      // pick the right demuxer. mp4 vs webm container both work but downstream
      // checks key off the path.
      const outputExt = useTransparent ? "webm" : "mp4";
      // Per-job filename — never `avatar_raw.{ext}` — so concurrent renders
      // cannot overwrite each other (see AvatarJobConfig.videoId doc).
      const outputPath = path.join(outputsDir, `avatar_raw_${config.videoId}.${outputExt}`);
      await downloadFile(videoUrl, outputPath);
      logger.info({ outputPath, transparent: useTransparent }, "Avatar video downloaded");
      return outputPath;
    }

    if (status === "Failed") {
      // Build a synthetic error that carries enough info for the caller's
      // InvalidStyleName check (response.data with the error blob) plus a
      // human-readable message.
      const errBlob = properties?.error ?? "unknown";
      const e = new Error(`Avatar synthesis failed: ${JSON.stringify(errBlob)}`) as Error & {
        response?: { status?: number; data?: unknown };
      };
      e.response = { status: 400, data: errBlob };
      throw e;
    }
  }

  throw new Error("Avatar synthesis timed out after 25 minutes");
}

/**
 * Public entry point. Runs the synthesis job once; if Azure rejects the
 * requested style with InvalidStyleName / InvalidAvatarStyle, retries ONE
 * time with the character's known-good default style.
 */
export async function generateAvatarVideo(config: AvatarJobConfig): Promise<string> {
  try {
    return await runAvatarJobOnce(config);
  } catch (err) {
    if (!isInvalidStyleError(err)) throw err;
    const defaultStyle = AVATAR_DEFAULT_STYLES[config.character] ?? "graceful-sitting";
    if (config.style === defaultStyle) {
      // Already on the default — nothing safer to try.
      logger.warn(
        { character: config.character, style: config.style },
        "Avatar style rejected and already on character default — surfacing error",
      );
      throw err;
    }
    logger.warn(
      {
        character: config.character,
        attemptedStyle: config.style,
        fallbackStyle: defaultStyle,
      },
      "Azure rejected avatar style — retrying once with character default",
    );
    return await runAvatarJobOnce({ ...config, style: defaultStyle });
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await axios.get<NodeJS.ReadableStream>(url, { responseType: "stream" });
  const writer = createWriteStream(dest);
  return new Promise((resolve, reject) => {
    (response.data as NodeJS.ReadableStream).pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}
