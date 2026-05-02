/**
 * B-roll insertion engine (T203).
 *
 * Bridges the LLM segmenter (T202) and the Pexels stock-video client (T201)
 * into ffmpeg filter-graph fragments that overlay the avatar render.
 *
 * Two visual modes are supported:
 *   - "broll-pip"        — rounded-corner inset in the upper-left safe zone
 *                           (320×320 vertical, 360×360 landscape, R=28)
 *   - "broll-fullscreen" — full-frame overlay with crossfade in/out via alpha
 *
 * "stat-popin" is handled by the existing T103 numeric-callout renderer;
 * this engine ignores it. "none" segments never reach this engine because
 * `enforceBudget()` in scriptSegmenter drops them.
 *
 * HARD INVARIANTS:
 *   - Every B-roll input is consumed via `[N:v]` only — its audio track
 *     never enters the graph. (Pexels clips often have ambient audio that
 *     would clash with the avatar VO.)
 *   - All commas inside FFmpeg expressions are escaped as `\,` per the same
 *     gotcha that bit T102/T104/T106 (filtergraph parser treats unescaped
 *     commas as filter separators, even inside single-quoted exprs).
 *   - Failures are SOFT — `fetchBrollResources` returns `asset: null` for
 *     any segment whose Pexels lookup failed, and the caller composes the
 *     filter graph only for segments that have a usable asset.
 *   - License audit trail is written to `<outputsDir>/<jobId>.assets.json`
 *     after each render so we can prove which clips were used.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { searchVideo, type PexelsAsset } from "./pexelsService.js";
import type { Segment } from "./scriptSegmenter.js";
import { logger } from "../lib/logger.js";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface BrollResource {
  segment: Segment;
  /** null when Pexels lookup failed or mode doesn't need a video. */
  asset: PexelsAsset | null;
  /** Set for broll-text segments — path to the locally generated animated text MP4. */
  localClipPath?: string;
}

export interface FetchBrollOptions {
  segments: Segment[];
  isVertical: boolean;
  /** Where Pexels caches MP4s. Pass through from outputsDir/cache/pexels. */
  cacheDir: string;
  /** Brand accent color for animated text clip glow (e.g. "#4A9FFF"). */
  accentColor?: string;
}

// ─────────────────────────────────────────────
// Pexels fetch orchestrator
// ─────────────────────────────────────────────

/**
 * For each B-roll segment in the plan, look up a Pexels clip whose duration
 * covers the segment. Stat-popin segments are passed through unchanged
 * (asset=null) so callers know they exist but should be handed off to T103.
 *
 * Sequential calls (not Promise.all): Pexels rate-limits at 200 req/hr, and
 * any single render rarely needs more than 6-8 lookups, so the modest
 * latency cost (≤ 2-3 s for an uncached batch) is worth the predictable
 * load on the API.
 */
export async function fetchBrollResources(
  opts: FetchBrollOptions
): Promise<BrollResource[]> {
  const { segments, isVertical, cacheDir, accentColor = "#4488ff" } = opts;
  const orientation = isVertical ? "portrait" : "landscape";
  // Dimensions for animated text clips — match the avatar render resolution.
  const [outW, outH] = isVertical ? [1080, 1920] : [1920, 1080];
  // Animated text clips cached separately from Pexels clips.
  const animTextCacheDir = path.join(path.dirname(cacheDir), "anim_text");
  const out: BrollResource[] = [];
  // Per-job diversity ledger: pexelsIds already used in THIS render.
  // Prevents the same clip from showing twice across two different segments.
  // Cleared at the start of each fetchBrollResources call (so two unrelated
  // jobs don't punish each other's cache hits).
  const usedPexelsIds = new Set<number>();

  for (const seg of segments) {
    // ── broll-text: disabled — skip any that sneak through old caches ──
    if (seg.mode === "broll-text") {
      logger.warn({ startSec: seg.startSec }, "broll-text segment skipped (disabled)");
      continue;
    }

    // ── broll-pip / broll-fullscreen: fetch from Pexels ──
    if (seg.mode !== "broll-pip" && seg.mode !== "broll-fullscreen") {
      out.push({ segment: seg, asset: null });
      continue;
    }
    if (!seg.concept || !seg.concept.trim()) {
      out.push({ segment: seg, asset: null });
      continue;
    }
    const segDur = seg.endSec - seg.startSec;
    const minDur = Math.max(2, Math.ceil(segDur + 0.5));
    const excludePexelsIds = usedPexelsIds.size > 0
      ? Array.from(usedPexelsIds)
      : undefined;
    const asset = await searchVideo({
      query: seg.concept,
      orientation,
      minDurationSec: minDur,
      cacheDir,
      excludePexelsIds,
    });
    if (!asset) {
      logger.warn(
        {
          mode: seg.mode,
          startSec: seg.startSec,
          endSec: seg.endSec,
          conceptHead: seg.concept.slice(0, 60),
          excludedCount: excludePexelsIds?.length ?? 0,
        },
        "B-roll lookup returned no asset; segment will be skipped"
      );
    } else {
      // Mark this clip as used so subsequent segments in the same render
      // don't pick it up again. Track BOTH cache-hit and live-fetch results;
      // the goal is no duplicate footage across segments regardless of
      // whether the asset came from a cached query or a fresh download.
      usedPexelsIds.add(asset.pexelsId);
    }
    out.push({ segment: seg, asset });
  }
  return out;
}

// ─────────────────────────────────────────────
// Audit trail
// ─────────────────────────────────────────────

/**
 * Write a JSON audit log of every B-roll asset used in this render, plus
 * its Pexels attribution. Required for license compliance even though
 * Pexels doesn't strictly require attribution — auditable proof of
 * provenance protects us if a clip is later disputed.
 *
 * Always overwrites. Returns the file path on success, null on error.
 */
export async function writeBrollAuditTrail(
  jobId: string,
  outputsDir: string,
  resources: BrollResource[]
): Promise<string | null> {
  const auditPath = path.join(outputsDir, `${jobId}.assets.json`);
  try {
    const entries = resources
      .filter((r) => r.asset !== null)
      .map((r) => ({
        startSec: r.segment.startSec,
        endSec: r.segment.endSec,
        mode: r.segment.mode,
        concept: r.segment.concept,
        pexelsId: r.asset!.pexelsId,
        attribution: r.asset!.attribution,
        width: r.asset!.width,
        height: r.asset!.height,
        durationSec: r.asset!.durationSec,
        cacheKey: r.asset!.cacheKey,
        cachedFilePath: r.asset!.filePath,
      }));
    const skipped = resources
      .filter((r) => r.asset === null && r.localClipPath == null && (r.segment.mode === "broll-pip" || r.segment.mode === "broll-fullscreen" || r.segment.mode === "broll-text"))
      .map((r) => ({
        startSec: r.segment.startSec,
        endSec: r.segment.endSec,
        mode: r.segment.mode,
        concept: r.segment.concept,
        reason: "no-pexels-match",
      }));
    await fs.writeFile(
      auditPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          jobId,
          totalSegments: resources.length,
          assetsUsed: entries.length,
          assetsSkipped: skipped.length,
          assets: entries,
          skipped,
        },
        null,
        2
      )
    );
    return auditPath;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      "B-roll audit write failed"
    );
    return null;
  }
}

// ─────────────────────────────────────────────
// Filter graph builders
// ─────────────────────────────────────────────

export interface BrollPipFilterOptions {
  /** Input index of the b-roll video in the ffmpeg cmd. */
  brollInputIdx: number;
  startSec: number;
  endSec: number;
  outW: number;
  outH: number;
  isVertical: boolean;
  inputLabel: string; // base video label, e.g. "with_lt"
  outputLabel: string; // next label for the chain
  /** Globally unique tag for intermediate labels (avoids collisions). */
  uniqueTag: string;
  /** Optional border color for the frame ring (CSS hex, e.g. "#7C3AED"). Defaults to white. */
  frameColor?: string;
}

/**
 * Build a B-roll PiP overlay filter chain — rounded-corner inset in the
 * upper-LEFT safe zone (so it never collides with the top-right logo pill
 * or the bottom captions / outro card / lower-third strip).
 *
 * Produces 3 filters:
 *   1. `[N:v]setpts=...,scale,crop,format=rgba` — square crop, RGBA so geq
 *       can author the alpha channel
 *   2. `[..]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='<rounded-rect formula>'`
 *       — pixel-shader-style rounded mask; corner radius 28 px
 *   3. `[base][round]overlay=X:Y:format=auto:enable='between(t,start,end)'`
 *       — only visible during the segment window
 *
 * setpts shifts the b-roll's PTS so its t=0 lands at output t=startSec —
 * meaning the viewer sees the FIRST frame of the clip when the inset
 * appears, not a mid-clip frame. (Without this shift, the b-roll plays
 * concurrent with the base video and the viewer would join mid-clip.)
 */
export function buildBrollPipFilter(opts: BrollPipFilterOptions): string[] {
  const {
    brollInputIdx,
    startSec,
    endSec,
    outW,
    outH,
    isVertical,
    inputLabel,
    outputLabel,
    uniqueTag,
    frameColor,
  } = opts;
  const pipSize = isVertical ? 320 : 360;
  // Frame ring: 5px border on each side → total outer box is pipSize+10
  const framePad = 5;
  const outerSize = pipSize + framePad * 2;
  // Inner video corner radius; outer frame corners are radius+framePad
  const innerRadius = 20;
  const outerRadius = innerRadius + framePad;
  // Frame colour: convert CSS "#RRGGBB" → ffmpeg "0xRRGGBB", default white
  const fc = frameColor ? frameColor.replace(/^#/, "0x") : "0xFFFFFF";

  // Position safely inside frame, leaving margin for logo (top-right) and
  // captions (bottom-center). Upper-left works for both orientations.
  const margin = isVertical ? Math.round(outW * 0.04) : Math.round(outW * 0.025);
  // Outer overlay position: shift back by framePad so the VIDEO content
  // lands at the same pixel as before (visual position unchanged).
  const xPos = margin - framePad;
  const yPos = margin + Math.round(outH * 0.10) - framePad;

  // Rounded-rectangle alpha formula for a W×H box, corner radius R:
  //   dx = min(X, W-X) / dy = min(Y, H-Y) — distance to nearest edge
  //   inside = (dx>=R) || (dy>=R) || (hypot(R-dx,R-dy)<=R)
  // ALL commas inside the expression are escaped as \\, for the filtergraph.
  function roundedAlpha(R: number) {
    return (
      `if(` +
      `gte(min(X\\,W-X)\\,${R})` +
      `+gte(min(Y\\,H-Y)\\,${R})` +
      `+lte(hypot(${R}-min(X\\,W-X)\\,${R}-min(Y\\,H-Y))\\,${R})` +
      `\\,255\\,0)`
    );
  }

  const sIn      = `pip_in_${uniqueTag}`;
  const sFrame   = `pip_frame_${uniqueTag}`;
  const sRound   = `pip_round_${uniqueTag}`;
  const enableExpr = `'between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'`;

  return [
    // 1. Scale + square-crop the b-roll, shift PTS so clip starts from frame 0
    `[${brollInputIdx}:v]setpts=PTS-STARTPTS+${startSec.toFixed(3)}/TB,` +
      `scale=${pipSize}:${pipSize}:force_original_aspect_ratio=increase,` +
      `crop=${pipSize}:${pipSize},setsar=1,format=rgba[${sIn}]`,
    // 2. Pad with the frame colour on all sides → outer box with rounded corners
    `[${sIn}]pad=${outerSize}:${outerSize}:${framePad}:${framePad}:${fc}[${sFrame}]`,
    // 3. Apply rounded-corner mask to the OUTER (framed) box
    `[${sFrame}]geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${roundedAlpha(outerRadius)}'[${sRound}]`,
    // 4. Overlay the framed+rounded clip onto the base video
    `[${inputLabel}][${sRound}]overlay=${xPos}:${yPos}:format=auto:enable=${enableExpr}[${outputLabel}]`,
  ];
}

export interface BrollFullscreenFilterOptions {
  brollInputIdx: number;
  startSec: number;
  endSec: number;
  outW: number;
  outH: number;
  inputLabel: string;
  outputLabel: string;
  uniqueTag: string;
  /** Crossfade duration on each side (default 0.3s). Capped at half segment. */
  fadeDur?: number;
}

/**
 * Build a full-screen B-roll overlay with crossfade in/out via alpha.
 * Avatar continues to "exist" beneath, but is fully covered for the segment
 * window. Captions/logo/CTA still render on TOP of the b-roll because they
 * come later in the filter chain.
 *
 * Produces 3 filters:
 *   1. setpts shift + cover-scale + crop + format=yuva420p
 *   2. fade=in (alpha) at startSec for fadeDur, fade=out (alpha) at endSec-fadeDur
 *   3. overlay with enable= window
 */
export function buildBrollFullscreenFilter(
  opts: BrollFullscreenFilterOptions
): string[] {
  const {
    brollInputIdx,
    startSec,
    endSec,
    outW,
    outH,
    inputLabel,
    outputLabel,
    uniqueTag,
  } = opts;
  const segLen = endSec - startSec;
  const fadeDur = Math.min(opts.fadeDur ?? 0.3, segLen / 2);
  const fadeOutSt = endSec - fadeDur;
  const sIn = `bf_in_${uniqueTag}`;
  const sFaded = `bf_fade_${uniqueTag}`;

  const enableExpr = `'between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'`;

  // Loop the clip so it never runs out of frames. Without this, a clip that is
  // even 1 frame shorter than the segment window (floating-point rounding) will
  // leave the overlay with no input → black frame for the remainder of the window.
  // size = frames needed for the segment + 60 safety frames (2 s at 30 fps).
  const framesNeeded = Math.ceil(segLen * 30) + 60;

  return [
    `[${brollInputIdx}:v]loop=loop=-1:size=${framesNeeded}:start=0,setpts=PTS-STARTPTS+${startSec.toFixed(3)}/TB,scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1,format=yuva420p[${sIn}]`,
    `[${sIn}]fade=t=in:st=${startSec.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1,fade=t=out:st=${fadeOutSt.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1[${sFaded}]`,
    `[${inputLabel}][${sFaded}]overlay=0:0:format=auto:enable=${enableExpr}[${outputLabel}]`,
  ];
}
