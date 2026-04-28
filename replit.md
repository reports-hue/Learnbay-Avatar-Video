# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Build**: esbuild (bundle into dist/index.mjs)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-server run dev` — run API server locally

---

## Libraryminds Personal Video Generator

A no-auth, avatar video generation tool powered by Azure AI — similar to HeyGen.

### Architecture

```
artifacts/
  api-server/      Express 5 API (port 8080 → 80)
  video-generator/ React + Vite frontend (port 24396 → proxied via api-server)
```

### Frontend Pages (video-generator)

- `src/App.tsx` — SaaS layout shell: shadcn Sidebar (collapsible icon/full), top breadcrumb bar, route switching
- `src/pages/Dashboard.tsx` — Stats (total videos, this week, brand status), brand setup CTA, quick create card, recent 4 videos grid
- `src/pages/CreateVideo.tsx` — 4-step form: Content→Brand→Avatar→Generate with SSE progress, live script preview, color phase pills, result video player + download
- `src/pages/VideoLibrary.tsx` — Searchable video card grid, inline video preview, download, confirm-delete
- `src/pages/BrandSettings.tsx` — AI website analyzer (POST /api/analyze-brand), company identity, visual identity (logo, 3 colors, color strip preview), default video settings
- `src/lib/storage.ts` — `useBrandProfile`, `useVideoLibrary` hooks (localStorage-backed)
- `src/lib/types.ts` — `BrandProfile`, `VideoEntry`, `BrandAnalysisResult`, `Page`
- `src/lib/config.ts` — `PLATFORMS`, `SCRIPT_STYLES`, `AVATARS`, `VOICES`, `VOICE_STYLES`, `CAPTION_STYLES`, `SCENE_PRESETS`

### Features

| Feature | Details |
|---|---|
| **AI Script Generation** | Azure OpenAI (gpt-4o-mini), 5 styles: Viral Hook, Listicle, Story, Educational, Sales |
| **Avatar Synthesis** | Azure AI Avatar Batch Synthesis API (PUT + poll pattern) |
| **Voice Emotion** | SSML `express-as` styles (per-voice: chat, empathetic, cheerful, etc.) |
| **Word-by-Word Captions** | Speech SDK `wordBoundary` events → animated ASS captions |
| **Scene Presets** | Auto AI (GPT picks), Creator, Corporate, Tech, Lifestyle, Business, Custom, Image URL |
| **Gradient Backgrounds** | FFmpeg `gradients` source filter with 2-color linear gradient |
| **Cinematic Effects** | `unsharp` sharpen, `vignette`, fade-in/fade-out |
| **Lower-Third Branding** | 2-layer dark overlay + accent color bar + logo overlay |
| **CTA Text** | ASS subtitle in lower-third area |
| **SSE Progress Streaming** | Real-time `event: progress` stream over POST /api/generate |
| **Platform Support** | Vertical 9:16 (Shorts/Reels, 1080×1920) + Horizontal 16:9 (1920×1080) |

### Service Files (api-server)

- `src/services/openai.ts` — `generateScript()` (ScriptStyle enum), `generateBrandTheme()`
- `src/services/speech.ts` — `getWordTimings()` with Speech SDK word-boundary events + estimation fallback
- `src/services/avatarService.ts` — `generateAvatarVideo()` with SSML support + polling
- `src/services/ffmpegService.ts` — Full post-processing pipeline: gradient bg, avatar overlay, cinematic fx, animated captions, lower-third, CTA
- `src/routes/generate.ts` — `POST /api/generate` (SSE streaming), `GET /api/video/:filename`

### FFmpeg Filter Graph (order)

1. Gradient/flat background (`gradients` or `pad`)
2. Avatar overlay (scaled, centered)
3. Cinematic sharpen (`unsharp`) + vignette
4. Lower-third dark overlay (2-layer `drawbox`)
5. Brand accent line (`drawbox`)
6. Logo overlay (top-right)
7. Word captions (`subtitles` with animated ASS)
8. CTA text (`subtitles` with CTA ASS)
9. Fade in/out
10. FPS normalize to 30fps

### Available FFmpeg Filters (confirmed in ffmpeg-static 5.3.0)

`gradients`, `drawbox` (alpha), `subtitles` (libass), `vignette`, `unsharp`, `fade`, `gblur`, `overlay`, `scale`, `pad`, `fps`

**NOT available**: `drawtext` (no libfreetype), `zoompan`

### Azure Avatar API

- Endpoint: `https://{AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/avatar/batchsyntheses/{jobId}?api-version=2024-04-15-preview`
- Method: PUT to create, GET to poll
- `inputKind: "PlainText"` or `"SSML"` (when voice style is requested)
- Poll interval: 6s, max wait: 25min

### Environment Secrets Required

- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_DEPLOYMENT` (optional, defaults to `gpt-4o-mini`)
- `AZURE_SPEECH_KEY`
- `AZURE_SPEECH_REGION`

### Asset Directory (`artifacts/api-server/assets/`)

- `logo.png` — Libraryminds logo (shown top-right)
- `music.mp3` — optional background music (auto-mixed at 7% volume)

See the `pnpm-workspace` skill for workspace structure and TypeScript setup.
