import { Router, type IRouter, type Request, type Response } from "express";
import axios from "axios";
import { analyzeBrand } from "../services/openai.js";

const router: IRouter = Router();

router.post("/analyze-brand", async (req: Request, res: Response) => {
  const { websiteUrl } = req.body as { websiteUrl?: string };
  if (!websiteUrl) {
    res.status(400).json({ error: "websiteUrl is required" });
    return;
  }

  try {
    const html = await fetchWebsite(websiteUrl);
    const metaInfo = extractMeta(html, websiteUrl);
    const result = await analyzeBrand(html, websiteUrl, metaInfo);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Brand analysis failed: ${message}` });
  }
});

async function fetchWebsite(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    timeout: 12000,
    headers: {
      "User-Agent": "LearnbayVideoGenerator/1.0",
      "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    maxRedirects: 5,
    responseType: "text",
  });
  return response.data;
}

function extractMeta(html: string, siteUrl: string): Record<string, string> {
  const info: Record<string, string> = {};

  // Title
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM?.[1]) info["title"] = titleM[1].replace(/\s+/g, " ").trim().slice(0, 200);

  // Meta name / property tags
  for (const m of html.matchAll(/<meta\s+([^>]+)>/gi)) {
    const attrs = m[1];
    const nameM = attrs.match(/(?:name|property)=["']([^"']+)["']/i);
    const contentM = attrs.match(/content=["']([^"']*?)["']/i);
    if (nameM?.[1] && contentM?.[1]) {
      info[nameM[1].toLowerCase()] = contentM[1].slice(0, 300);
    }
  }

  // og:image → likely logo
  const ogImage = info["og:image"];
  if (ogImage) info["detected_logo_url"] = ogImage;

  // Try to find favicon as logo fallback
  const faviconM = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
  if (faviconM?.[1] && !info["detected_logo_url"]) {
    const href = faviconM[1];
    if (href.startsWith("http")) info["detected_logo_url"] = href;
    else {
      try {
        const base = new URL(siteUrl);
        info["detected_logo_url"] = new URL(href, base).toString();
      } catch { /* ignore */ }
    }
  }

  return info;
}

export default router;
