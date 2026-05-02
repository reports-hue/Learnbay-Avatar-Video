/**
 * logoService — reliable logo asset preparation for the rendering pipeline.
 *
 * Handles two paths:
 *   1) `prepareLogoFromUrl(url, destDir)` — downloads from a remote URL with
 *      browser User-Agent + timeout + redirect handling + content-type
 *      validation, then converts SVG → PNG if needed.
 *   2) `prepareLogoFromBuffer(buf, destDir)` — same conversion path for an
 *      already-uploaded buffer (used by the upload endpoint).
 *
 * Also exports `probeImageDims(path)` so callers (the corner-pill chain) can
 * pick aspect-aware padding without a second async hop.
 *
 * Why a separate service?
 *   - The previous inline downloader in `ffmpegService.ts` had no User-Agent,
 *     no timeout, no redirect cap, no content-type check, no size cap, and
 *     no SVG support. Many CDNs (Wikipedia thumb hosts, brand asset sites)
 *     reject the default axios UA and return 403, or return SVG which ffmpeg
 *     cannot decode → silent fallback to the bundled logo or render failure.
 *   - SVG → PNG is done with system ImageMagick (`magick`), which is already
 *     available in the Replit Nix env (verified by the resolver probe at
 *     boot). We rasterize at high density (300dpi) so wordmark text remains
 *     crisp when scaled into the corner chip.
 */
import axios from "axios";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger.js";

const execFileP = promisify(execFile);

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5MB
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface LogoAsset {
  /** Absolute filesystem path to a decoded raster PNG/JPEG. */
  path: string;
  /** Pixel width of the rasterized asset. */
  width: number;
  /** Pixel height of the rasterized asset. */
  height: number;
  /** Source format: "png" | "jpeg" | "gif" | "webp" | "bmp" | "svg". */
  sourceFormat: string;
}

function detectFormat(buf: Buffer, contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("svg") || (buf.length > 0 && buf.slice(0, 512).toString("utf8").includes("<svg"))) {
    return "svg";
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  if (ct.startsWith("image/")) return ct.replace("image/", "").split(";")[0]?.trim() ?? "unknown";
  return "unknown";
}

async function rasterizeSvg(svgBuf: Buffer, destDir: string): Promise<string> {
  const svgPath = path.join(destDir, `logo_src_${Date.now()}.svg`);
  const pngPath = path.join(destDir, `logo_dl.png`);
  await fs.writeFile(svgPath, svgBuf);
  try {
    // -density 300 → high-DPI rasterization; -resize 1200x1200> caps the
    // long edge at 1200px so we don't render absurdly large bitmaps for
    // huge SVG viewBoxes. -background none preserves transparency.
    await execFileP("magick", [
      "-background", "none",
      "-density", "300",
      svgPath,
      "-resize", "1200x1200>",
      "-strip",
      pngPath,
    ], { timeout: 20_000 });
  } finally {
    await fs.unlink(svgPath).catch(() => {});
  }
  return pngPath;
}

/**
 * Probe image dimensions using ffprobe. Returns {0,0} on any failure so
 * callers can fall back to safe defaults rather than crashing.
 */
export async function probeImageDims(filePath: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0:s=x",
        filePath,
      ],
      { timeout: 10_000 },
    );
    const trimmed = stdout.trim();
    const parts = trimmed.split("x");
    const w = parseInt(parts[0] ?? "0", 10);
    const h = parseInt(parts[1] ?? "0", 10);
    return { width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Persist a binary buffer (PNG/JPEG/etc.) at `dest` and return it. SVG is
 * rasterized first; everything else is written verbatim.
 */
export async function prepareLogoFromBuffer(
  buf: Buffer,
  destDir: string,
  hintedContentType = "",
): Promise<LogoAsset> {
  const fmt = detectFormat(buf, hintedContentType);
  let pngPath: string;
  if (fmt === "svg") {
    pngPath = await rasterizeSvg(buf, destDir);
  } else if (fmt === "png" || fmt === "jpeg" || fmt === "gif" || fmt === "webp" || fmt === "bmp") {
    // Per-call unique filename — never `logo_dl.png` — so two concurrent
    // logo preparations cannot overwrite each other (silent wrong-brand bug).
    pngPath = path.join(destDir, `logo_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
    await fs.writeFile(pngPath, buf);
  } else {
    throw new Error(`Unsupported logo format: ${fmt}`);
  }
  const dims = await probeImageDims(pngPath);
  if (dims.width === 0 || dims.height === 0) {
    throw new Error("Could not probe logo dimensions after preparation");
  }
  return { path: pngPath, width: dims.width, height: dims.height, sourceFormat: fmt };
}

/**
 * Download a logo from a URL and prepare it for the render pipeline.
 *
 * Throws on: bad status, non-image content-type AND non-image magic bytes,
 * size > 5MB, network timeout, or unsupported format.
 */
export async function prepareLogoFromUrl(url: string, destDir: string): Promise<LogoAsset> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Logo URL must start with http:// or https://");
  }
  const resp = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: MAX_LOGO_BYTES,
    maxBodyLength: MAX_LOGO_BYTES,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/png,image/jpeg,image/svg+xml,image/webp,image/*;q=0.8",
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const buf = Buffer.from(resp.data);
  const ct = String(resp.headers["content-type"] ?? "");
  const fmt = detectFormat(buf, ct);
  if (fmt === "unknown") {
    throw new Error(
      `Logo URL did not return image data (content-type: ${ct || "unknown"}, ${buf.length} bytes)`,
    );
  }
  logger.debug({ url, fmt, bytes: buf.length, contentType: ct }, "Logo download succeeded");
  return prepareLogoFromBuffer(buf, destDir, ct);
}
