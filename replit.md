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
| **Realism Mode** (default ON) | Green-screen mp4 avatar + chroma key compositing, color grade (`eq`), film grain (`noise`), Ken Burns bg zoom, broadcast audio (loudnorm + echo), opening hook text overlay. (Transparent WebM was tested Apr 30 2026 — Azure returns opaque white background; see Known Azure Limitations.) |
| **Avatar Synthesis** | Azure AI Avatar Batch Synthesis API (PUT + poll, api-version `2024-04-15-preview`). Always uses SSML with prosody rate/pitch, sentence boundary silence, breathing breaks. **Realism mode + no bgImageUrl** → mp4/h264 + green screen `#00FF00FF` (chroma keyed in post). **bgImageUrl set** → mp4/h264, Azure composites the background server-side. Transparent webm/vp9 path is wired but disabled (`PREFER_TRANSPARENT_WEBM = false`) — see Known Azure Limitations. |
| **Chroma Key Compositing** | `chromakey=color=0x00ff00:similarity=0.30:blend=0.10` + `despill=type=green:mix=0.5:expand=0` — avatar edges blend into scene with green spill removal. |
| **Voice Pacing** | 3-level Pacing slider: Slow (0.88×), Natural (0.95×), Fast (1.05×). Maps to SSML `<prosody rate>`. |
| **Voice Preview** | `POST /api/preview-voice` (Azure) or `POST /api/elevenlabs/preview` (ElevenLabs) — 5s TTS sample returned as MP3 |
| **ElevenLabs Voices** | Optional: user enters their ElevenLabs API key in Voice Browser → stored in localStorage. Voices fetched from ElevenLabs API, prefixed `el:voiceId` in state. Full 643-voice Azure browser + ElevenLabs library in a tabbed modal. |
| **ElevenLabs TTS** | When `voice` starts with `el:`, `synthesizeElevenLabs()` calls `/v1/text-to-speech/{id}/with-timestamps`, saves MP3 to `outputs/`. Avatar is rendered with **Azure TTS** (SSML); the ElevenLabs MP3 is then **swapped in as the speech track during FFmpeg post-processing** (`elAudioPath` → speech source `[N:a]`). Lip-sync follows Azure mouth movements, but the listener hears the ElevenLabs voice. ElevenLabs character-alignment → `WordTiming[]` for captions. |
| **Word-by-Word Captions** | Real timestamps from **Azure Speech SDK `wordBoundary` events** (ticks ÷ 10,000,000 → seconds) collected during a parallel SSML synthesis to a discardable pull-stream. **Hard rule: NEVER fall back to estimated/WPM/character-count timing — throw on empty events.** SSML uses micro-rate variation per sentence + `express-as style="chat"`. 3-word sliding window for animated captions, 3-word chunks for static. ASS `BorderStyle=1` (outline + shadow only — **never `BorderStyle=3`**, which adds an opaque box that crops the avatar). **50 ms gap** between consecutive Dialogue events to prevent run-together. ElevenLabs path uses character-alignment from `/with-timestamps` (also real, not estimated). |
| **Opening Hook Text** | First sentence displayed 0–2s with fade-out via ASS subtitles at top of frame (no drawtext needed) |
| **Audio Enhancement** | Source-aware: ElevenLabs (studio audio) → lighter `loudnorm=I=-14:TP=-1.0:LRA=9` only, no aecho (preserves studio mastering). Azure TTS (dry) → `loudnorm=I=-16:TP=-1.5:LRA=11` + `aecho=0.8:0.9:40:0.3` for room presence. Music at 6% with afade in/out. Output: 48 kHz / 192 kbps AAC. |
| **Lip-Sync Time-Stretch** | When ElevenLabs audio is used, ffprobe both Azure avatar video and ElevenLabs MP3, then apply `setpts=PTS*ratio` to the avatar video so its duration matches the ElevenLabs track. Ratio clamped 0.7–1.4. Greatly tightens overall sync; per-word drift between the two TTS engines remains. |
| **Premium Encoding** | Azure avatar source: **4000 kbps H.264 — do NOT change**. Azure batch synthesis rejects 6000 and 8000 kbps with `Video bitrate Xk is not allowed`; 4000 is the only confirmed-working value. Final output (post-process): libx264 `preset fast / crf 18 / profile high / level 4.1`, 2-second GOP (`-g 60 -keyint_min 60`), AAC 192 kbps @ 48 kHz, `+faststart`. **Do NOT bump preset above `fast`** — `medium` made renders take 3–5× longer (felt broken). CRF=18 is the dominant quality lever; preset mostly controls file size. |
| **Color Grade** | `eq=brightness=0.02:saturation=1.1:contrast=1.05` — makes it look camera-shot |
| **Film Grain** | `noise=alls=4:allf=t+u` — organic texture, removes digital-sterile appearance |
| **Ken Burns Effect** | Background scaled 3% up, slow crop pan: `crop=W:H:x='min(iw-ow,(iw-ow)*t/DUR)':y='(ih-oh)/2'` |
| **Thumbnail Generation** | FFmpeg extracts frame at t=2s → `thumb_{videoId}.jpg`. Shown in result card and Library grid. |
| **AI Backgrounds** | Azure OpenAI gpt-image-1 (`output_format: "jpeg"` — **never PNG**, Azure rejects it; **never** add `output_compression`, also rejected). Topic-aware scene hints (tech → cyber city, finance → marble desk, fitness → gym/sunrise, food → kitchen, travel → destination, lifestyle → minimal apartment, education → cosy library). Prompt anchors: ultra-wide, 8K photorealistic, hyper-detailed, golden hour, shallow depth of field, no people/text/logos. |
| **Video Deletion** | `DELETE /api/videos/:videoId` removes `video_<id>.mp4` and `thumb_<id>.jpg` from disk (path-traversal sanitised). Client also writes ID to `localStorage["lm.deletedVideoIds"]` tombstone list — the manual Recover button skips tombstoned IDs. **No auto-recovery on Library mount** — that previously caused deleted videos to silently reappear after a new generation (Library remounts → effect re-fires). Recovery is strictly opt-in via the Recover button. |
| **Scene Presets** | Auto AI (GPT picks), Creator, Corporate, Tech, Lifestyle, Business, Custom, Image URL |
| **SSE Progress Streaming** | Real-time `event: progress` stream over POST /api/generate |
| **Platform Support** | Vertical 9:16 (Shorts/Reels, 1080×1920) + Horizontal 16:9 (1920×1080) |

### Service Files (api-server)

- `src/services/openai.ts` — Natural human-speech script prompts, `generateScript()`, `generateBrandTheme()`, `analyzeBrand()`
- `src/services/speech.ts` — SSML-based `getWordTimings()` with `speakSsmlAsync`, micro-rate variation, emphasis for CAPS, chat style, estimation fallback
- `src/services/avatarService.ts` — `generateAvatarVideo()`: always SSML/Azure TTS. (Azure removed `PreSynthesizedAudio` from the avatar batch synthesis API in 2025; ElevenLabs audio is swapped in during ffmpeg post-processing instead.) `useTransparent` flag → requests transparent WebM/VP9 (saves as `avatar_raw.webm`); otherwise mp4/h264. Three modes: transparent-webm (default in realism, no bg image), green-screen-mp4 (legacy fallback), solid-bg-mp4 / Azure-composited bg image.
- `src/services/elevenLabsService.ts` — `listElevenLabsVoices()`, `synthesizeElevenLabs()` (with-timestamps → saves MP3 + word timings), `previewElevenLabsVoice()`
- `src/services/ffmpegService.ts` — Full post-processing: transparent-WebM overlay (or chroma key fallback), Ken Burns, color grade, grain, hook text, 3-word captions, audio loudnorm, thumbnail extraction. `useTransparentAvatar` takes precedence over `useGreenScreen`.
- `src/services/calloutService.ts` — Numeric pop-in callouts (T103): `findNumericCallouts()` scans wordTimings for `\d+%`, `$KMB`, comma-grouped numbers, `\d+x` multipliers, scale-words; `generateNumericCalloutsAss()` builds ASS with pop animation (60→115→100% scale), brand accent fill + black outline, BorderStyle=1. 2.5s hook lockout + 2.0s cooldown.
- `src/services/leakService.ts` — Light-leak transitions at sentence boundaries (T102): `findSentenceBoundaries()` extracts sentence-end times from wordTimings (1.8s hook lockout, 2.5s outro lockout, 1.2s minGap, max 12 events). `ensureLeakAssets()` lazily generates 3 procedural warm leak MP4s (warm horizontal, amber radial, gold vertical) to `outputs/cache/leaks/` via `gradients` + `overlay`. `buildLightLeakFilters()` produces a screen-blend filter chain at 0.30 opacity, 0.05s pre-window, 0.40s post-window. Wired between particles and avatar overlay so face is never washed out.
- `src/services/introStingService.ts` — Animated logo intro sting (T104): `computeIntroState(duration, hasLogo)` returns `{active, largeLogoFadeIn/Out, largeLogoScale, blackoutFadeStart/End, cornerLogoFadeIn, swooshStart/End, swooshWidthFrac}` — active only when `hasLogo === true` AND duration ≥ 4s. `buildLargeLogoFilters(state, logoSrcLabel, ...)` scales the looped logo to `cornerMaxH × 1.6`, applies fade-in (0-0.4s) + fade-out (1.0-1.4s), centers via `overlay=(W-w)/2:(H-h)/2`. `buildBlackoutFilter(state, blackoutIdx, ...)` overlays a full-frame black layer with `format=yuva420p,fade=t=out:alpha=1` ramping 1→0 over 1.3-1.6s. `buildSwooshFilter(state, swooshIdx, ...)` overlays a 30%-width brand-accent strip with per-frame `x` expression sweeping `-stripW`→`outW` over 1.3-1.6s, gated by `enable='between(t\,1.3\,1.6)'`. `buildCornerLogoFadeIn(state, ...)` adds `fade=t=in:alpha=1` to the existing logo pill chip in 1.3-1.6s. **Critical: `logoSrcLabel` MUST be a looped multi-frame stream** (e.g. `logo_v_b` produced by ffmpegService's loop preprocessor) — passing the raw `[N:v]` index of a still PNG makes `fade=alpha=1` lock to alpha=0 (start of fade-in seen at PTS=0) forever, producing a fully transparent logo. See filter-graph step 7a.
- `src/services/beatDetect.ts` — Beat-synced background pulses (T106): `detectBeats(audioPath, opts)` runs the music through a one-pass `ffmpeg -af "aresample=48000,aformat=channel_layouts=mono,asetnsamples=n=2048,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-" -f null -` analysis, parses per-window RMS_level from stdout, applies an adaptive threshold (median + 4 dB), picks local maxima, applies a 0.35s min-gap (≈170 BPM ceiling), tiles beats across `videoDurationSec` to handle music's `-stream_loop -1`, and caps at 64 beats. Returns `{beats, medianRmsDb, thresholdDbUsed, windowsAnalyzed, approxBpm, musicDurationSec}`. **Never throws** — returns `EMPTY` (beats=[]) on any failure (missing file, decode error, no clear peaks). `buildBeatPulseFilter(beats, inLabel, outLabel, opts)` builds `[in]eq=brightness=0.05:enable='between(t\,a1\,b1)+between(t\,a2\,b2)+...'[out]` with **escaped commas** inside `between()` (same gotcha as T102/T104 — escape only applies inside FFmpeg `enable=` filter-graph expressions). When `beats=[]`, returns a single `[in]null[out]` pass-through so callers can always push the result without branching. Defaults: brightnessDelta=0.05 (subtle 5%), preWindowSec=0.02, postWindowSec=0.10. NOTE: the very first beat at t=0 is unreachable due to the local-max edge condition (no preceding window) — irrelevant in production because the T104 intro sting blackout covers t=0-1.6s anyway, and `ffmpegService` filters out beats that fall inside the intro/outro windows before passing them to the filter builder.
- `src/services/outroCardService.ts` — Outro CTA card (T105): `parseCtaText()` splits "Visit X.com" / "Follow @x" patterns into headline + url. `computeOutroState(duration, cta)` returns `{active, startSec, fadeDur, headline, url}` — active only when `cta` is non-empty AND duration ≥ 6s; startSec = `max(duration - 2.5, duration * 0.6)`. `generateOutroCardAss()` builds an ASS file with three styles (OutroBg, OutroHead, OutroUrl), a vector rectangle (`\p1...\p0`) for the card BG filled with brand accent, and `\move` + `\fad` slide-up animations on the headline (white bold + dark outline + shadow) and URL (white smaller). Landscape: card 65%×36% centered. Vertical: 85%×32%. **ASS gotcha:** commas inside `{...}` override blocks (e.g., `\pos(x,y)`, `\move(x1,y1,x2,y2,t1,t2)`) must be PLAIN commas — `\,` escape ONLY applies inside FFmpeg `enable=` expressions at the filter-graph level. When `outroState.active`, `ffmpegService` skips the legacy lower-third CTA generation (mutually exclusive) and the avatar overlay path takes the split + double-overlay dim path described in step 4 above.
- `src/routes/voices.ts` — `GET /api/voices` (Azure, 1hr cache), `GET /api/elevenlabs/voices` (ElevenLabs, x-elevenlabs-key header), `POST /api/elevenlabs/preview`, `POST /api/upload-photo`
- `src/routes/generate.ts` — `POST /api/generate` (SSE), `GET /api/video/:filename`, `POST /api/preview-voice`

### FFmpeg Filter Graph (order, Realism Mode)

1. Background source, oversized 3% (`gradients` or `color`)
2. Ken Burns crop pan on background → `[bg_pre]`
3a. Ambient particles (T101) — drifting bokeh in safe zones, screen-blended via gbrp → `[bg_par]`
3b. Light-leak transitions (T102) — warm radial blooms at sentence boundaries, screen-blended → `[bg]` (or `[bg_leaked]` when T106 beats are present)
3c. Beat-synced bg brightness pulses (T106, only when music exists AND beats detected) — `eq=brightness=0.05:enable='between(t\,a1\,b1)+...'` over `[bg_leaked]` → `[bg]`. Beats inside the T104 intro window (0-1.6s) and T105 outro window are filtered out before this stage. When skipped, step 3b emits `[bg]` directly and this stage is omitted entirely. Pulse pre/post window: 0.02s/0.10s. Background-only — avatar (overlaid in step 4) never pulses.
4. Avatar compositing — **active path** (tuned Apr 30 2026 for JPEG-compressed Azure source): `format=yuva420p,chromakey=0x00ff00:similarity=0.20:blend=0.12` → `despill=type=green:mix=0.4` → `gblur=sigma=1.5:steps=1:planes=8` (alpha-only blur) → `scale` → `overlay :format=auto`. Tighter similarity prevents holes in light fabric; alpha-plane blur smooths blocky stair-stepping at silhouette edges. Transparent-WebM branch (`format=yuva420p` → `scale` → `overlay …:format=auto`) exists in code for future Azure API versions but is currently disabled — see Known Azure Limitations. **Outro dimming (T105):** when `outroState.active`, the avatar is split into two streams that overlay sequentially onto the bg — `av_a` (full opacity, `fade=t=out:alpha=1` at startSec/fadeDur) and `av_b` (alpha-mixed to 0.3 via `colorchannelmixer=aa=0.3`, `fade=t=in:alpha=1`). The two overlays compose into a smooth 100%→30% opacity ramp without per-pixel `geq` cost.
5. Color grade (`eq`) + sharpen (`unsharp`) + vignette
6. Lower-third dark overlay (2-layer `drawbox`)
7. Brand accent line (`drawbox`)
7a. Logo loop preprocessor (T104, only when `introState.active`) — the logo input is a single still PNG with PTS=0. `fade=alpha=1` evaluates per source-frame PTS, so on a still it sees only the start-of-fade frame (alpha=0) and produces a transparent logo forever. Fix: `[logoIdx:v]loop=loop=-1:size=1:start=0,settb=AVTB,setpts=N/30/TB,fps=30,format=rgba,split=2[logo_v_a][logo_v_b]`. `[logo_v_a]` feeds the corner-pill chain (corner-fade-in 1.3-1.6s); `[logo_v_b]` feeds the centered large logo (fade-in 0-0.4s, fade-out 1.0-1.4s). When intro is INACTIVE, the corner logo uses `[logoIdx:v]` directly (no fade, overlay handles still PNG natively).
8. Logo overlay (top-right) — corner pill chip with optional T104 fade-in
9. Opening hook text (0–2s ASS subtitle)
10. 3-word animated captions (`subtitles`)
11. Numeric pop-in callouts (T103) — ASS subtitle with pop scale animation
12. CTA text (`subtitles`) — **suppressed when outro card is active** (mutually exclusive with step 12b)
12b. Outro CTA card (T105) — full-screen branded card in the last 2.5s when `outroState.active`. Vector ASS rectangle (`\p1`) filled with brand accent + headline + URL using `\move` slide-up + `\fad`. Avatar already dimmed to 30% in step 4.
12c. Intro sting overlays (T104, only when `introState.active`) — applied AFTER all earlier overlays so the blackout covers the entire built-up scene including the corner logo. Order: blackout (full opacity 0-1.3s, fades to 0 by 1.6s) → centered large logo (fade in 0-0.4s, hold, fade out 1.0-1.4s, sized as `cornerMaxH × 1.6`) → swoosh strip (brand-accent vertical bar 30% wide, sweeps left→right at 1.3-1.6s via overlay's per-frame `x` expression with escaped commas in `enable=`).
13. Film grain (`noise`)
14. Fade in/out
15. FPS normalize to 30fps

### Available FFmpeg Filters (confirmed in ffmpeg-static 5.3.0)

`gradients`, `chromakey`, `drawbox` (alpha, but no `eval=frame` in 6.1.x), `drawtext` (per-frame x/y supported, used for ambient particles), `subtitles` (libass), `vignette`, `unsharp`, `fade`, `overlay`, `blend` (with `enable=`, requires `format=gbrp` for clean screen mode), `gblur`, `tpad`, `format`, `scale`, `pad`, `fps`, `eq`, `noise`, `loudnorm`, `aecho`, `zoompan`, `crop`, `color`, `setsar`

### Azure Avatar API

- Endpoint: `https://{AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/avatar/batchsyntheses/{jobId}?api-version=2024-04-15-preview`
- Method: PUT to create, GET to poll
- Body is **flat** (no `payload` wrapper).
- `inputKind: "SSML"` is the only mode used. Azure removed `PreSynthesizedAudio` support from the avatar batch synthesis API in 2025 (returns `400 BadRequest: $.inputKind invalid + payload required`). To use ElevenLabs voices, generate the avatar with Azure TTS here, then swap the audio track in `ffmpegService.ts` via `elAudioPath`.
- **Background modes** (current production routing — see `PREFER_TRANSPARENT_WEBM` in `routes/generate.ts`):
  - `realism=true` + no `bgImageUrl` → mp4/h264 + `backgroundColor:"#00FF00FF"` (green screen, chroma keyed in post)
  - `bgImageUrl` set → mp4/h264, Azure composites the background image server-side
  - Transparent webm/vp9 path is implemented in `avatarService.ts` (`useTransparent` flag) but disabled because Azure ignores `backgroundColor:"transparent"` — see Known Azure Limitations below
- Poll interval: 6s, max wait: 25min

### Known Azure Limitations

#### Avatar batch synthesis ignores `backgroundColor:"transparent"` (verified Apr 30 2026)

**Test setup**: Submitted a real avatar synthesis job with
`videoFormat:"webm"`, `videoCodec:"vp9"`, `backgroundColor:"transparent"`
against `https://{region}.api.cognitive.microsoft.com/avatar/batchsyntheses/{jobId}?api-version=2024-04-15-preview`.

**Result**: Job succeeded. Downloaded `avatar_raw.webm` (26 MB).

```text
ffprobe -v error -show_streams avatar_raw.webm
  → codec_name=vp9        ✓ codec request honoured
  → codec_name=opus       ✓ audio
  → pix_fmt=yuv420p       ✗ NO alpha plane (would be yuva420p)

Corner pixel sample (all four corners): #FFFFFF (pure white)
```

**Conclusion**: Azure honours the container/codec parts of the request but
silently substitutes **white** for `backgroundColor:"transparent"`. The
returned WebM is fully opaque — overlaying it with `format=yuva420p` +
`overlay=…:format=auto` produces a visible white rectangle on top of the
cinematic background.

**Resolution**: `PREFER_TRANSPARENT_WEBM = false` in `routes/generate.ts`.
The legacy mp4 + green-screen (`#00FF00FF`) + chroma key path is the only
working option for compositing the avatar onto a custom background.

**Code state after revert**:
- `routes/generate.ts` line 230: `const PREFER_TRANSPARENT_WEBM = false;`
- `avatarService.ts`: still supports the `useTransparent` flag — flips the
  request body to webm/vp9/transparent — but generate.ts no longer sets it.
  Kept in code so future Azure API revisions can be re-tested by flipping
  the single constant back to `true`.
- `ffmpegService.ts`: chroma path verified intact —
  `chromakey=color=0x00ff00:similarity=0.30:blend=0.10` +
  `despill=type=green:mix=0.5:expand=0`. Transparent overlay branch
  (`useTransparentAvatar`) also kept for the same future-test reason.

**Re-test recipe**: If a future Azure API version (e.g. `2025-…`) is
released, change the api-version string in `avatarService.ts`, flip
`PREFER_TRANSPARENT_WEBM = true`, generate one video, then run:

```bash
ffprobe -v error -show_streams artifacts/api-server/outputs/avatar_raw.webm \
  | grep -E "^(codec_name|pix_fmt)="
```

Confirmed-working signature is `codec_name=vp9` + `pix_fmt=yuva420p`. Anything
else → flip back to false, document the new failure below this entry.

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
