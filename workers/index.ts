/**
 * Background worker process.
 *   npm run worker
 *
 * Consumes:
 *   - cv-processing : parses CVs (concurrency + LLM rate limit configurable)
 *   - drive-sync    : scheduled + on-demand Google Drive synchronisation
 *
 * Publishes a Redis heartbeat so the web UI can tell "no worker running" apart
 * from "still queued", and preflights the LLM credentials at startup so a bad
 * key is reported once, loudly, instead of failing every CV individually.
 */
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { env } from "@/lib/config";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import { createRedisConnection } from "@/lib/redis";
import { getSettings } from "@/lib/settings";
import { errorMessage } from "@/lib/errors";
import { writeHeartbeat, clearHeartbeat, HEARTBEAT_INTERVAL_MS } from "@/lib/worker-health";
import { CV_QUEUE_NAME, DRIVE_SYNC_QUEUE_NAME, getDriveSyncQueue, type CVJobData, type DriveSyncJobData } from "@/services/processing/queue";
import { processCVJob } from "@/services/processing/processor";
import { verifyLLMCredentials } from "@/services/llm";
import { syncConnection, syncAllConnections } from "@/services/google-drive/sync";
import { shutdownOCR } from "@/services/ocr";

const DRIVE_SCHEDULER_ID = "drive-sync-poll";
const WORKER_ID = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Local storage resolves relative to the process working directory, so a worker
 * started from a different folder than the web server would not find uploads.
 * Fail fast with a clear message rather than failing every job later.
 */
async function checkStorage(log: typeof logger) {
  const e = env();
  if (e.STORAGE_DRIVER !== "local") return;
  const dir = path.resolve(e.LOCAL_STORAGE_PATH);
  await fs.mkdir(dir, { recursive: true });
  log.info({ storageDriver: "local", path: dir, cwd: process.cwd() }, "Local storage ready");
  const cvsDir = path.join(dir, "cvs");
  const exists = await fs
    .access(cvsDir)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    log.warn(
      { path: cvsDir },
      "No uploads/cvs directory found under the resolved storage path. If the web server runs from a different folder, start the worker from the same project root (or set an absolute LOCAL_STORAGE_PATH), otherwise manual uploads will fail with ENOENT.",
    );
  }
}

async function main() {
  const e = env();
  const settings = await getSettings();
  const log = logger.child({ component: "worker", workerId: WORKER_ID });

  log.info(
    { concurrency: settings.workerConcurrency, llmRateLimitPerMinute: settings.llmRateLimitPerMinute, provider: e.LLM_PROVIDER, model: settings.llmModel, cwd: process.cwd() },
    "Starting CV worker",
  );

  await checkStorage(log);

  // ── LLM preflight ─────────────────────────────────────────────────────────
  let llmError: string | null = null;
  const check = await verifyLLMCredentials();
  if (check.ok) {
    log.info({ provider: check.provider, model: check.model }, "LLM credentials verified");
  } else {
    llmError = check.error;
    log.error({ provider: check.provider, model: check.model }, `LLM PREFLIGHT FAILED: ${check.error}`);
    console.error(
      [
        "",
        "  ┌──────────────────────────────────────────────────────────────────────┐",
        "  │  LLM is not usable – every CV will fail until this is fixed.        │",
        "  └──────────────────────────────────────────────────────────────────────┘",
        `  ${check.error}`,
        "",
        "  Fix .env, restart this worker, then click 'Retry all failed' in the UI.",
        "",
      ].join("\n"),
    );
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const startedAt = new Date().toISOString();
  const beat = async () => {
    try {
      await writeHeartbeat({
        id: WORKER_ID,
        pid: process.pid,
        host: os.hostname(),
        startedAt,
        concurrency: settings.workerConcurrency,
        llm: { provider: e.LLM_PROVIDER, model: settings.llmModel, keyConfigured: Boolean(e.LLM_API_KEY), lastError: llmError },
      });
    } catch (err) {
      log.warn({ err: errorMessage(err) }, "heartbeat write failed");
    }
  };
  await beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // ── CV processing ─────────────────────────────────────────────────────────
  const cvWorker = new Worker<CVJobData>(
    CV_QUEUE_NAME,
    async (job: Job<CVJobData>) => {
      await processCVJob(job.data, job.attemptsMade + 1, job.opts.attempts ?? settings.maxRetries);
    },
    {
      connection: createRedisConnection(),
      concurrency: settings.workerConcurrency,
      // Global rate limit protects the LLM API across all concurrent jobs.
      limiter: { max: settings.llmRateLimitPerMinute, duration: 60_000 },
      lockDuration: 5 * 60_000, // OCR of multi-page scans can take a while
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  cvWorker.on("completed", (job) => log.debug({ jobId: job.id }, "job completed"));
  cvWorker.on("failed", (job, err) => {
    const message = errorMessage(err);
    // Keep the heartbeat's LLM status current so the UI banner reflects reality.
    if (/API key|LLM_API_KEY|401|403/i.test(message) && /llm/i.test(message)) llmError = message;
    log.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: message }, "job failed");
  });
  cvWorker.on("error", (err) => log.error({ err: errorMessage(err) }, "worker error"));
  cvWorker.on("ready", () => log.info({ queue: CV_QUEUE_NAME, concurrency: settings.workerConcurrency }, "Listening for CV jobs"));

  // ── Google Drive sync ─────────────────────────────────────────────────────
  const driveWorker = new Worker<DriveSyncJobData>(
    DRIVE_SYNC_QUEUE_NAME,
    async (job: Job<DriveSyncJobData>) => {
      const { connectionId, reason, batchId } = job.data;
      if (connectionId) {
        return syncConnection(connectionId, { full: reason === "manual" || reason === "folder-changed", batchId });
      }
      return syncAllConnections(reason);
    },
    { connection: createRedisConnection(), concurrency: 1, lockDuration: 10 * 60_000 },
  );
  driveWorker.on("failed", (job, err) => log.warn({ jobId: job?.id, err: errorMessage(err) }, "drive sync failed"));

  // Repeatable polling job for new Drive files (interval from settings).
  const intervalMs = Math.max(1, settings.driveSyncIntervalMinutes) * 60_000;
  await getDriveSyncQueue().upsertJobScheduler(DRIVE_SCHEDULER_ID, { every: intervalMs }, {
    name: "poll",
    data: { reason: "scheduled" },
  });
  log.info({ everyMinutes: settings.driveSyncIntervalMinutes }, "Drive polling scheduler registered");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down worker");
    clearInterval(heartbeatTimer);
    await clearHeartbeat(WORKER_ID);
    await Promise.allSettled([cvWorker.close(), driveWorker.close()]);
    await shutdownOCR().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: errorMessage(err) }, "Worker failed to start");
  process.exit(1);
});
