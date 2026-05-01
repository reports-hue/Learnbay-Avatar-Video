/**
 * Script Segmenter (T202) — uses GPT to plan B-roll inserts, fullscreen
 * crossfades, and stat pop-ins across a script's word timings.
 *
 * Determinism contract:
 *   - Output is cached by `sha256(script + JSON(wordTimings) + style + platform + duration)`.
 *   - Identical inputs ALWAYS hit the cache, so re-renders are free and
 *     deterministic. Even small changes (one extra word, different style)
 *     produce a different cache key and a fresh LLM call.
 *
 * Budget enforcement:
 *   - Max 1 segment per ~6 seconds of video duration.
 *   - Total B-roll time (broll-pip + broll-fullscreen) ≤ 35% of duration.
 *   - These limits are enforced HERE in code AFTER the LLM responds — the
 *     prompt also asks the LLM to respect them, but never trust the LLM:
 *     enforce in code or you'll see runs where the LLM happily hands back a
 *     segment per second.
 *
 * Failure contract:
 *   - Any failure (no API key, schema mismatch, network error, JSON parse
 *     failure) returns `{ segments: [] }`. Never throws. Caller can always
 *     proceed with a renderless plan.
 *
 * Hard rules honored:
 *   - Never logs the full LLM response on parse failure (only first 200 chars
 *     of the raw text + the parse error message).
 *   - Never logs the script body itself, only its sha256.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import { z } from "zod";
import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import type { WordTiming } from "./speech.js";

// ── Azure OpenAI client (mirrors openai.ts wiring) ──
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

// ── Schema ──

export const SegmentModeEnum = z.enum([
  "broll-pip",
  "broll-fullscreen",
  "stat-popin",
  "none",
]);
export type SegmentMode = z.infer<typeof SegmentModeEnum>;

export const SegmentSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  mode: SegmentModeEnum,
  /** 2-4 word stock-footage query, e.g. "data dashboard". Null when mode=none/stat-popin. */
  concept: z.string().nullable(),
  /** The literal word(s) to emphasize, used by stat-popin renderer. Null when mode=broll-*. */
  emphasisText: z.string().nullable(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const SegmenterPlanSchema = z.object({
  segments: z.array(SegmentSchema),
});
export type SegmenterPlan = z.infer<typeof SegmenterPlanSchema>;

// ── Stat-popin validation ──

/**
 * Extract the leading numeric value from a word or stat string.
 * Handles: "80%", "$80", "80x", "80K", "80M", "80 million", "80,000", "80".
 * Returns null when no number is found.
 */
function extractNumericValue(text: string): number | null {
  // Strip currency prefix and trailing non-digit suffix, then parse first number.
  const cleaned = text.trim().replace(/,/g, "");
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Drop any stat-popin segment whose emphasisText numeric value cannot be
 * found in the word timings within a ±2 s window around the segment.
 * This is a hard server-side guard against LLM hallucinations — the prompt
 * already asks the model to match real numeric words, but we enforce it here.
 */
export function validateStatPopins(segments: Segment[], wordTimings: WordTiming[]): Segment[] {
  return segments.filter((seg) => {
    if (seg.mode !== "stat-popin") return true;
    if (!seg.emphasisText) {
      logger.warn({ start: seg.startSec }, "Stat-popin dropped: emphasisText is null");
      return false;
    }
    const emphasisNum = extractNumericValue(seg.emphasisText);
    if (emphasisNum === null) {
      logger.warn(
        { emphasisText: seg.emphasisText, start: seg.startSec },
        "Stat-popin dropped: emphasisText has no numeric value"
      );
      return false;
    }
    const windowStart = seg.startSec - 2.0;
    const windowEnd = seg.endSec + 2.0;
    const found = wordTimings.some((w) => {
      if (w.startSec < windowStart || w.startSec > windowEnd) return false;
      const wordNum = extractNumericValue(w.word);
      return wordNum !== null && Math.abs(wordNum - emphasisNum) < 0.001;
    });
    if (!found) {
      logger.warn(
        { emphasisText: seg.emphasisText, emphasisNum, start: seg.startSec, end: seg.endSec },
        "Stat-popin dropped: numeric value not found in word timings window"
      );
    }
    return found;
  });
}

// ── Budget enforcement ──

interface BudgetOptions {
  durationSec: number;
  /** Max segments per 6 seconds (default). Tunable for very long videos. */
  maxSegmentsPer6Sec?: number;
  /** Max total broll fraction of duration (default 0.35). */
  maxBrollFraction?: number;
}

/**
 * Enforce time/count budgets on a segment list. Mutates only by FILTERING —
 * never reshapes individual segments. Strategy:
 *   1. Sort by start time
 *   2. Drop overlapping segments (keep the earlier one)
 *   3. Drop "none" mode entries (they're explicit no-ops, no point passing on)
 *   4. Cap broll-* total time at maxBrollFraction * durationSec by greedily
 *      keeping shorter ones first (preserves visual rhythm vs. one huge one)
 *   5. Cap segment count at floor(durationSec / 6)
 */
export function enforceBudget(segments: Segment[], opts: BudgetOptions): Segment[] {
  const { durationSec, maxSegmentsPer6Sec = 1, maxBrollFraction = 0.35 } = opts;
  const maxCount = Math.max(1, Math.floor((durationSec / 6) * maxSegmentsPer6Sec));
  const maxBrollSec = durationSec * maxBrollFraction;

  // 1. Sort + clamp times
  const sorted = segments
    .map((s) => ({
      ...s,
      startSec: Math.max(0, Math.min(s.startSec, durationSec)),
      endSec: Math.max(0, Math.min(s.endSec, durationSec)),
    }))
    .filter((s) => s.endSec > s.startSec)
    .filter((s) => s.mode !== "none")
    .sort((a, b) => a.startSec - b.startSec);

  // 2. Drop overlaps (keep earlier)
  const nonOverlap: Segment[] = [];
  let lastEnd = -1;
  for (const s of sorted) {
    if (s.startSec >= lastEnd) {
      nonOverlap.push(s);
      lastEnd = s.endSec;
    }
  }

  // 3. Cap broll-* total time
  let brollTotal = 0;
  // Greedy: shorter broll segments first so we can fit more
  const brolls = nonOverlap
    .filter((s) => s.mode === "broll-pip" || s.mode === "broll-fullscreen")
    .slice()
    .sort((a, b) => (a.endSec - a.startSec) - (b.endSec - b.startSec));
  const keptBrollIds = new Set<number>();
  for (let i = 0; i < brolls.length; i++) {
    const len = brolls[i].endSec - brolls[i].startSec;
    if (brollTotal + len <= maxBrollSec) {
      keptBrollIds.add(nonOverlap.indexOf(brolls[i]));
      brollTotal += len;
    }
  }
  const afterBrollCap = nonOverlap.filter((s, i) => {
    if (s.mode === "broll-pip" || s.mode === "broll-fullscreen") {
      return keptBrollIds.has(i);
    }
    return true;
  });

  // 4. Cap total count (preserve order — drop from the END so the start of the
  // video keeps its energy)
  const capped = afterBrollCap.slice(0, maxCount);

  return capped;
}

// ── Cache helpers ──

function cacheKey(input: {
  script: string;
  wordTimings: WordTiming[];
  style: string;
  platform: string;
  duration: number;
}): string {
  const h = createHash("sha256");
  h.update(input.script);
  h.update("|");
  // Stringify word timings deterministically (already in fixed shape).
  h.update(JSON.stringify(input.wordTimings.map((w) => [w.word, w.startSec.toFixed(3), w.durationSec.toFixed(3)])));
  h.update("|");
  h.update(input.style);
  h.update("|");
  h.update(input.platform);
  h.update("|");
  h.update(input.duration.toFixed(2));
  // Bump this when prompt or schema changes meaningfully so old caches are invalidated.
  // v2: added server-side stat-popin numeric validation + shortened intro lockout to 1.0s.
  h.update("|v2");
  return h.digest("hex");
}

async function readCache(cacheDir: string, key: string): Promise<SegmenterPlan | null> {
  const p = path.join(cacheDir, `${key}.json`);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    const parsed = SegmenterPlanSchema.parse(JSON.parse(raw));
    return parsed;
  } catch {
    return null; // corrupted cache: ignore + refetch
  }
}

async function writeCache(cacheDir: string, key: string, plan: SegmenterPlan): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(plan, null, 2), "utf8");
}

// ── Prompt ──

function buildPrompt(input: {
  script: string;
  wordTimings: WordTiming[];
  style: string;
  platform: string;
  duration: number;
}): string {
  // Compact word table: one line per "phrase chunk" so the LLM can locate
  // moments without us blowing the prompt to thousands of tokens.
  // We chunk every ~8 words AND on punctuation boundaries.
  const lines: string[] = [];
  let buf: string[] = [];
  let chunkStart = input.wordTimings[0]?.startSec ?? 0;
  const flush = () => {
    if (buf.length === 0) return;
    const last = input.wordTimings[Math.min(input.wordTimings.length - 1, lines.length * 8 + buf.length - 1)];
    const end = last ? last.startSec + last.durationSec : chunkStart;
    lines.push(`[${chunkStart.toFixed(2)}-${end.toFixed(2)}] ${buf.join(" ")}`);
    buf = [];
  };
  for (let i = 0; i < input.wordTimings.length; i++) {
    if (buf.length === 0) chunkStart = input.wordTimings[i].startSec;
    buf.push(input.wordTimings[i].word);
    const endsClause = /[.!?,;:]$/.test(input.wordTimings[i].word);
    if (buf.length >= 8 || endsClause) flush();
  }
  flush();

  const maxBrollSec = (input.duration * 0.35).toFixed(1);
  const maxSegments = Math.max(1, Math.floor(input.duration / 6));

  return `You are a senior video editor planning B-roll cutaways for a ${input.platform} video.

THE SCRIPT (chunked with timestamps):
${lines.join("\n")}

VIDEO META:
- Style: ${input.style}
- Total duration: ${input.duration.toFixed(2)} seconds
- Hard budget: ≤ ${maxSegments} total cutaway segments, ≤ ${maxBrollSec}s total B-roll time
- AVATAR ANCHOR RULE: the speaker on camera is the anchor — most B-roll should be PiP corner inserts. Use FULLSCREEN B-roll sparingly (max 1, only on very visual moments like "imagine X").

For each "moment" in the script that would benefit from a visual cutaway, output ONE entry:

- "broll-pip"        — small corner-of-screen video clip during the segment. Use for concrete nouns (product, place, activity).
- "broll-fullscreen" — full-frame B-roll replacing the avatar briefly. Use SPARINGLY for high-impact "imagine"/"picture this" moments.
- "stat-popin"       — animated number/percentage callout. Use whenever the script says a number, percentage, dollar amount, or "X times more".
- (no entry)         — for talking-head sections without a visual hook.

Each entry MUST include:
- "startSec", "endSec": align to chunk boundaries from the script above. Segments cannot overlap.
- "mode": one of the four above
- "concept": a 2-4 word stock-footage search query (lowercase, no quotes). REQUIRED for broll-pip / broll-fullscreen, set to null for stat-popin.
- "emphasisText": the exact word(s) being emphasized (for stat-popin only). Set to null for broll-* modes.

CRITICAL RULES:
- Never place a segment in the FIRST 1.0 seconds (intro sting blackout).
- Never place a segment in the LAST 2.5 seconds (outro CTA card).
- Stat-popin MUST coincide with a numeric word actually present in the script.
- Broll-pip segments should be 1.5-3s long; broll-fullscreen 2-4s; stat-popin 0.6-1.2s.
- If the script has no obvious visual hooks, return ZERO segments. It's better to ship clean than to force B-roll.

Return ONLY a JSON object in this exact shape (no markdown, no commentary):
{"segments":[{"startSec":4.20,"endSec":6.10,"mode":"broll-pip","concept":"data dashboard","emphasisText":null}]}`;
}

// ── Public API ──

export interface SegmentScriptOptions {
  script: string;
  wordTimings: WordTiming[];
  style: string;
  platform: string;
  duration: number;
  /** Cache directory. Defaults to `<outputs>/cache/llm`. */
  cacheDir?: string;
}

export interface SegmentScriptResult extends SegmenterPlan {
  /** True when result was served from disk cache (no LLM call). */
  cached: boolean;
  /** Cache key (sha256 hex). Useful for diagnostics. */
  cacheKey: string;
}

/**
 * Plan B-roll insertion segments for a script. Always returns a valid plan —
 * `{ segments: [] }` on any failure. Caller can wire the result straight into
 * the B-roll engine (T203) without null-checking.
 */
export async function segmentScript(opts: SegmentScriptOptions): Promise<SegmentScriptResult> {
  const { script, wordTimings, style, platform, duration } = opts;

  // Defensive: empty inputs → no-op, no API call
  if (!script.trim() || wordTimings.length === 0 || duration <= 0) {
    return { segments: [], cached: false, cacheKey: "" };
  }

  const key = cacheKey({ script, wordTimings, style, platform, duration });
  const cacheDir = opts.cacheDir ?? path.resolve(process.cwd(), "outputs", "cache", "llm");

  // Cache hit?
  const cached = await readCache(cacheDir, key);
  if (cached) {
    logger.info({ cacheKey: key, segmentCount: cached.segments.length }, "Script segmenter cache HIT");
    return { ...cached, cached: true, cacheKey: key };
  }

  // No API key configured → graceful skip
  if (!apiKey || !endpoint) {
    logger.warn({ cacheKey: key }, "Script segmenter: Azure OpenAI not configured; returning empty plan");
    return { segments: [], cached: false, cacheKey: key };
  }

  // LLM call
  const prompt = buildPrompt({ script, wordTimings, style, platform, duration });
  let raw = "";
  try {
    const response = await client.chat.completions.create({
      model: deploymentName,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
      temperature: 0.4,
      response_format: { type: "json_object" },
    });
    raw = response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    // Never log the full axios/openai error — just the message
    logger.warn({ err: (err as Error).message, cacheKey: key }, "Script segmenter: LLM call failed");
    return { segments: [], cached: false, cacheKey: key };
  }

  // Parse + validate
  let parsed: SegmenterPlan;
  try {
    const json = JSON.parse(raw.replace(/```json\n?|```/g, ""));
    parsed = SegmenterPlanSchema.parse(json);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, rawSample: raw.slice(0, 200), cacheKey: key },
      "Script segmenter: response parse/validate failed"
    );
    return { segments: [], cached: false, cacheKey: key };
  }

  // Enforce budgets in code
  const budgeted = enforceBudget(parsed.segments, { durationSec: duration });

  // Server-side guard: drop stat-popins whose emphasisText number does not
  // appear in word timings — prevents hallucinated stats from reaching the renderer.
  const validated = validateStatPopins(budgeted, wordTimings);
  const finalPlan: SegmenterPlan = { segments: validated };

  logger.info(
    {
      cacheKey: key,
      llmSegmentCount: parsed.segments.length,
      budgetedCount: budgeted.length,
      finalSegmentCount: validated.length,
      droppedStatPopins: budgeted.filter((s) => s.mode === "stat-popin").length
        - validated.filter((s) => s.mode === "stat-popin").length,
      modes: validated.map((s) => s.mode),
    },
    "Script segmenter: plan generated"
  );

  // Persist cache (best-effort — failure here is non-fatal)
  try {
    await writeCache(cacheDir, key, finalPlan);
  } catch (err) {
    logger.warn({ err: (err as Error).message, cacheKey: key }, "Script segmenter: cache write failed");
  }

  return { ...finalPlan, cached: false, cacheKey: key };
}
