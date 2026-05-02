/**
 * Persistent SQLite-backed job store.
 *
 * Replaces the in-memory `Map<string, JobState>` that previously held all
 * generation job state in `routes/generate.ts`. The Map vanished on every
 * server restart, leaving in-flight polling clients hanging forever and
 * losing completed-but-not-yet-fetched results.
 *
 * Design contract (matches the old Map shape exactly):
 *   - get(id)      → JobState | undefined
 *   - set(id, s)   → void
 *   - update(id,p) → void   (shallow patch over existing record)
 *   - delete(id)   → void
 *   - listDone()   → { jobId: string; ...result }[]
 *   - sweepStuck() → number (count of zombie jobs marked failed)
 *   - cleanup(ms)  → number (count deleted older than cutoff)
 *
 * Storage:
 *   - SQLite file at `outputs/jobs.sqlite`
 *   - Single `jobs` table with `(id PK, state JSON, status, created_at)`
 *   - `status` and `created_at` are denormalised columns (also inside `state`)
 *     so list/sweep queries don't need to parse every row.
 *
 * Safety:
 *   - All writes wrapped in prepared statements (no SQL injection surface).
 *   - State is JSON.stringify'd; corrupt rows are silently skipped on read.
 *   - Schema is created idempotently on first open. Adding new columns later
 *     requires a migration; for now the schema is intentionally minimal.
 *   - Native module: better-sqlite3 is in the esbuild externals list, so the
 *     bundled output uses the prebuilt addon at runtime.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { logger } from "./logger.js";

// ─── Types (mirrors the old in-memory shape) ───────────────────────
export interface JobResult {
  videoId: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  script: string;
  brandTheme: { bgColor1: string; bgColor2: string; accentColor: string };
  cta?: string;
}

export interface JobState {
  status: "pending" | "running" | "done" | "failed";
  step: string;
  percent: number;
  message: string;
  script?: string;
  result?: JobResult;
  error?: string;
  createdAt: number;
}

// ─── DB bootstrap ──────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// outputs/ lives one level up from dist/ at runtime and from src/ in dev.
// Both `lib/` and `routes/` resolve outputs the same way (`../outputs`).
const outputsDir = path.resolve(__dirname, "../outputs");
mkdirSync(outputsDir, { recursive: true });

const dbPath = path.join(outputsDir, "jobs.sqlite");
const db = new Database(dbPath);

// WAL mode: better concurrency, survives crashes cleanly.
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    state       TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at  ON jobs(created_at);
`);

// ─── Prepared statements ───────────────────────────────────────────
const stmtGet = db.prepare<[string], { state: string }>(
  "SELECT state FROM jobs WHERE id = ?"
);
const stmtUpsert = db.prepare(
  "INSERT INTO jobs (id, state, status, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET state = excluded.state, status = excluded.status"
);
const stmtDelete = db.prepare("DELETE FROM jobs WHERE id = ?");
const stmtListDone = db.prepare<[], { id: string; state: string }>(
  "SELECT id, state FROM jobs WHERE status = 'done' ORDER BY created_at DESC"
);
const stmtListStuck = db.prepare<[number], { id: string; state: string }>(
  "SELECT id, state FROM jobs WHERE status IN ('pending','running') AND created_at < ?"
);
const stmtCleanupOld = db.prepare<[number]>(
  "DELETE FROM jobs WHERE created_at < ?"
);

// ─── Public API ─────────────────────────────────────────────────────

/** Look up a job by id. Returns undefined when not found or row is corrupt. */
export function get(jobId: string): JobState | undefined {
  if (!jobId) return undefined;
  const row = stmtGet.get(jobId);
  if (!row) return undefined;
  try {
    return JSON.parse(row.state) as JobState;
  } catch (err) {
    logger.warn(
      { jobId, err: (err as Error).message?.slice(0, 200) },
      "jobStore.get: corrupt JSON, treating as missing"
    );
    return undefined;
  }
}

/** Insert or fully replace a job's state. */
export function set(jobId: string, state: JobState): void {
  stmtUpsert.run(jobId, JSON.stringify(state), state.status, state.createdAt);
}

/** Shallow-merge `patch` into the existing state. No-op when job missing. */
export function update(jobId: string, patch: Partial<JobState>): void {
  const existing = get(jobId);
  if (!existing) return;
  const next: JobState = { ...existing, ...patch };
  stmtUpsert.run(jobId, JSON.stringify(next), next.status, next.createdAt);
}

/** Remove a job permanently. */
export function remove(jobId: string): void {
  stmtDelete.run(jobId);
}

/** List all completed jobs flattened to `{ jobId, ...result }`. */
export function listDone(): Array<{ jobId: string } & JobResult> {
  const rows = stmtListDone.all();
  const out: Array<{ jobId: string } & JobResult> = [];
  for (const row of rows) {
    try {
      const state = JSON.parse(row.state) as JobState;
      if (state.result) out.push({ jobId: row.id, ...state.result });
    } catch {
      // skip corrupt row
    }
  }
  return out;
}

/**
 * Mark any pending/running jobs older than `staleAfterMs` as failed. Run this
 * once at server startup — the only way a job ends up in pending/running on
 * boot is if a prior process crashed mid-render. Returns count swept.
 */
export function sweepStuck(staleAfterMs: number = 60 * 60 * 1000): number {
  const cutoff = Date.now() - staleAfterMs;
  const stuck = stmtListStuck.all(cutoff);
  let n = 0;
  for (const row of stuck) {
    try {
      const state = JSON.parse(row.state) as JobState;
      const next: JobState = {
        ...state,
        status: "failed",
        error: "Server restarted while job was in progress.",
      };
      stmtUpsert.run(row.id, JSON.stringify(next), next.status, next.createdAt);
      n += 1;
    } catch {
      // remove unreadable rows so they don't block the next sweep
      stmtDelete.run(row.id);
    }
  }
  if (n > 0) {
    logger.warn({ swept: n }, "jobStore.sweepStuck: marked zombie jobs as failed");
  }
  return n;
}

/** Delete jobs older than `maxAgeMs`. Returns count deleted. */
export function cleanup(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const info = stmtCleanupOld.run(cutoff);
  return info.changes;
}

/** Test/diagnostic only — total row count. */
export function count(): number {
  const row = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM jobs").get();
  return row?.c ?? 0;
}
