import fs from "fs/promises";
import { logger } from "../lib/logger.js";

export interface OutroState {
  active: boolean;
  startSec: number;
  fadeDur: number;
  headline: string;
  url: string | null;
}

export interface OutroCardOptions {
  startSec: number;
  durationSec: number;
  outW: number;
  outH: number;
  accentColor: string;
  headline: string;
  url: string | null;
  outputPath: string;
}

const URL_REGEX =
  /\b((?:https?:\/\/|www\.)[^\s]+|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|io|co|app|ai|net|org|dev|me|tv|xyz|so|gg|sh)(?:\/[^\s]*)?)/i;

function toAssColor(hex: string): string {
  const clean = hex.replace(/^#/, "").slice(0, 6).padEnd(6, "0");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function formatAssTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const cs = Math.floor((totalSec % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

export function parseCtaText(cta: string): { headline: string; url: string | null } {
  const trimmed = cta.trim();
  if (!trimmed) return { headline: "", url: null };

  const m = trimmed.match(URL_REGEX);
  if (!m) return { headline: trimmed, url: null };

  const url = m[0];
  const before = trimmed.slice(0, m.index ?? 0).trim();
  const after = trimmed.slice((m.index ?? 0) + url.length).trim();
  const headline = (before + " " + after).trim().replace(/[\s|·,;:-]+$/g, "").trim();

  return {
    headline: headline || trimmed.replace(url, "").trim() || "Visit us",
    url,
  };
}

export function computeOutroState(durationSec: number, cta?: string): OutroState {
  const trimmed = (cta ?? "").trim();
  if (!trimmed) {
    return { active: false, startSec: 0, fadeDur: 0, headline: "", url: null };
  }

  const TARGET_OUTRO_DUR = 2.5;
  const MIN_VIDEO_DUR = 6.0;
  const MAX_OUTRO_FRACTION = 0.4;

  if (durationSec < MIN_VIDEO_DUR) {
    return { active: false, startSec: 0, fadeDur: 0, headline: "", url: null };
  }

  const earliestAllowedStart = durationSec * (1 - MAX_OUTRO_FRACTION);
  const desiredStart = durationSec - TARGET_OUTRO_DUR;
  const startSec = Math.max(desiredStart, earliestAllowedStart);

  const { headline, url } = parseCtaText(trimmed);

  return {
    active: true,
    startSec,
    fadeDur: 0.6,
    headline,
    url,
  };
}

export async function generateOutroCardAss(opts: OutroCardOptions): Promise<void> {
  const { startSec, durationSec, outW, outH, accentColor, headline, url, outputPath } = opts;

  const isVertical = outH > outW;

  const cardW = isVertical ? Math.round(outW * 0.85) : Math.round(outW * 0.65);
  const cardH = isVertical ? Math.round(outH * 0.32) : Math.round(outH * 0.36);
  const cardX = Math.round((outW - cardW) / 2);
  const cardY = Math.round((outH - cardH) / 2);

  const headFontSize = isVertical ? 78 : 72;
  const urlFontSize = isVertical ? 44 : 42;
  const cx = Math.round(outW / 2);
  const headBaseY = url ? cardY + Math.round(cardH * 0.42) : cardY + Math.round(cardH * 0.5);
  const urlBaseY = cardY + Math.round(cardH * 0.68);

  const startTime = formatAssTime(startSec);
  const endTime = formatAssTime(durationSec);

  const accentAss = toAssColor(accentColor);
  const accentDarkAss = toAssColor(darkenHex(accentColor, 0.55));
  const whiteAss = "&H00FFFFFF";
  const shadowDarkAss = "&H00101820";

  const bgFadeIn = 350;
  const bgFadeOut = 200;
  const headFadeIn = 450;
  const headFadeOut = 200;
  const urlFadeIn = 550;
  const urlFadeOut = 200;
  const slidePx = 28;

  const escHeadline = escapeAssText(headline);
  const escUrl = url ? escapeAssText(url) : "";

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${outW}
PlayResY: ${outH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: OutroBg,Arial,1,${accentAss},${whiteAss},${accentDarkAss},${shadowDarkAss},0,0,0,0,100,100,0,0,1,3,8,7,0,0,0,1
Style: OutroHead,Arial,${headFontSize},${whiteAss},${whiteAss},${shadowDarkAss},${shadowDarkAss},-1,0,0,0,100,100,1,0,1,3,4,5,0,0,0,1
Style: OutroUrl,Arial,${urlFontSize},${whiteAss},${whiteAss},${shadowDarkAss},${shadowDarkAss},0,0,0,0,100,100,2,0,1,2,3,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${startTime},${endTime},OutroBg,,0,0,0,,{\\an7\\pos(${cardX},${cardY})\\fad(${bgFadeIn},${bgFadeOut})\\p1}m 0 0 l ${cardW} 0 ${cardW} ${cardH} 0 ${cardH}{\\p0}
Dialogue: 1,${startTime},${endTime},OutroHead,,0,0,0,,{\\an5\\move(${cx},${headBaseY + slidePx},${cx},${headBaseY},0,500)\\fad(${headFadeIn},${headFadeOut})}${escHeadline}
${
  url
    ? `Dialogue: 1,${startTime},${endTime},OutroUrl,,0,0,0,,{\\an5\\move(${cx},${urlBaseY + slidePx},${cx},${urlBaseY},100,600)\\fad(${urlFadeIn},${urlFadeOut})}${escUrl}\n`
    : ""
}`;

  await fs.writeFile(outputPath, content, "utf8");
  logger.info(
    {
      startSec,
      durationSec,
      cardW,
      cardH,
      headline: headline.slice(0, 40),
      hasUrl: !!url,
    },
    "Generated outro card ASS",
  );
}

function darkenHex(hex: string, factor: number): string {
  const clean = hex.replace(/^#/, "").slice(0, 6).padEnd(6, "0");
  const r = Math.round(parseInt(clean.slice(0, 2), 16) * (1 - factor));
  const g = Math.round(parseInt(clean.slice(2, 4), 16) * (1 - factor));
  const b = Math.round(parseInt(clean.slice(4, 6), 16) * (1 - factor));
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
