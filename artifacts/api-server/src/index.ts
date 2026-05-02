import app from "./app.js";
import { logger } from "./lib/logger.js";
import * as jobStore from "./lib/jobStore.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ensureDirs() {
  const dirs = ["outputs", "assets", "public"].map((d) =>
    path.resolve(__dirname, `../${d}`)
  );
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await ensureDirs();

// Sweep zombie jobs left running by a previous process that crashed mid-render.
// Anything still pending/running and older than 60 minutes gets marked failed
// so polling clients receive a definitive answer instead of hanging forever.
try {
  jobStore.sweepStuck(60 * 60 * 1000);
} catch (err) {
  logger.warn(
    { err: (err as Error).message },
    "jobStore.sweepStuck failed at startup",
  );
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
