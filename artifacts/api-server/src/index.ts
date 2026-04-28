import app from "./app.js";
import { logger } from "./lib/logger.js";
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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
