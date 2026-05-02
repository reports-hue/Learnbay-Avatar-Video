import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import pinoHttp from "pino-http";
import { createProxyMiddleware } from "http-proxy-middleware";
import router from "./routes/index.js";
import { requireAuth } from "./routes/auth.js";
import { logger } from "./lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, "../assets");

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api/assets", express.static(assetsDir));
app.use("/api/assets", (_req, res) => {
  res.status(404).json({ error: "Asset not found" });
});
// Auth gate — applied to /api before the main router. Internally allows
// /api/auth/* and /api/healthz through unauthenticated; everything else
// (generate, brand, voices, future routes) requires a valid Bearer token.
app.use("/api", requireAuth);
app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  // Serve the pre-built React frontend that build.mjs copies into our own
  // dist folder (`dist/public`). We can't reach into the sibling
  // `artifacts/video-generator/dist/public` because Cloud Run only ships the
  // api-server's artifact directory.
  const frontendDist = path.resolve(__dirname, "./public");
  app.use("/", express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
} else {
  // Dev: proxy live Vite dev server
  const viteFrontendPort = process.env.VITE_FRONTEND_PORT ?? "24396";
  app.use(
    "/",
    createProxyMiddleware({
      target: `http://localhost:${viteFrontendPort}`,
      changeOrigin: true,
      ws: true,
      logger: console,
    }),
  );
}

export default app;
