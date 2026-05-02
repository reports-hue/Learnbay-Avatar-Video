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
  "broll-pip",          // legacy — treated as fullscreen in renderer
  "broll-fullscreen",
  "broll-text",         // animated text screen (dark bg + glowing key phrase)
  "stat-popin",
  "none",
]);
export type SegmentMode = z.infer<typeof SegmentModeEnum>;

export const SegmentSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  mode: SegmentModeEnum,
  /** 2-4 word stock-footage query. Required for broll-pip/broll-fullscreen. Null otherwise. */
  concept: z.string().nullable(),
  /** The literal word(s) to emphasize for stat-popin. Null for broll-* modes. */
  emphasisText: z.string().nullable(),
  /** 2-5 word key phrase to display for broll-text animated screens. Null otherwise. */
  keyPhrase: z.string().nullable().optional(),
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
  /** Max segments per 5 seconds (default). */
  maxSegmentsPer5Sec?: number;
  /** Max total broll fraction of duration (default 0.65 — 60-70% of video). */
  maxBrollFraction?: number;
}

const isBrollMode = (s: Segment) =>
  s.mode === "broll-pip" ||
  s.mode === "broll-fullscreen" ||
  s.mode === "broll-text";

/**
 * Enforce time/count budgets on a segment list. Mutates only by FILTERING —
 * never reshapes individual segments. Strategy:
 *   1. Sort by start time
 *   2. Drop overlapping segments (keep the earlier one)
 *   3. Drop "none" mode entries (they're explicit no-ops)
 *   4. Cap broll-* total time at maxBrollFraction * durationSec (greedy)
 *   5. Cap segment count at floor(durationSec / 5)
 */
export function enforceBudget(segments: Segment[], opts: BudgetOptions): Segment[] {
  const { durationSec, maxSegmentsPer5Sec = 1, maxBrollFraction = 0.65 } = opts;
  const maxCount = Math.max(2, Math.floor((durationSec / 5) * maxSegmentsPer5Sec));
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

  // 3. Cap broll-* total time (broll-pip, broll-fullscreen, broll-text)
  let brollTotal = 0;
  const brolls = nonOverlap
    .filter(isBrollMode)
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
    if (isBrollMode(s)) return keptBrollIds.has(i);
    return true;
  });

  // 3.5 Enforce minimum avatar screen time between consecutive broll windows.
  // Avatar must be visible for at least MIN_AVATAR_GAP seconds between any two
  // broll segments. First broll must not start before MIN_FIRST_BROLL seconds.
  // Any segment that violates these rules is DROPPED (safer than reshaping).
  const MIN_AVATAR_GAP = 3.0;
  const MIN_FIRST_BROLL = 2.0;
  const gapEnforced: Segment[] = [];
  let prevBrollEnd = -Infinity;
  for (const seg of afterBrollCap) {
    if (isBrollMode(seg)) {
      const minStart = prevBrollEnd < 0 ? MIN_FIRST_BROLL : prevBrollEnd + MIN_AVATAR_GAP;
      if (seg.startSec < minStart) {
        // Not enough avatar time before this broll — drop it
        continue;
      }
      prevBrollEnd = seg.endSec;
    }
    gapEnforced.push(seg);
  }

  // 4. Cap total count (drop from END to preserve opening energy)
  const capped = gapEnforced.slice(0, maxCount);

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
  // v3: added broll-text mode, fullscreen-only pattern, 65% b-roll budget.
  // v4: enforced 3s minimum avatar gap in prompt + enforceBudget; first broll ≥ 2s.
  h.update("|v4");
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

  const maxBrollSec = (input.duration * 0.65).toFixed(1);
  const maxSegments = Math.max(2, Math.floor(input.duration / 5));

  return `You are a senior video editor for a viral YouTube Shorts channel. Plan the B-roll cutaway schedule for a ${input.platform} video following the EXACT pattern used by professional viral Shorts creators:

PATTERN (follow this structure strictly):
→ Avatar speaks FULL SCREEN for 3–6 seconds
→ CUT to a full-screen visual (4–8 seconds)
→ CUT back to avatar FULL SCREEN
→ Repeat — total cutaway time must be 60–70% of the video

THE SCRIPT (chunked with timestamps):
${lines.join("\n")}

VIDEO META:
- Style: ${input.style}
- Total duration: ${input.duration.toFixed(2)} seconds
- Hard budget: ≤ ${maxSegments} cutaway segments; target ≥ ${maxBrollSec}s total b-roll time

CUTAWAY TYPES — use ONLY these three:

"broll-text" — ANIMATED TEXT SCREEN
  Full-screen dark background with large glowing white key phrase.
  Use for: powerful hooks, defining statements, key numbers, memorable phrases.
  REQUIRED: "keyPhrase" = exact 2–5 words from the script to display as animated glowing text.
  Set "concept" to null. Set "emphasisText" to null.

"broll-fullscreen" — PEXELS VIDEO CLIP
  Full-screen realistic footage matching what is being said at that moment.
  Use for: concrete scenarios, workplaces, people working, activities.
  REQUIRED: "concept" = 2–4 word Pexels search query (e.g. "student laptop study", "professional office dashboard").
  Set "keyPhrase" to null. Set "emphasisText" to null.

"stat-popin" — ANIMATED NUMBER CALLOUT
  Small animated callout for a numeric stat.
  Use only when a number, %, or dollar amount is spoken.
  REQUIRED: "emphasisText" = the exact numeric word(s). Set "concept" to null. Set "keyPhrase" to null.

RULES:
- ALTERNATE broll-text and broll-fullscreen for visual rhythm (avoid 3 of the same type consecutively).
- NEVER use broll-pip — it is completely disabled.
- Each broll-text / broll-fullscreen segment MUST be 4–8 seconds long.
- stat-popin segments: 0.6–1.2 seconds only.
- Segments cannot overlap.
- Never place a segment in the FIRST 2.0 seconds or the LAST 2.5 seconds.
- Avatar MUST be visible for AT LEAST 3 seconds between any two consecutive cutaways. Never schedule two broll segments with less than 3 seconds of avatar time between them.
- Stat-popin MUST coincide with a numeric word actually present in the script.

Return ONLY valid JSON (no markdown, no commentary):
{"segments":[{"startSec":4.0,"endSec":8.5,"mode":"broll-text","concept":null,"keyPhrase":"next big wave","emphasisText":null},{"startSec":13.0,"endSec":19.0,"mode":"broll-fullscreen","concept":"professional office screens","keyPhrase":null,"emphasisText":null}]}`;
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
