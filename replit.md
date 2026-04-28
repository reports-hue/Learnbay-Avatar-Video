# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Libraryminds Personal Video Generator

A personal, no-auth video generation tool accessible at the root `/`.

### Features
- AI script generation via Azure OpenAI
- Voice synthesis via Azure Speech TTS (en-US-AriaNeural)
- SRT subtitle generation
- FFmpeg video processing: avatar overlay, background, logo, captions, music
- Supports vertical (9:16) and horizontal (16:9) platforms

### Service Files
- `artifacts/api-server/src/services/openai.ts` — Azure OpenAI script generation
- `artifacts/api-server/src/services/speech.ts` — Azure Speech TTS voice synthesis
- `artifacts/api-server/src/services/ffmpegService.ts` — FFmpeg video assembly
- `artifacts/api-server/src/utils/srtGenerator.ts` — SRT subtitle file creation
- `artifacts/api-server/src/routes/generate.ts` — POST /api/generate, GET /api/video/:filename
- `artifacts/api-server/public/index.html` — Frontend UI

### Required Assets (place in `artifacts/api-server/assets/`)
- `avatar.mp4` — talking avatar video
- `bg_vertical.mp4` — background for vertical (Shorts/Reels)
- `bg_horizontal.mp4` — background for horizontal (YouTube/Landscape)
- `logo.png` — Libraryminds logo
- `music.mp3` — background music

### Environment Secrets Required
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_DEPLOYMENT` (optional, defaults to `gpt-4o`)
- `AZURE_SPEECH_KEY`
- `AZURE_SPEECH_REGION`

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
