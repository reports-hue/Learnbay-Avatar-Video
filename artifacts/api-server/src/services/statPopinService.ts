import { promises as fs } from "fs";
import type { Segment } from "./scriptSegmenter.js";

// ──────────────────────────────────────────────────────────────────────
// statPopinService — Premium animated stat callouts
//
// T204 — pivoted away from a Lottie/Chromium pipeline (see session plan
// for rationale) toward a pure ASS+drawtext composition that delivers
// visually-equivalent premium "stat counter" animations with zero new
// dependencies and full determinism.
//
// Composition (per stat):
//   1. Backdrop pill (vector \p1 rounded rect) scales in 0→180ms
//   2. Number count-up: stepped Dialogue events emit 0,7,14,…,N over 380ms
//   3. Suffix label ("%", "M", "x", …) pops in 480-680ms
//   4. Vector icon (arrow-up / sparkle / checkmark / dollar) spins in 560-820ms
//   5. Underline accent draws left→right 700-900ms
//   6. Particle burst: 8 radial particles emit at 700ms, fade by 1100ms
//   7. Hold for ≥ 1.0s, then fade out 350ms
//
// All commas inside `{...}` ASS override blocks are PLAIN (not escaped).
// Escape only applies to FFmpeg `enable=` expressions at filter level.
// ──────────────────────────────────────────────────────────────────────

export type IconType = "arrow-up" | "sparkle" | "checkmark" | "dollar" | "none";

export interface ParsedStat {
  /** The numeric portion as a string, e.g. "70", "2.5", "10", "5". Null when no numeric found. */
  numeric: string | null;
  /** Suffix after the number, e.g. "%", "M", "x", "million", "$". Empty string when none. */
  suffix: string;
  /** Prefix before the number, e.g. "$" for "$2.5M". Empty string when none. */
  prefix: string;
  /** Icon to render alongside the stat. Picked by suffix/prefix pattern. */
  iconType: IconType;
  /** Final integer floor of the numeric value, used for count-up (e.g. 2.5 → 2 visible steps). */
  numericFloor: number;
  /** True when the source had a decimal — count-up will show ".5" suffix on the last frame. */
  hasDecimal: boolean;
  /** Decimal portion preserved as a string so we can render "2.5M" cleanly. */
  decimalStr: string;
}

export interface StatPopinTimings {
  /** Absolute scene time the animation starts (segment startSec). */
  startSec: number;
  /** Absolute scene time the animation ends (after fade-out). */
  endSec: number;
  /** Pill scale-in window (relative to startSec). */
  pillIn: { start: number; end: number };
  /** Number count-up window. */
  countUp: { start: number; end: number; steps: number };
  /** Suffix pop-in window. */
  suffixIn: { start: number; end: number };
  /** Icon spin-in window. */
  iconIn: { start: number; end: number };
  /** Underline draw-in window. */
  underlineIn: { start: number; end: number };
  /** Particle burst window. */
  burst: { start: number; end: number };
  /** Hold duration (post-assemble before fade). */
  holdEnd: number;
  /** Final fade-out window. */
  fadeOut: { start: number; end: number };
}

export interface GenerateStatPopinAssOptions {
  segments: Segment[];
  outputPath: string;
  /** Frame width (e.g. 1920). */
  w: number;
  /** Frame height (e.g. 1080). */
  h: number;
  /** Brand accent color (hex with or without leading #). */
  accentColor: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function toAssColor(hex: string): string {
  const clean = hex.replace(/^#/, "").slice(0, 6).padEnd(6, "0");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function formatAssTime(totalSec: number): string {
  const safe = Math.max(0, totalSec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(s: string): string {
  // ASS in-line text escaping. Override-block commas are NOT touched here —
  // those must remain plain inside `{...}` per the documented gotcha.
  return s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

// ─────────────────────────────────────────────
// Stat parsing
// ─────────────────────────────────────────────

/**
 * Pulls the numeric/suffix/prefix/icon out of a stat emphasis string.
 * Returns parsed pieces with `numeric=null` when no recognizable stat found
 * so callers can decide whether to skip rendering or fall back to a plain
 * label-only callout.
 */
export function parseStatEmphasis(text: string | null | undefined): ParsedStat {
  const empty: ParsedStat = {
    numeric: null,
    suffix: "",
    prefix: "",
    iconType: "none",
    numericFloor: 0,
    hasDecimal: false,
    decimalStr: "",
  };
  if (!text) return empty;
  const trimmed = text.trim();
  if (!trimmed) return empty;

  // First, try the most specific patterns.
  // Pattern: $N or $N.NN with optional K/M/B suffix, e.g. "$2.5M"
  let m = trimmed.match(/^\$\s*(\d+)(?:[.,](\d+))?\s*([KMB])?$/i);
  if (m) {
    const intPart = m[1];
    const decPart = m[2] ?? "";
    const scale = (m[3] ?? "").toUpperCase();
    return {
      numeric: intPart,
      decimalStr: decPart,
      hasDecimal: decPart.length > 0,
      suffix: scale,
      prefix: "$",
      iconType: "dollar",
      numericFloor: parseInt(intPart, 10) || 0,
    };
  }

  // Pattern: percent — "70%" / "9.5%"
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?\s*%$/);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: "%",
      prefix: "",
      iconType: "arrow-up",
      numericFloor: parseInt(m[1], 10) || 0,
    };
  }

  // Pattern: x-multiplier — "10x", "3.5X"
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?\s*x$/i);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: "x",
      prefix: "",
      iconType: "sparkle",
      numericFloor: parseInt(m[1], 10) || 0,
    };
  }

  // Pattern: comma-separated big number — "50,000" / "1,500,000"
  m = trimmed.match(/^(\d{1,3}(?:,\d{3})+)$/);
  if (m) {
    const raw = m[1].replace(/,/g, "");
    const n = parseInt(raw, 10) || 0;
    return {
      numeric: m[1],
      decimalStr: "",
      hasDecimal: false,
      suffix: "",
      prefix: "",
      iconType: "arrow-up",
      numericFloor: n,
    };
  }

  // Pattern: bare number followed by scale word — "5 million"
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?\s+(thousand|million|billion|trillion|hundred|k|m|b)$/i);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: m[3].toUpperCase().slice(0, 1),
      prefix: "",
      iconType: "arrow-up",
      numericFloor: parseInt(m[1], 10) || 0,
    };
  }

  // Pattern: bare numeric — "70"
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?$/);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: "",
      prefix: "",
      iconType: "sparkle",
      numericFloor: parseInt(m[1], 10) || 0,
    };
  }

  // Fallback — couldn't parse. Caller should skip rendering.
  return empty;
}

// ─────────────────────────────────────────────
// Timing computation
// ─────────────────────────────────────────────

/**
 * Build the 5-phase timing skeleton for a stat-popin segment. All offsets
 * are absolute scene times. Caps total duration to the segment + a hold,
 * so back-to-back stats don't overlap visually.
 */
export function computeStatPopinTimings(
  segment: Segment,
  opts: { fps?: number; minHoldSec?: number } = {}
): StatPopinTimings {
  const fps = opts.fps ?? 30;
  const minHold = opts.minHoldSec ?? 1.0;
  const startSec = Math.max(0, segment.startSec);
  // Assemble window — pill + count + suffix + icon + underline complete by ~1.1s
  const ASSEMBLE_END = 1.1;
  // Hold the assembled stat for ≥ minHold after the segment ends
  const segEnd = Math.max(segment.endSec, segment.startSec + 0.5);
  const holdEnd = Math.max(startSec + ASSEMBLE_END + minHold, segEnd + minHold);
  const FADE_DUR = 0.35;
  const endSec = holdEnd + FADE_DUR;

  const countSteps = Math.max(8, Math.min(14, Math.round(0.38 * fps)));

  return {
    startSec,
    endSec,
    pillIn: { start: 0, end: 0.18 },
    countUp: { start: 0.18, end: 0.56, steps: countSteps },
    suffixIn: { start: 0.48, end: 0.68 },
    iconIn: { start: 0.56, end: 0.82 },
    underlineIn: { start: 0.7, end: 0.9 },
    burst: { start: 0.7, end: 1.1 },
    holdEnd: holdEnd - startSec,
    fadeOut: { start: holdEnd - startSec, end: endSec - startSec },
  };
}

// ─────────────────────────────────────────────
// Lockout windows for T103 collision avoidance
// ─────────────────────────────────────────────

/**
 * For each stat-popin segment we render with T204, return a [start, end]
 * range that T103's auto-detector should EXCLUDE. Padded by ±0.5s so a
 * stat caught by both detectors at slightly-different word boundaries
 * still collides correctly.
 */
export function buildStatPopinLockoutWindows(segments: Segment[]): Array<[number, number]> {
  return segments
    .filter((s) => s.mode === "stat-popin")
    .map((s) => [Math.max(0, s.startSec - 0.5), s.endSec + 0.5] as [number, number]);
}

// ─────────────────────────────────────────────
// Vector primitives (ASS \p1 drawing commands)
// ─────────────────────────────────────────────

/**
 * Generate the \p1 vector path for an icon, scaled to fit a `size`-px
 * bounding box. Path is centered around (0,0) so callers can position
 * with \pos. ASS coordinate system: x→right, y→down.
 */
function buildIconPath(iconType: IconType, size: number): string {
  const s = Math.round(size);
  const half = Math.round(s / 2);
  switch (iconType) {
    case "arrow-up": {
      // Solid up-arrow: triangle head + thick stem
      const headTop = -half;
      const headBot = -Math.round(s * 0.05);
      const stemTop = headBot;
      const stemBot = half;
      const headHalfW = Math.round(s * 0.5);
      const stemHalfW = Math.round(s * 0.18);
      return `m ${-headHalfW} ${headBot} l 0 ${headTop} l ${headHalfW} ${headBot} l ${stemHalfW} ${stemTop} l ${stemHalfW} ${stemBot} l ${-stemHalfW} ${stemBot} l ${-stemHalfW} ${stemTop} l ${-headHalfW} ${headBot}`;
    }
    case "checkmark": {
      // Bold checkmark (V-shape filled)
      const t = Math.round(s * 0.18); // stroke thickness
      const x1 = -Math.round(s * 0.45);
      const y1 = Math.round(s * 0.05);
      const x2 = -Math.round(s * 0.1);
      const y2 = Math.round(s * 0.4);
      const x3 = Math.round(s * 0.45);
      const y3 = -Math.round(s * 0.35);
      return `m ${x1} ${y1} l ${x2} ${y2} l ${x3} ${y3} l ${x3 - t} ${y3 - t} l ${x2} ${y2 - t * 2} l ${x1 + t} ${y1 - t} l ${x1} ${y1}`;
    }
    case "sparkle": {
      // 4-point sparkle / starburst
      const a = half;
      const b = Math.round(s * 0.12);
      return `m 0 ${-a} l ${b} ${-b} l ${a} 0 l ${b} ${b} l 0 ${a} l ${-b} ${b} l ${-a} 0 l ${-b} ${-b} l 0 ${-a}`;
    }
    case "dollar": {
      // Stylized $: a thick S-curve. Approximated with two stacked half-rings + a vertical stem.
      // Built as a simplified solid-shape that READS as a dollar at 60-100px without needing real font hinting.
      const w = Math.round(s * 0.5);
      const h2 = half;
      const t = Math.round(s * 0.16);
      // Outer rounded rect with a hollow + crossbar
      return `m ${-w} ${-h2 + t} b ${-w} ${-h2} ${w} ${-h2} ${w} ${-h2 + t} l ${w} ${-Math.round(s * 0.15)} b ${w} ${0} ${-w} ${0} ${-w} ${Math.round(s * 0.15)} l ${-w} ${h2 - t} b ${-w} ${h2} ${w} ${h2} ${w} ${h2 - t} l ${w} ${h2 - t} l ${w} ${-h2 + t} l ${-w} ${-h2 + t}`;
    }
    case "none":
    default:
      return "";
  }
}

/**
 * Rounded rectangle for the backdrop pill, centered around (0,0).
 * Bezier-corner approximation good enough for ASS drawing.
 */
function buildPillPath(width: number, height: number, radius: number): string {
  const w = Math.round(width / 2);
  const h = Math.round(height / 2);
  const r = Math.min(radius, Math.min(w, h));
  // Rounded rect via 4 cubic beziers + 4 straight lines
  return [
    `m ${-w + r} ${-h}`,
    `l ${w - r} ${-h}`,
    `b ${w} ${-h} ${w} ${-h} ${w} ${-h + r}`,
    `l ${w} ${h - r}`,
    `b ${w} ${h} ${w} ${h} ${w - r} ${h}`,
    `l ${-w + r} ${h}`,
    `b ${-w} ${h} ${-w} ${h} ${-w} ${h - r}`,
    `l ${-w} ${-h + r}`,
    `b ${-w} ${-h} ${-w} ${-h} ${-w + r} ${-h}`,
  ].join(" ");
}

// ─────────────────────────────────────────────
// ASS file generator
// ─────────────────────────────────────────────

interface RenderableStat {
  segment: Segment;
  parsed: ParsedStat;
  timings: StatPopinTimings;
}

/**
 * Compose the ASS subtitle file containing every stat-popin animation.
 * Skips segments with no parseable numeric or non-stat-popin mode so
 * the caller can pass the full segmenter plan unchanged.
 *
 * Returns `false` (and does NOT write the file) when there are no
 * renderable stats, so the caller can skip the subtitles filter.
 */
export async function generateStatPopinAss(opts: GenerateStatPopinAssOptions): Promise<boolean> {
  const { segments, outputPath, w, h, accentColor } = opts;
  const isVertical = h > w;

  // Filter to renderable stats and build their parsed + timing data
  const renderables: RenderableStat[] = [];
  for (const seg of segments) {
    if (seg.mode !== "stat-popin") continue;
    const parsed = parseStatEmphasis(seg.emphasisText);
    if (!parsed.numeric) continue;
    const timings = computeStatPopinTimings(seg);
    renderables.push({ segment: seg, parsed, timings });
  }

  if (renderables.length === 0) return false;

  // Layout — left-side in both orientations so the stat never covers the
  // avatar's face. Vertical: upper-left quadrant; landscape: left-third.
  const cx = isVertical ? Math.round(w * 0.22) : Math.round(w * 0.17);
  const cy = isVertical ? Math.round(h * 0.22) : Math.round(h * 0.40);
  // Reduced font sizes — the old 150/130 px values caused the pill to cover
  // half the avatar face. 88/78 px give a premium look without dominating.
  const numberFontSize = isVertical ? 88 : 78;
  const suffixFontSize = Math.round(numberFontSize * 0.6);

  // Pill dims — wide enough for "$2.5M" + suffix; vary slightly per platform
  const pillW = isVertical ? Math.round(w * 0.34) : Math.round(w * 0.20);
  const pillH = Math.round(numberFontSize * 1.55);
  const pillRadius = Math.round(pillH * 0.45);

  // Icon — sits to the right of the number block
  const iconSize = Math.round(numberFontSize * 0.55);
  const iconX = cx + Math.round(pillW * 0.32);

  // Underline — draws under the number block
  const underlineFullW = Math.round(pillW * 0.65);
  const underlineH = Math.round(pillH * 0.06);
  const underlineY = cy + Math.round(pillH * 0.42);

  const accentAss = toAssColor(accentColor);
  const whiteAss = "&H00FFFFFF";
  const darkAss = "&H00111111";

  // Style declarations — every visual element has its own style. BorderStyle=1
  // throughout (spec requirement). PrimaryColour, SecondaryColour, OutlineColour,
  // BackColour. Negative Bold = -1 (true).
  const styles = [
    // Pill backdrop — accent fill, thin dark outline, soft shadow
    `Style: SP_Pill,Arial,${pillH},${accentAss},${accentAss},${darkAss},&H80000000,0,0,0,0,100,100,0,0,1,2,4,5,0,0,0,1`,
    // Number — white bold + dark outline
    `Style: SP_Num,Arial Black,${numberFontSize},${whiteAss},${whiteAss},${darkAss},&H80000000,-1,0,0,0,100,100,0,0,1,4,2,5,0,0,0,1`,
    // Suffix — slightly smaller white
    `Style: SP_Suffix,Arial Black,${suffixFontSize},${whiteAss},${whiteAss},${darkAss},&H80000000,-1,0,0,0,100,100,0,0,1,3,2,5,0,0,0,1`,
    // Icon — accent-colored vector
    `Style: SP_Icon,Arial,${iconSize},${whiteAss},${whiteAss},${darkAss},&H80000000,0,0,0,0,100,100,0,0,1,2,2,5,0,0,0,1`,
    // Underline accent — white vector
    `Style: SP_Underline,Arial,1,${whiteAss},${whiteAss},${whiteAss},&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    // Particles — small white dots
    `Style: SP_Particle,Arial,1,${whiteAss},${whiteAss},${whiteAss},&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
  ].join("\n");

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];

  for (const r of renderables) {
    const t0 = r.timings.startSec;
    const tEnd = r.timings.endSec;
    const tFadeStart = t0 + r.timings.fadeOut.start;
    const finalFadeMs = Math.round(r.timings.fadeOut.end * 1000 - r.timings.fadeOut.start * 1000);

    // ── Layer 1: Pill backdrop ────────────────────────────────────────
    // Vector pill drawn via \p1...\p0. Scale-in 0→180ms with overshoot.
    // Then visible until fade-out. Use \move via stationary x-coord and
    // \fscy ramp to simulate scale.
    const pillPath = buildPillPath(pillW, pillH, pillRadius);
    const pillStart = formatAssTime(t0);
    const pillEnd = formatAssTime(tEnd);
    const pillInMs = Math.round(r.timings.pillIn.end * 1000);
    // \fad in 100ms, fade-out at end. \t scales from 70% → 105% → 100%.
    events.push(
      `Dialogue: 0,${pillStart},${pillEnd},SP_Pill,,0,0,0,,{\\pos(${cx},${cy})\\fad(100,${finalFadeMs})\\fscx70\\fscy70\\t(0,${pillInMs},1.4,\\fscx105\\fscy105)\\t(${pillInMs},${pillInMs + 80},0.8,\\fscx100\\fscy100)\\bord2\\shad4\\1c${accentAss}\\3c${darkAss}\\p1}${pillPath}{\\p0}`
    );

    // ── Layer 2: Number count-up ──────────────────────────────────────
    // Stepped Dialogue events. Each event displays one intermediate
    // value for ~countStepDur ms, then the next event takes over.
    // Final value persists until the segment fade-out.
    const countStartMs = Math.round(r.timings.countUp.start * 1000);
    const countEndMs = Math.round(r.timings.countUp.end * 1000);
    const steps = r.timings.countUp.steps;
    const finalValue = r.parsed.numericFloor;
    const stepDurMs = Math.max(20, Math.round((countEndMs - countStartMs) / steps));
    // Number x-position is slightly left of pill center to leave room for icon
    const numX = cx - Math.round(pillW * 0.08);
    const numY = cy;

    // Easing: ease-out cubic — show steps weighted toward the early frames
    // (fast start, slow finish reads as count-up momentum).
    for (let i = 0; i < steps; i++) {
      const eOut = 1 - Math.pow(1 - (i + 1) / steps, 3);
      const value = Math.round(eOut * finalValue);
      const evStart = formatAssTime(t0 + (countStartMs + i * stepDurMs) / 1000);
      const evEnd = formatAssTime(t0 + (countStartMs + (i + 1) * stepDurMs) / 1000);
      events.push(
        `Dialogue: 1,${evStart},${evEnd},SP_Num,,0,0,0,,{\\an5\\pos(${numX},${numY})}${escapeAssText(String(value))}`
      );
    }
    // Final value — held from end-of-count-up through fade
    let finalText = r.parsed.hasDecimal
      ? `${r.parsed.numeric}.${r.parsed.decimalStr}`
      : r.parsed.numeric ?? "";
    if (r.parsed.prefix) finalText = r.parsed.prefix + finalText;
    const numFinalStart = formatAssTime(t0 + countEndMs / 1000);
    const numFinalEnd = formatAssTime(tEnd);
    events.push(
      `Dialogue: 1,${numFinalStart},${numFinalEnd},SP_Num,,0,0,0,,{\\an5\\pos(${numX},${numY})\\fad(0,${finalFadeMs})}${escapeAssText(finalText)}`
    );

    // ── Layer 3: Suffix pop ───────────────────────────────────────────
    if (r.parsed.suffix) {
      const suffixX = numX + Math.round(numberFontSize * 0.45);
      const suffixY = numY;
      const suffixStart = formatAssTime(t0 + r.timings.suffixIn.start);
      const suffixEnd = formatAssTime(tEnd);
      const suffixPopMs = Math.round((r.timings.suffixIn.end - r.timings.suffixIn.start) * 1000);
      events.push(
        `Dialogue: 1,${suffixStart},${suffixEnd},SP_Suffix,,0,0,0,,{\\an4\\pos(${suffixX},${suffixY})\\fad(120,${finalFadeMs})\\fscx40\\fscy40\\t(0,${suffixPopMs},1.5,\\fscx118\\fscy118)\\t(${suffixPopMs},${suffixPopMs + 80},0.8,\\fscx100\\fscy100)}${escapeAssText(r.parsed.suffix)}`
      );
    }

    // ── Layer 4: Icon spin-in ─────────────────────────────────────────
    if (r.parsed.iconType !== "none") {
      const iconPath = buildIconPath(r.parsed.iconType, iconSize);
      if (iconPath) {
        const iconStart = formatAssTime(t0 + r.timings.iconIn.start);
        const iconEnd = formatAssTime(tEnd);
        const iconInMs = Math.round((r.timings.iconIn.end - r.timings.iconIn.start) * 1000);
        // Spin from -180° to 0° while scaling 30→105→100%
        events.push(
          `Dialogue: 2,${iconStart},${iconEnd},SP_Icon,,0,0,0,,{\\pos(${iconX},${cy})\\fad(120,${finalFadeMs})\\frz-180\\fscx30\\fscy30\\t(0,${iconInMs},1.4,\\frz0\\fscx105\\fscy105)\\t(${iconInMs},${iconInMs + 80},0.8,\\fscx100\\fscy100)\\bord2\\shad2\\1c${whiteAss}\\3c${darkAss}\\p1}${iconPath}{\\p0}`
        );
      }
    }

    // ── Layer 5: Underline accent draw-in ─────────────────────────────
    // Two stages: a 1px-wide line scales horizontally to full width.
    const underlinePath = `m ${-Math.round(underlineFullW / 2)} ${-Math.round(underlineH / 2)} l ${Math.round(underlineFullW / 2)} ${-Math.round(underlineH / 2)} l ${Math.round(underlineFullW / 2)} ${Math.round(underlineH / 2)} l ${-Math.round(underlineFullW / 2)} ${Math.round(underlineH / 2)}`;
    const underlineStart = formatAssTime(t0 + r.timings.underlineIn.start);
    const underlineEnd = formatAssTime(tEnd);
    const underlineInMs = Math.round((r.timings.underlineIn.end - r.timings.underlineIn.start) * 1000);
    events.push(
      `Dialogue: 1,${underlineStart},${underlineEnd},SP_Underline,,0,0,0,,{\\pos(${cx},${underlineY})\\fad(0,${finalFadeMs})\\fscx0\\t(0,${underlineInMs},1,\\fscx100)\\1c${whiteAss}\\bord0\\shad0\\p1}${underlinePath}{\\p0}`
    );

    // ── Layer 6: Particle burst (8 radial dots) ───────────────────────
    // 8 small white dots emit from the pill center and fly outward,
    // fading by burst.end. Each dot is its own Dialogue.
    const PARTICLE_COUNT = 8;
    const particleRadius = Math.round(pillH * 1.3);
    const particleSize = Math.round(numberFontSize * 0.05);
    const particlePath = `m ${-particleSize} ${-particleSize} l ${particleSize} ${-particleSize} l ${particleSize} ${particleSize} l ${-particleSize} ${particleSize}`;
    const particleStart = formatAssTime(t0 + r.timings.burst.start);
    const particleEnd = formatAssTime(t0 + r.timings.burst.end);
    const particleDurMs = Math.round((r.timings.burst.end - r.timings.burst.start) * 1000);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const theta = (i / PARTICLE_COUNT) * 2 * Math.PI;
      const dx = Math.round(Math.cos(theta) * particleRadius);
      const dy = Math.round(Math.sin(theta) * particleRadius);
      // Use \move(x1,y1,x2,y2,t1,t2) — note: commas inside override blocks
      // are PLAIN per the documented gotcha.
      events.push(
        `Dialogue: 3,${particleStart},${particleEnd},SP_Particle,,0,0,0,,{\\move(${cx},${cy},${cx + dx},${cy + dy},0,${particleDurMs})\\fad(60,${particleDurMs - 60})\\fscx100\\fscy100\\t(0,${particleDurMs},1,\\fscx40\\fscy40)\\1c${whiteAss}\\bord0\\shad0\\p1}${particlePath}{\\p0}`
      );
    }
  }

  await fs.writeFile(outputPath, header + events.join("\n") + "\n", "utf8");
  return true;
}
