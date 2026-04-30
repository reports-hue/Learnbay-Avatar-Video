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
- `src/lib/config.ts` — `PLATFORMS`, `SCRIPT_STYLES`, `AVATARS`, `QUICK_VOICES`, `VOICE_STYLES`, `CAPTION_STYLES`, `SCENE_PRESETS`

### Features

| Feature | Details |
|---|---|
| **AI Script Generation** | Azure OpenAI (gpt-4o-mini), 5 styles: Viral Hook, Listicle, Story, Educational, Sales. Natural spoken-language prompts forbid bullet lists, require contractions and filler transitions. |
| **Realism Mode** (default ON) | Green screen chroma key compositing, color grade (`eq`), film grain (`noise`), Ken Burns bg zoom, broadcast audio (loudnorm + echo), opening hook text overlay |
| **Avatar Synthesis** | Azure AI Avatar Batch Synthesis API (PUT + poll). Always uses SSML with prosody rate/pitch, sentence boundary silence, breathing breaks. Green screen (`#00FF00FF`) bg for chroma key. |
| **Chroma Key Compositing** | `chromakey=color=0x00ff00:similarity=0.25:blend=0.05` — avatar edges blend naturally into scene |
| **Voice Pacing** | 3-level Pacing slider: Slow (0.88×), Natural (0.95×), Fast (1.05×). Maps to SSML `<prosody rate>`. |
| **Voice Preview** | `POST /api/preview-voice` (Azure) or `POST /api/elevenlabs/preview` (ElevenLabs) — 5s TTS sample returned as MP3 |
| **ElevenLabs Voices** | Optional: user enters their ElevenLabs API key in Voice Browser → stored in localStorage. Voices fetched from ElevenLabs API, prefixed `el:voiceId` in state. Full 643-voice Azure browser + ElevenLabs library in a tabbed modal. |
| **ElevenLabs TTS** | When `voice` starts with `el:`, `synthesizeElevenLabs()` calls `/v1/text-to-speech/{id}/with-timestamps`, saves MP3 to `outputs/`. Avatar is rendered with **Azure TTS** (SSML); the ElevenLabs MP3 is then **swapped in as the speech track during FFmpeg post-processing** (`elAudioPath` → speech source `[N:a]`). Lip-sync follows Azure mouth movements, but the listener hears the ElevenLabs voice. ElevenLabs character-alignment → `WordTiming[]` for captions. |
| **Word-by-Word Captions** | SSML-based word timings with micro-rate variation per sentence, `express-as style="chat"`. 3–5 word sliding window. ASS `BorderStyle=1` (outline + shadow only — **never `BorderStyle=3`**, which adds an opaque box that crops the avatar). |
| **Opening Hook Text** | First sentence displayed 0–2s with fade-out via ASS subtitles at top of frame (no drawtext needed) |
| **Audio Enhancement** | Source-aware: ElevenLabs (studio audio) → lighter `loudnorm=I=-14:TP=-1.0:LRA=9` only, no aecho (preserves studio mastering). Azure TTS (dry) → `loudnorm=I=-16:TP=-1.5:LRA=11` + `aecho=0.8:0.9:40:0.3` for room presence. Music at 6% with afade in/out. Output: 48 kHz / 192 kbps AAC. |
| **Lip-Sync Time-Stretch** | When ElevenLabs audio is used, ffprobe both Azure avatar video and ElevenLabs MP3, then apply `setpts=PTS*ratio` to the avatar video so its duration matches the ElevenLabs track. Ratio clamped 0.7–1.4. Greatly tightens overall sync; per-word drift between the two TTS engines remains. |
| **Premium Encoding** | Azure avatar source: **4000 kbps H.264 — do NOT change**. Azure batch synthesis rejects 6000 and 8000 kbps with `Video bitrate Xk is not allowed`; 4000 is the only confirmed-working value. Final output (post-process): libx264 `preset fast / crf 18 / profile high / level 4.1`, 2-second GOP (`-g 60 -keyint_min 60`), AAC 192 kbps @ 48 kHz, `+faststart`. **Do NOT bump preset above `fast`** — `medium` made renders take 3–5× longer (felt broken). CRF=18 is the dominant quality lever; preset mostly controls file size. |
| **Color Grade** | `eq=brightness=0.02:saturation=1.1:contrast=1.05` — makes it look camera-shot |
| **Film Grain** | `noise=alls=4:allf=t+u` — organic texture, removes digital-sterile appearance |
| **Ken Burns Effect** | Background scaled 3% up, slow crop pan: `crop=W:H:x='min(iw-ow,(iw-ow)*t/DUR)':y='(ih-oh)/2'` |
| **Thumbnail Generation** | FFmpeg extracts frame at t=2s → `thumb_{videoId}.jpg`. Shown in result card and Library grid. |
| **AI Backgrounds** | Azure OpenAI gpt-image-1 (`output_format: "jpeg"` — **never PNG**, Azure rejects it; **never** add `output_compression`, also rejected). Topic-aware scene hints (tech → cyber city, finance → marble desk, fitness → gym/sunrise, food → kitchen, travel → destination, lifestyle → minimal apartment, education → cosy library). Prompt anchors: ultra-wide, 8K photorealistic, hyper-detailed, golden hour, shallow depth of field, no people/text/logos. |
| **Video Deletion** | `DELETE /api/videos/:videoId` removes `video_<id>.mp4` and `thumb_<id>.jpg` from disk (path-traversal sanitised). Client also writes ID to `localStorage["lm.deletedVideoIds"]` tombstone list — auto-recovery skips tombstoned IDs so deleted videos stay deleted even if the server delete failed. |
| **Scene Presets** | Auto AI (GPT picks), Creator, Corporate, Tech, Lifestyle, Business, Custom, Image URL |
| **SSE Progress Streaming** | Real-time `event: progress` stream over POST /api/generate |
| **Platform Support** | Vertical 9:16 (Shorts/Reels, 1080×1920) + Horizontal 16:9 (1920×1080) |

### Service Files (api-server)

- `src/services/openai.ts` — Natural human-speech script prompts, `generateScript()`, `generateBrandTheme()`, `analyzeBrand()`
- `src/services/speech.ts` — SSML-based `getWordTimings()` with `speakSsmlAsync`, micro-rate variation, emphasis for CAPS, chat style, estimation fallback
- `src/services/avatarService.ts` — `generateAvatarVideo()`: always SSML/Azure TTS. (Azure removed `PreSynthesizedAudio` from the avatar batch synthesis API in 2025; ElevenLabs audio is swapped in during ffmpeg post-processing instead.) Green screen in realism mode.
- `src/services/elevenLabsService.ts` — `listElevenLabsVoices()`, `synthesizeElevenLabs()` (with-timestamps → saves MP3 + word timings), `previewElevenLabsVoice()`
- `src/services/ffmpegService.ts` — Full post-processing: chroma key, Ken Burns, color grade, grain, hook text, 3-word captions, audio loudnorm, thumbnail extraction
- `src/routes/voices.ts` — `GET /api/voices` (Azure, 1hr cache), `GET /api/elevenlabs/voices` (ElevenLabs, x-elevenlabs-key header), `POST /api/elevenlabs/preview`, `POST /api/upload-photo`
- `src/routes/generate.ts` — `POST /api/generate` (SSE), `GET /api/video/:filename`, `POST /api/preview-voice`

### FFmpeg Filter Graph (order, Realism Mode)

1. Background source, oversized 3% (`gradients` or `color`)
2. Ken Burns crop pan on background
3. Chroma key avatar compositing (`chromakey` → `scale` → `overlay`)
4. Color grade (`eq`) + sharpen (`unsharp`) + vignette
5. Lower-third dark overlay (2-layer `drawbox`)
6. Brand accent line (`drawbox`)
7. Logo overlay (top-right)
8. Opening hook text (0–2s ASS subtitle)
9. 3-word animated captions (`subtitles`)
10. CTA text (`subtitles`)
11. Film grain (`noise`)
12. Fade in/out
13. FPS normalize to 30fps

### Available FFmpeg Filters (confirmed in ffmpeg-static 5.3.0)

`gradients`, `chromakey`, `drawbox` (alpha), `subtitles` (libass), `vignette`, `unsharp`, `fade`, `overlay`, `scale`, `pad`, `fps`, `eq`, `noise`, `loudnorm`, `aecho`, `zoompan`, `crop`, `color`

**NOT available**: `drawtext` (no libfreetype)

### Azure Avatar API

- Endpoint: `https://{AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/avatar/batchsyntheses/{jobId}?api-version=2024-04-15-preview`
- Method: PUT to create, GET to poll
- Body is **flat** (no `payload` wrapper).
- `inputKind: "SSML"` is the only mode used. Azure removed `PreSynthesizedAudio` support from the avatar batch synthesis API in 2025 (returns `400 BadRequest: $.inputKind invalid + payload required`). To use ElevenLabs voices, generate the avatar with Azure TTS here, then swap the audio track in `ffmpegService.ts` via `elAudioPath`.
- Green screen background `#00FF00FF` when `realism=true` (default)
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
