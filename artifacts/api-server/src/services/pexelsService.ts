/**
 * Pexels API client + caching layer (T201).
 *
 * Purpose: fetch stock B-roll clips by concept query for the LLM-driven
 * B-roll insertion engine (T203). Pexels videos are free for commercial use
 * with no attribution required, but we persist attribution metadata anyway
 * for an audit trail (`outputs/cache/pexels/<sha>.json`).
 *
 * Determinism contract:
 *   - Cache key = sha256(query + orientation + minDurationSec + "v1").
 *   - Cache hit → no network call, identical file path returned forever.
 *   - Cache miss → query Pexels, pick best clip, download to
 *     `outputs/cache/pexels/<sha>.mp4`, write `<sha>.json` metadata sidecar.
 *
 * Failure contract:
 *   - Any failure (missing key, network error, no results, download error,
 *     schema mismatch) returns `null`. Never throws. Caller skips that segment.
 *
 * Quota awareness:
 *   - Pexels free tier: 200 req/hr, 20k req/mo. Our cache is keyed forever
 *     so identical queries from different jobs share the download.
 *
 * Hard rules:
 *   - Never logs the API key.
 *   - Never logs full axios errors (status code + short message only).
 *   - Audio is irrelevant — Pexels MP4s are videoaready muted in the FFmpeg
 *     graph by selecting only the [N:v] stream, but for safety the downloader
 *     does not strip audio (caller responsibility).
 */

import axios, { AxiosError } from "axios";
import { createHash } from "crypto";
import { createWriteStream } from "fs";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { z } from "zod";
import { logger } from "../lib/logger.js";

// ---------- Public types ----------

export type Orientation = "landscape" | "portrait" | "square";

export interface PexelsSearchOptions {
  /** Visual concept to search for (e.g. "data dashboard", "happy team"). */
  query: string;
  /** Match output aspect — landscape for 16:9, portrait for 9:16. */
  orientation: Orientation;
  /** Minimum clip duration in seconds. Default 3. */
  minDurationSec?: number;
  /** Maximum clip duration in seconds. Default 30. */
  maxDurationSec?: number;
  /** Cache directory (caller-provided so it sits next to outputs). */
  cacheDir: string;
  /**
   * Per-page from Pexels API. Default 15 — wide enough to find a duration
   * match, narrow enough to keep response size small.
   */
  perPage?: number;
  /**
   * Pexels video ids to AVOID returning. Used by the b-roll engine to
   * prevent the same clip showing up in two different segments of the
   * same render. When non-empty, included in the cache key so a second
   * search with the same query but different exclusions caches separately.
   *
   * Best-effort: if every candidate (across all fallback queries) is
   * excluded, the function still returns null — callers must accept that
   * total diversity sometimes loses to "no clip at all".
   */
  excludePexelsIds?: number[];
}

export interface PexelsAsset {
  /** Local file path of the cached MP4. */
  filePath: string;
  /** Whether this came from the local cache (no network call). */
  cached: boolean;
  /** Cache key — sha256 of (query + orientation + minDurationSec + "v1"). */
  cacheKey: string;
  /** Pexels video id (for traceability). */
  pexelsId: number;
  /** Attribution metadata (license audit trail). */
  attribution: {
    photographer: string;
    photographerUrl: string;
    pexelsUrl: string;
    license: "Pexels License (free, commercial OK, attribution optional)";
  };
  /** Selected video file metadata. */
  width: number;
  height: number;
  durationSec: number;
}

// ---------- Pexels API schemas ----------

const PexelsVideoFileSchema = z.object({
  id: z.number(),
  // Pexels has been migrating their schema — many newer videos return
  // `quality: null` and rely on the consumer to derive HD-ness from
  // dimensions. We keep it optional/nullable and infer HD from width.
  quality: z.string().nullable().optional(),
  file_type: z.string().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  link: z.string(),
});

const PexelsUserSchema = z.object({
  id: z.number(),
  name: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

const PexelsVideoSchema = z.object({
  id: z.number(),
  width: z.number(),
  height: z.number(),
  duration: z.number(), // seconds
  url: z.string().nullable().optional(),
  user: PexelsUserSchema,
  video_files: z.array(PexelsVideoFileSchema).min(1),
});

const PexelsSearchResponseSchema = z.object({
  videos: z.array(PexelsVideoSchema),
  total_results: z.number().optional(),
});

export type PexelsVideo = z.infer<typeof PexelsVideoSchema>;

// ---------- Internals ----------

function buildCacheKey(opts: PexelsSearchOptions): string {
  const minDur = opts.minDurationSec ?? 3;
  // Exclusions only enter the key when non-empty so the common (no-diversity)
  // case keeps its existing cache hits. Sorted so [42,7] and [7,42] hash to
  // the same key.
  const excluded = (opts.excludePexelsIds ?? []).slice().sort((a, b) => a - b);
  const payload = JSON.stringify({
    query: opts.query.trim().toLowerCase(),
    orientation: opts.orientation,
    minDurationSec: minDur,
    v: "v1",
    ...(excluded.length > 0 ? { excluded } : {}),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Build an ordered fallback chain of search queries from a single LLM
 * concept string. The first query is the concept verbatim; subsequent
 * queries strip filler words and shrink toward the most-visual keywords.
 *
 * Why: Pexels relevance ranking handles short concrete queries best
 * ("happy team meeting"), but the LLM sometimes emits longer or more
 * abstract phrases ("collaborative office team success"). A single failed
 * search would otherwise drop a whole segment to zero b-roll. The chain
 * gives Pexels multiple shots before we give up.
 *
 * Pure function — exported for testing. No deduplication of identical
 * variants; downstream loop handles that with a Set.
 */
const QUERY_FILLER_WORDS = new Set([
  "a", "an", "the", "of", "for", "with", "to", "in", "on", "at", "by",
  "about", "through", "via", "using", "and", "or", "but", "as", "is",
  "are", "was", "were", "be", "been", "being", "from", "into", "over",
  "under", "than", "then", "this", "that", "these", "those", "it", "its",
]);

export function buildSearchQueries(concept: string): string[] {
  const cleaned = concept.trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleaned) return [];
  const queries: string[] = [cleaned];

  const tokens = cleaned.split(" ").filter(Boolean);
  const keywords = tokens.filter((t) => !QUERY_FILLER_WORDS.has(t));

  // Variant 2: top-3 keywords joined (only if it actually differs)
  if (keywords.length >= 1) {
    const top3 = keywords.slice(0, 3).join(" ");
    if (top3 && top3 !== cleaned && !queries.includes(top3)) queries.push(top3);
  }
  // Variant 3: top-2 keywords (more generic)
  if (keywords.length >= 2) {
    const top2 = keywords.slice(0, 2).join(" ");
    if (!queries.includes(top2)) queries.push(top2);
  }
  // Variant 4: single most-visual keyword as last-ditch
  if (keywords.length >= 1) {
    const top1 = keywords[0];
    if (!queries.includes(top1)) queries.push(top1);
  }

  return queries;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Pick the best video file from a Pexels video object.
 *
 * Strategy:
 *   - Reject HLS manifests (`.m3u8`) and any non-mp4 file_type.
 *   - Score by closeness to target dimensions (matching aspect orientation).
 *     Below-target dimensions are penalized 3× to discourage upscaling.
 *   - Newer Pexels videos return `quality: null` — we no longer rely on it.
 */
export function pickBestFile(
  video: PexelsVideo,
  orientation: Orientation
): PexelsVideo["video_files"][number] | null {
  const targetW = orientation === "portrait" ? 1080 : 1920;
  const targetH = orientation === "portrait" ? 1920 : 1080;

  const candidates = video.video_files.filter((f) => {
    // Strip query params before extension check (Pexels CDN URLs are clean
    // .mp4s today, but defensive in case that changes).
    const linkPath = f.link.split("?")[0].toLowerCase();
    if (linkPath.endsWith(".m3u8")) return false;
    if (f.file_type && f.file_type !== "video/mp4") return false;
    if (!linkPath.endsWith(".mp4")) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  // Score by closeness to target dimensions.
  const scored = candidates.map((f) => {
    const w = f.width ?? 0;
    const h = f.height ?? 0;
    // Penalty for being below target (we'd have to upscale).
    const wDelta = w >= targetW ? w - targetW : (targetW - w) * 3;
    const hDelta = h >= targetH ? h - targetH : (targetH - h) * 3;
    // Legacy quality flag still used as light tiebreaker when present.
    const hdBonus = f.quality === "hd" ? -1000 : 0;
    return { f, score: hdBonus + wDelta + hDelta };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0].f;
}

/**
 * Pick the best video from a Pexels search response.
 *
 * Strategy:
 *   - Filter to videos within [minDurationSec, maxDurationSec].
 *   - Among those, prefer the one with the most appropriate aspect ratio
 *     (matches `orientation`).
 *   - Tie-break on resolution closest to the target.
 */
export function pickBestVideo(
  videos: PexelsVideo[],
  orientation: Orientation,
  minDurationSec: number,
  maxDurationSec: number,
  excludePexelsIds?: number[]
): PexelsVideo | null {
  const targetIsPortrait = orientation === "portrait";
  const excluded = excludePexelsIds && excludePexelsIds.length > 0
    ? new Set(excludePexelsIds)
    : null;
  const matches = videos.filter(
    (v) =>
      v.duration >= minDurationSec &&
      v.duration <= maxDurationSec &&
      (!excluded || !excluded.has(v.id))
  );
  if (matches.length === 0) return null;

  const scored = matches.map((v) => {
    const aspect = v.width / Math.max(1, v.height);
    const isPortrait = aspect < 1;
    const aspectMatch = isPortrait === targetIsPortrait ? 0 : 1_000_000;
    // Penalize tiny videos.
    const minDim = Math.min(v.width, v.height);
    const sizePenalty = minDim < 720 ? 100_000 : 0;
    return { v, score: aspectMatch + sizePenalty - minDim };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0].v;
}

async function downloadToFile(url: string, dest: string): Promise<number> {
  const resp = await axios.get<NodeJS.ReadableStream>(url, {
    responseType: "stream",
    timeout: 60_000,
    maxRedirects: 5,
  });
  if (resp.status !== 200) {
    throw new Error(`download status=${resp.status}`);
  }
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(dest);
    resp.data.pipe(ws);
    ws.on("finish", () => resolve());
    ws.on("error", reject);
    resp.data.on("error", reject);
  });
  const s = await stat(dest);
  if (s.size === 0) throw new Error("empty download");
  return s.size;
}

// ---------- Public API ----------

/**
 * Search Pexels for a B-roll clip matching the given query, download it
 * to the cache, and return its local path + attribution metadata.
 *
 * Returns `null` on any failure (missing key, no results, network error).
 */
export async function searchVideo(
  opts: PexelsSearchOptions
): Promise<PexelsAsset | null> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    logger.warn({ msg: "pexels: PEXELS_API_KEY not set, skipping" });
    return null;
  }

  const query = (opts.query ?? "").trim();
  if (!query) {
    logger.warn({ msg: "pexels: empty query" });
    return null;
  }

  const minDur = opts.minDurationSec ?? 3;
  const maxDur = opts.maxDurationSec ?? 30;
  const perPage = Math.max(1, Math.min(80, opts.perPage ?? 15));
  const cacheKey = buildCacheKey(opts);

  await mkdir(opts.cacheDir, { recursive: true });
  const mp4Path = path.join(opts.cacheDir, `${cacheKey}.mp4`);
  const metaPath = path.join(opts.cacheDir, `${cacheKey}.json`);

  // ----- Cache hit -----
  if (await fileExists(mp4Path)) {
    try {
      const metaRaw = await readFile(metaPath, "utf8");
      const meta = JSON.parse(metaRaw) as PexelsAsset;
      return { ...meta, filePath: mp4Path, cached: true, cacheKey };
    } catch (e) {
      logger.warn({
        msg: "pexels: cache meta unreadable, refetching",
        cacheKey,
        err: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
      // fall through to refetch
    }
  }

  // ----- Live search with fallback query chain -----
  // Try each query variant in order; first one that returns a usable
  // (non-excluded, duration-matching, mp4-bearing) video wins.
  const queryChain = buildSearchQueries(query);
  const tried = new Set<string>();
  let video: PexelsVideo | null = null;
  let lastQueryUsed: string = query;

  for (const q of queryChain) {
    if (tried.has(q)) continue;
    tried.add(q);
    let videos: PexelsVideo[] = [];
    try {
      const resp = await axios.get("https://api.pexels.com/videos/search", {
        params: {
          query: q,
          orientation: opts.orientation,
          per_page: perPage,
          size: "medium", // Pexels allowed values: small | medium | large
        },
        headers: { Authorization: apiKey },
        timeout: 20_000,
      });
      const parsed = PexelsSearchResponseSchema.safeParse(resp.data);
      if (!parsed.success) {
        logger.warn({
          msg: "pexels: response schema mismatch",
          query: q.slice(0, 60),
          firstError: parsed.error.errors[0]?.message?.slice(0, 200),
        });
        // Don't try more variants on a schema mismatch — Pexels API itself
        // is broken; subsequent calls will hit the same problem.
        return null;
      }
      videos = parsed.data.videos;
    } catch (e) {
      const ax = e as AxiosError;
      logger.warn({
        msg: "pexels: search request failed",
        query: q.slice(0, 60),
        status: ax.response?.status,
        shortErr: ax.message?.slice(0, 200),
      });
      // For network/HTTP errors keep trying — the next variant might
      // happen to hit a healthy edge or pass the rate-limit window.
      continue;
    }

    if (videos.length === 0) continue;

    const candidate = pickBestVideo(
      videos,
      opts.orientation,
      minDur,
      maxDur,
      opts.excludePexelsIds,
    );
    if (candidate) {
      video = candidate;
      lastQueryUsed = q;
      break;
    }
  }

  if (!video) {
    logger.warn({
      msg: "pexels: no usable video across all query variants",
      query: query.slice(0, 60),
      variantsTried: tried.size,
      excludedCount: opts.excludePexelsIds?.length ?? 0,
    });
    return null;
  }
  const file = pickBestFile(video, opts.orientation);
  if (!file) {
    logger.warn({
      msg: "pexels: video has no usable mp4 file",
      pexelsId: video.id,
    });
    return null;
  }

  // ----- Download -----
  try {
    await downloadToFile(file.link, mp4Path);
  } catch (e) {
    logger.warn({
      msg: "pexels: download failed",
      pexelsId: video.id,
      shortErr: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
    return null;
  }

  const asset: PexelsAsset = {
    filePath: mp4Path,
    cached: false,
    cacheKey,
    pexelsId: video.id,
    attribution: {
      photographer: video.user.name ?? "Pexels Contributor",
      photographerUrl: video.user.url ?? "https://www.pexels.com",
      pexelsUrl: video.url ?? `https://www.pexels.com/video/${video.id}/`,
      license: "Pexels License (free, commercial OK, attribution optional)",
    },
    width: file.width ?? video.width,
    height: file.height ?? video.height,
    durationSec: video.duration,
  };

  try {
    await writeFile(metaPath, JSON.stringify(asset, null, 2), "utf8");
  } catch (e) {
    logger.warn({
      msg: "pexels: meta write failed (clip still usable this run)",
      shortErr: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
  }

  logger.info({
    msg: "pexels: cached new clip",
    pexelsId: video.id,
    durationSec: video.duration,
    width: asset.width,
    height: asset.height,
    photographer: video.user.name,
    originalQuery: query.slice(0, 60),
    queryUsed: lastQueryUsed.slice(0, 60),
    excludedCount: opts.excludePexelsIds?.length ?? 0,
  });

  return asset;
}
