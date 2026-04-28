# ────────────────────────────────────────────────────────────────
# Stage 1 — Install all workspace dependencies
# ────────────────────────────────────────────────────────────────
FROM node:20-slim AS deps

RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests (layer cache — only reinstalls when these change)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy lib packages and artifact package.json files
COPY lib/ ./lib/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/video-generator/package.json ./artifacts/video-generator/

# Install all dependencies (dev included — needed for build)
RUN pnpm install --frozen-lockfile

# ────────────────────────────────────────────────────────────────
# Stage 2 — Build frontend (React + Vite → static files)
# ────────────────────────────────────────────────────────────────
FROM deps AS frontend-build

COPY artifacts/video-generator/ ./artifacts/video-generator/
COPY lib/ ./lib/

# vite.config.ts reads PORT and BASE_PATH at config-load time (even for builds)
ENV PORT=24396
ENV BASE_PATH=/

RUN pnpm --filter @workspace/video-generator run build
# → artifacts/video-generator/dist/public/

# ────────────────────────────────────────────────────────────────
# Stage 3 — Build API server (esbuild bundle → single .mjs)
# ────────────────────────────────────────────────────────────────
FROM deps AS api-build

COPY artifacts/api-server/ ./artifacts/api-server/
COPY lib/ ./lib/

RUN pnpm --filter @workspace/api-server run build
# → artifacts/api-server/dist/index.mjs

# ────────────────────────────────────────────────────────────────
# Stage 4 — Lean production image
# ────────────────────────────────────────────────────────────────
FROM node:20-slim AS production

RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests for production dep install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/ ./lib/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/video-generator/package.json ./artifacts/video-generator/

# Production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built outputs from build stages
COPY --from=api-build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=frontend-build /app/artifacts/video-generator/dist/public ./artifacts/video-generator/dist/public

# Runtime directories — mount a Docker volume over outputs/ for persistence
RUN mkdir -p \
    artifacts/api-server/outputs \
    artifacts/api-server/assets \
    artifacts/api-server/public \
    logs

EXPOSE 8080

# Health check — uses the /api/healthz endpoint defined in health.ts
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/api/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
