import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/services/statPopinService.ts
import { promises as fs } from "fs";
function toAssColor(hex) {
  const clean = hex.replace(/^#/, "").slice(0, 6).padEnd(6, "0");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
function formatAssTime(totalSec) {
  const safe = Math.max(0, totalSec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor(safe % 3600 / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor(safe % 1 * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function escapeAssText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}
function parseStatEmphasis(text) {
  const empty = {
    numeric: null,
    suffix: "",
    prefix: "",
    iconType: "none",
    numericFloor: 0,
    hasDecimal: false,
    decimalStr: ""
  };
  if (!text) return empty;
  const trimmed = text.trim();
  if (!trimmed) return empty;
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
      numericFloor: parseInt(intPart, 10) || 0
    };
  }
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?\s*%$/);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: "%",
      prefix: "",
      iconType: "arrow-up",
      numericFloor: parseInt(m[1], 10) || 0
    };
  }
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?\s*x$/i);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: "x",
      prefix: "",
      iconType: "sparkle",
      numericFloor: parseInt(m[1], 10) || 0
    };
  }
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
      numericFloor: n
    };
  }
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?\s+(thousand|million|billion|trillion|hundred|k|m|b)$/i);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: m[3].toUpperCase().slice(0, 1),
      prefix: "",
      iconType: "arrow-up",
      numericFloor: parseInt(m[1], 10) || 0
    };
  }
  m = trimmed.match(/^(\d+)(?:[.,](\d+))?$/);
  if (m) {
    return {
      numeric: m[1],
      decimalStr: m[2] ?? "",
      hasDecimal: !!m[2],
      suffix: "",
      prefix: "",
      iconType: "sparkle",
      numericFloor: parseInt(m[1], 10) || 0
    };
  }
  return empty;
}
function computeStatPopinTimings(segment, opts = {}) {
  const fps = opts.fps ?? 30;
  const minHold = opts.minHoldSec ?? 1;
  const startSec = Math.max(0, segment.startSec);
  const ASSEMBLE_END = 1.1;
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
    fadeOut: { start: holdEnd - startSec, end: endSec - startSec }
  };
}
function buildStatPopinLockoutWindows(segments) {
  return segments.filter((s) => s.mode === "stat-popin").map((s) => [Math.max(0, s.startSec - 0.5), s.endSec + 0.5]);
}
function buildIconPath(iconType, size) {
  const s = Math.round(size);
  const half = Math.round(s / 2);
  switch (iconType) {
    case "arrow-up": {
      const headTop = -half;
      const headBot = -Math.round(s * 0.05);
      const stemTop = headBot;
      const stemBot = half;
      const headHalfW = Math.round(s * 0.5);
      const stemHalfW = Math.round(s * 0.18);
      return `m ${-headHalfW} ${headBot} l 0 ${headTop} l ${headHalfW} ${headBot} l ${stemHalfW} ${stemTop} l ${stemHalfW} ${stemBot} l ${-stemHalfW} ${stemBot} l ${-stemHalfW} ${stemTop} l ${-headHalfW} ${headBot}`;
    }
    case "checkmark": {
      const t = Math.round(s * 0.18);
      const x1 = -Math.round(s * 0.45);
      const y1 = Math.round(s * 0.05);
      const x2 = -Math.round(s * 0.1);
      const y2 = Math.round(s * 0.4);
      const x3 = Math.round(s * 0.45);
      const y3 = -Math.round(s * 0.35);
      return `m ${x1} ${y1} l ${x2} ${y2} l ${x3} ${y3} l ${x3 - t} ${y3 - t} l ${x2} ${y2 - t * 2} l ${x1 + t} ${y1 - t} l ${x1} ${y1}`;
    }
    case "sparkle": {
      const a = half;
      const b = Math.round(s * 0.12);
      return `m 0 ${-a} l ${b} ${-b} l ${a} 0 l ${b} ${b} l 0 ${a} l ${-b} ${b} l ${-a} 0 l ${-b} ${-b} l 0 ${-a}`;
    }
    case "dollar": {
      const w = Math.round(s * 0.5);
      const h2 = half;
      const t = Math.round(s * 0.16);
      return `m ${-w} ${-h2 + t} b ${-w} ${-h2} ${w} ${-h2} ${w} ${-h2 + t} l ${w} ${-Math.round(s * 0.15)} b ${w} ${0} ${-w} ${0} ${-w} ${Math.round(s * 0.15)} l ${-w} ${h2 - t} b ${-w} ${h2} ${w} ${h2} ${w} ${h2 - t} l ${w} ${h2 - t} l ${w} ${-h2 + t} l ${-w} ${-h2 + t}`;
    }
    case "none":
    default:
      return "";
  }
}
function buildPillPath(width, height, radius) {
  const w = Math.round(width / 2);
  const h = Math.round(height / 2);
  const r = Math.min(radius, Math.min(w, h));
  return [
    `m ${-w + r} ${-h}`,
    `l ${w - r} ${-h}`,
    `b ${w} ${-h} ${w} ${-h} ${w} ${-h + r}`,
    `l ${w} ${h - r}`,
    `b ${w} ${h} ${w} ${h} ${w - r} ${h}`,
    `l ${-w + r} ${h}`,
    `b ${-w} ${h} ${-w} ${h} ${-w} ${h - r}`,
    `l ${-w} ${-h + r}`,
    `b ${-w} ${-h} ${-w} ${-h} ${-w + r} ${-h}`
  ].join(" ");
}
async function generateStatPopinAss(opts) {
  const { segments, outputPath, w, h, accentColor } = opts;
  const isVertical = h > w;
  const renderables = [];
  for (const seg of segments) {
    if (seg.mode !== "stat-popin") continue;
    const parsed = parseStatEmphasis(seg.emphasisText);
    if (!parsed.numeric) continue;
    const timings = computeStatPopinTimings(seg);
    renderables.push({ segment: seg, parsed, timings });
  }
  if (renderables.length === 0) return false;
  const cx = isVertical ? Math.round(w * 0.5) : Math.round(w * 0.21);
  const cy = isVertical ? Math.round(h * 0.18) : Math.round(h * 0.42);
  const numberFontSize = isVertical ? 150 : 130;
  const suffixFontSize = Math.round(numberFontSize * 0.6);
  const pillW = isVertical ? Math.round(w * 0.55) : Math.round(w * 0.28);
  const pillH = Math.round(numberFontSize * 1.55);
  const pillRadius = Math.round(pillH * 0.45);
  const iconSize = Math.round(numberFontSize * 0.55);
  const iconX = cx + Math.round(pillW * 0.32);
  const underlineFullW = Math.round(pillW * 0.65);
  const underlineH = Math.round(pillH * 0.06);
  const underlineY = cy + Math.round(pillH * 0.42);
  const accentAss = toAssColor(accentColor);
  const whiteAss = "&H00FFFFFF";
  const darkAss = "&H00111111";
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
    `Style: SP_Particle,Arial,1,${whiteAss},${whiteAss},${whiteAss},&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`
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
  const events = [];
  for (const r of renderables) {
    const t0 = r.timings.startSec;
    const tEnd = r.timings.endSec;
    const tFadeStart = t0 + r.timings.fadeOut.start;
    const finalFadeMs = Math.round(r.timings.fadeOut.end * 1e3 - r.timings.fadeOut.start * 1e3);
    const pillPath = buildPillPath(pillW, pillH, pillRadius);
    const pillStart = formatAssTime(t0);
    const pillEnd = formatAssTime(tEnd);
    const pillInMs = Math.round(r.timings.pillIn.end * 1e3);
    events.push(
      `Dialogue: 0,${pillStart},${pillEnd},SP_Pill,,0,0,0,,{\\pos(${cx},${cy})\\fad(100,${finalFadeMs})\\fscx70\\fscy70\\t(0,${pillInMs},1.4,\\fscx105\\fscy105)\\t(${pillInMs},${pillInMs + 80},0.8,\\fscx100\\fscy100)\\bord2\\shad4\\1c${accentAss}\\3c${darkAss}\\p1}${pillPath}{\\p0}`
    );
    const countStartMs = Math.round(r.timings.countUp.start * 1e3);
    const countEndMs = Math.round(r.timings.countUp.end * 1e3);
    const steps = r.timings.countUp.steps;
    const finalValue = r.parsed.numericFloor;
    const stepDurMs = Math.max(20, Math.round((countEndMs - countStartMs) / steps));
    const numX = cx - Math.round(pillW * 0.08);
    const numY = cy;
    for (let i = 0; i < steps; i++) {
      const eOut = 1 - Math.pow(1 - (i + 1) / steps, 3);
      const value = Math.round(eOut * finalValue);
      const evStart = formatAssTime(t0 + (countStartMs + i * stepDurMs) / 1e3);
      const evEnd = formatAssTime(t0 + (countStartMs + (i + 1) * stepDurMs) / 1e3);
      events.push(
        `Dialogue: 1,${evStart},${evEnd},SP_Num,,0,0,0,,{\\an5\\pos(${numX},${numY})}${escapeAssText(String(value))}`
      );
    }
    let finalText = r.parsed.hasDecimal ? `${r.parsed.numeric}.${r.parsed.decimalStr}` : r.parsed.numeric ?? "";
    if (r.parsed.prefix) finalText = r.parsed.prefix + finalText;
    const numFinalStart = formatAssTime(t0 + countEndMs / 1e3);
    const numFinalEnd = formatAssTime(tEnd);
    events.push(
      `Dialogue: 1,${numFinalStart},${numFinalEnd},SP_Num,,0,0,0,,{\\an5\\pos(${numX},${numY})\\fad(0,${finalFadeMs})}${escapeAssText(finalText)}`
    );
    if (r.parsed.suffix) {
      const suffixX = numX + Math.round(numberFontSize * 0.45);
      const suffixY = numY;
      const suffixStart = formatAssTime(t0 + r.timings.suffixIn.start);
      const suffixEnd = formatAssTime(tEnd);
      const suffixPopMs = Math.round((r.timings.suffixIn.end - r.timings.suffixIn.start) * 1e3);
      events.push(
        `Dialogue: 1,${suffixStart},${suffixEnd},SP_Suffix,,0,0,0,,{\\an4\\pos(${suffixX},${suffixY})\\fad(120,${finalFadeMs})\\fscx40\\fscy40\\t(0,${suffixPopMs},1.5,\\fscx118\\fscy118)\\t(${suffixPopMs},${suffixPopMs + 80},0.8,\\fscx100\\fscy100)}${escapeAssText(r.parsed.suffix)}`
      );
    }
    if (r.parsed.iconType !== "none") {
      const iconPath = buildIconPath(r.parsed.iconType, iconSize);
      if (iconPath) {
        const iconStart = formatAssTime(t0 + r.timings.iconIn.start);
        const iconEnd = formatAssTime(tEnd);
        const iconInMs = Math.round((r.timings.iconIn.end - r.timings.iconIn.start) * 1e3);
        events.push(
          `Dialogue: 2,${iconStart},${iconEnd},SP_Icon,,0,0,0,,{\\pos(${iconX},${cy})\\fad(120,${finalFadeMs})\\frz-180\\fscx30\\fscy30\\t(0,${iconInMs},1.4,\\frz0\\fscx105\\fscy105)\\t(${iconInMs},${iconInMs + 80},0.8,\\fscx100\\fscy100)\\bord2\\shad2\\1c${whiteAss}\\3c${darkAss}\\p1}${iconPath}{\\p0}`
        );
      }
    }
    const underlinePath = `m ${-Math.round(underlineFullW / 2)} ${-Math.round(underlineH / 2)} l ${Math.round(underlineFullW / 2)} ${-Math.round(underlineH / 2)} l ${Math.round(underlineFullW / 2)} ${Math.round(underlineH / 2)} l ${-Math.round(underlineFullW / 2)} ${Math.round(underlineH / 2)}`;
    const underlineStart = formatAssTime(t0 + r.timings.underlineIn.start);
    const underlineEnd = formatAssTime(tEnd);
    const underlineInMs = Math.round((r.timings.underlineIn.end - r.timings.underlineIn.start) * 1e3);
    events.push(
      `Dialogue: 1,${underlineStart},${underlineEnd},SP_Underline,,0,0,0,,{\\pos(${cx},${underlineY})\\fad(0,${finalFadeMs})\\fscx0\\t(0,${underlineInMs},1,\\fscx100)\\1c${whiteAss}\\bord0\\shad0\\p1}${underlinePath}{\\p0}`
    );
    const PARTICLE_COUNT = 8;
    const particleRadius = Math.round(pillH * 1.3);
    const particleSize = Math.round(numberFontSize * 0.05);
    const particlePath = `m ${-particleSize} ${-particleSize} l ${particleSize} ${-particleSize} l ${particleSize} ${particleSize} l ${-particleSize} ${particleSize}`;
    const particleStart = formatAssTime(t0 + r.timings.burst.start);
    const particleEnd = formatAssTime(t0 + r.timings.burst.end);
    const particleDurMs = Math.round((r.timings.burst.end - r.timings.burst.start) * 1e3);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const theta = i / PARTICLE_COUNT * 2 * Math.PI;
      const dx = Math.round(Math.cos(theta) * particleRadius);
      const dy = Math.round(Math.sin(theta) * particleRadius);
      events.push(
        `Dialogue: 3,${particleStart},${particleEnd},SP_Particle,,0,0,0,,{\\move(${cx},${cy},${cx + dx},${cy + dy},0,${particleDurMs})\\fad(60,${particleDurMs - 60})\\fscx100\\fscy100\\t(0,${particleDurMs},1,\\fscx40\\fscy40)\\1c${whiteAss}\\bord0\\shad0\\p1}${particlePath}{\\p0}`
      );
    }
  }
  await fs.writeFile(outputPath, header + events.join("\n") + "\n", "utf8");
  return true;
}

// ../../../../../tmp/_test_statpopin.ts
import { promises as fs2 } from "node:fs";
var pass = 0;
var fail = 0;
var failures = [];
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`FAIL: ${name}
  expected ${e}
  actual   ${a}`);
  }
}
function approx(actual, expected, eps, name) {
  if (Math.abs(actual - expected) <= eps) {
    pass++;
  } else {
    fail++;
    failures.push(`FAIL: ${name}
  expected \u2248 ${expected} (\xB1${eps})
  actual ${actual}`);
  }
}
function truthy(actual, name) {
  if (actual) pass++;
  else {
    fail++;
    failures.push(`FAIL: ${name}
  expected truthy, got ${String(actual)}`);
  }
}
{
  const r = parseStatEmphasis("70%");
  eq(r.numeric, "70", "parseStatEmphasis: 70% numeric");
  eq(r.suffix, "%", "parseStatEmphasis: 70% suffix");
  eq(r.iconType, "arrow-up", "parseStatEmphasis: 70% icon");
  eq(r.numericFloor, 70, "parseStatEmphasis: 70% floor");
}
{
  const r = parseStatEmphasis("$2.5M");
  eq(r.numeric, "2", "parseStatEmphasis: $2.5M numeric");
  eq(r.decimalStr, "5", "parseStatEmphasis: $2.5M decimal");
  eq(r.hasDecimal, true, "parseStatEmphasis: $2.5M hasDecimal");
  eq(r.suffix, "M", "parseStatEmphasis: $2.5M suffix");
  eq(r.prefix, "$", "parseStatEmphasis: $2.5M prefix");
  eq(r.iconType, "dollar", "parseStatEmphasis: $2.5M icon");
}
{
  const r = parseStatEmphasis("10x");
  eq(r.numeric, "10", "parseStatEmphasis: 10x numeric");
  eq(r.suffix, "x", "parseStatEmphasis: 10x suffix");
  eq(r.iconType, "sparkle", "parseStatEmphasis: 10x icon");
}
{
  const r = parseStatEmphasis("50,000");
  eq(r.numeric, "50,000", "parseStatEmphasis: 50,000 numeric");
  eq(r.iconType, "arrow-up", "parseStatEmphasis: 50,000 icon");
  eq(r.numericFloor, 5e4, "parseStatEmphasis: 50,000 floor");
}
{
  const r = parseStatEmphasis("5 million");
  eq(r.numeric, "5", "parseStatEmphasis: 5 million numeric");
  eq(r.suffix, "M", "parseStatEmphasis: 5 million suffix");
  eq(r.iconType, "arrow-up", "parseStatEmphasis: 5 million icon");
}
{
  const r = parseStatEmphasis("9.5%");
  eq(r.numeric, "9", "parseStatEmphasis: 9.5% numeric");
  eq(r.decimalStr, "5", "parseStatEmphasis: 9.5% decimal");
  eq(r.suffix, "%", "parseStatEmphasis: 9.5% suffix");
}
{
  const r = parseStatEmphasis("$1.2B");
  eq(r.suffix, "B", "parseStatEmphasis: $1.2B suffix");
  eq(r.prefix, "$", "parseStatEmphasis: $1.2B prefix");
  eq(r.iconType, "dollar", "parseStatEmphasis: $1.2B icon");
}
{
  const r = parseStatEmphasis("");
  eq(r.numeric, null, "parseStatEmphasis: empty \u2192 null");
}
{
  const r = parseStatEmphasis(null);
  eq(r.numeric, null, "parseStatEmphasis: null \u2192 null");
}
{
  const r = parseStatEmphasis(void 0);
  eq(r.numeric, null, "parseStatEmphasis: undefined \u2192 null");
}
{
  const r = parseStatEmphasis("hello world");
  eq(r.numeric, null, "parseStatEmphasis: non-numeric \u2192 null");
}
{
  const r = parseStatEmphasis("3.5x");
  eq(r.numeric, "3", "parseStatEmphasis: 3.5x numeric");
  eq(r.decimalStr, "5", "parseStatEmphasis: 3.5x decimal");
  eq(r.suffix, "x", "parseStatEmphasis: 3.5x suffix");
}
{
  const seg = { startSec: 2, endSec: 3.5, mode: "stat-popin", concept: null, emphasisText: "70%" };
  const t = computeStatPopinTimings(seg);
  eq(t.startSec, 2, "timings: startSec");
  truthy(t.endSec >= 4.85, "timings: endSec >= 4.85 (hold + fade)");
  eq(t.pillIn, { start: 0, end: 0.18 }, "timings: pillIn window");
  approx(t.countUp.end - t.countUp.start, 0.38, 1e-3, "timings: countUp duration");
  truthy(t.countUp.steps >= 8 && t.countUp.steps <= 14, "timings: countUp steps in range");
  truthy(t.fadeOut.end > t.fadeOut.start, "timings: fadeOut order");
  approx(t.fadeOut.end - t.fadeOut.start, 0.35, 1e-3, "timings: fadeOut duration");
}
{
  const seg = { startSec: 0, endSec: 0.5, mode: "stat-popin", concept: null, emphasisText: "5" };
  const t = computeStatPopinTimings(seg);
  truthy(t.endSec - t.startSec >= 2.1, "timings: short segment still has min hold + fade");
}
{
  const segs = [
    { startSec: 2, endSec: 3, mode: "stat-popin", concept: null, emphasisText: "70%" },
    { startSec: 5, endSec: 7, mode: "broll-pip", concept: "city", emphasisText: null },
    { startSec: 9, endSec: 10, mode: "stat-popin", concept: null, emphasisText: "10x" }
  ];
  const windows = buildStatPopinLockoutWindows(segs);
  eq(windows.length, 2, "lockout: count");
  eq(windows[0], [1.5, 3.5], "lockout: padded window 1");
  eq(windows[1], [8.5, 10.5], "lockout: padded window 2");
}
{
  const segs = [{ startSec: 0.2, endSec: 1, mode: "stat-popin", concept: null, emphasisText: "5" }];
  const windows = buildStatPopinLockoutWindows(segs);
  eq(windows[0][0], 0, "lockout: clamps to 0");
}
{
  eq(buildStatPopinLockoutWindows([]), [], "lockout: empty");
}
var tmpAss = "/tmp/_statpopin_test.ass";
{
  const segs = [
    { startSec: 2, endSec: 3.5, mode: "stat-popin", concept: null, emphasisText: "70%" }
  ];
  const wrote = await generateStatPopinAss({
    segments: segs,
    outputPath: tmpAss,
    w: 1920,
    h: 1080,
    accentColor: "#FF6B35"
  });
  eq(wrote, true, "generateStatPopinAss: wrote=true");
  const content = await fs2.readFile(tmpAss, "utf8");
  truthy(content.includes("[Script Info]"), "ass: has Script Info");
  truthy(content.includes("[V4+ Styles]"), "ass: has V4+ Styles");
  truthy(content.includes("[Events]"), "ass: has Events");
  truthy(content.includes("Style: SP_Pill"), "ass: has Pill style");
  truthy(content.includes("Style: SP_Num"), "ass: has Num style");
  truthy(content.includes("Style: SP_Suffix"), "ass: has Suffix style");
  truthy(content.includes("Style: SP_Icon"), "ass: has Icon style");
  truthy(content.includes("Style: SP_Underline"), "ass: has Underline style");
  truthy(content.includes("Style: SP_Particle"), "ass: has Particle style");
  truthy(content.includes("BorderStyle"), "ass: BorderStyle field present in format");
  const styleLines = content.split("\n").filter((l) => l.startsWith("Style: SP_"));
  for (const sl of styleLines) {
    const fields = sl.replace(/^Style: /, "").split(",");
    eq(fields[15], "1", `ass: ${fields[0]} BorderStyle=1`);
  }
  const overrideBlocks = content.match(/\{[^}]+\}/g) ?? [];
  truthy(overrideBlocks.length > 0, "ass: at least one override block");
  for (const b of overrideBlocks) {
    if (b.includes("\\,")) {
      fail++;
      failures.push(`FAIL: escaped comma found in override block: ${b}`);
    }
  }
  pass++;
  const numLines = content.split("\n").filter((l) => l.includes(",SP_Num,"));
  truthy(numLines.length >= 9, `ass: SP_Num dialogue count >= 9, got ${numLines.length}`);
  const partLines = content.split("\n").filter((l) => l.includes(",SP_Particle,"));
  eq(partLines.length, 8, "ass: 8 particle dialogues");
  truthy(content.includes(",,{\\an5\\pos") && content.includes("}70"), "ass: final value '70' present");
}
{
  const segs = [
    { startSec: 2, endSec: 3, mode: "stat-popin", concept: null, emphasisText: "70%" },
    { startSec: 6, endSec: 7, mode: "stat-popin", concept: null, emphasisText: "$2.5M" },
    { startSec: 9, endSec: 10, mode: "broll-pip", concept: "city", emphasisText: null }
  ];
  const wrote = await generateStatPopinAss({
    segments: segs,
    outputPath: tmpAss,
    w: 1920,
    h: 1080,
    accentColor: "#FF6B35"
  });
  eq(wrote, true, "ass multi: wrote=true");
  const content = await fs2.readFile(tmpAss, "utf8");
  const partLines = content.split("\n").filter((l) => l.includes(",SP_Particle,"));
  eq(partLines.length, 16, "ass multi: 16 particle dialogues across 2 stats");
  truthy(!content.includes("city"), "ass multi: broll-pip not rendered");
  truthy(content.includes("$2"), "ass multi: $2.5M dollar prefix rendered");
}
{
  const wrote = await generateStatPopinAss({
    segments: [{ startSec: 0, endSec: 1, mode: "broll-pip", concept: "x", emphasisText: null }],
    outputPath: "/tmp/_should_not_exist.ass",
    w: 1920,
    h: 1080,
    accentColor: "#FF6B35"
  });
  eq(wrote, false, "ass: empty plan returns false");
}
{
  const wrote = await generateStatPopinAss({
    segments: [{ startSec: 0, endSec: 1, mode: "stat-popin", concept: null, emphasisText: "no number here" }],
    outputPath: "/tmp/_should_not_exist2.ass",
    w: 1920,
    h: 1080,
    accentColor: "#FF6B35"
  });
  eq(wrote, false, "ass: unparseable stat \u2192 false");
}
console.log(`
${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.log(f);
  process.exit(1);
}
